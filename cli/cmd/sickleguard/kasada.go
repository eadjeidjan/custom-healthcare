package main

// Shared front proxy on the Kasada server (same pattern as eCourier): CustoCare's kasada-edge Caddy holds 80/443
// and the certificates. SickleGuard's web container joins its docker network (deploy/shared-edge.yml) as
// sickleguard-<instance>-web, and the CLI writes ONE file, sickleguard.caddy, into kasada-edge's extra-sites folder,
// then validates and reloads that Caddy. Nothing else of kasada's is read or changed.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"sickleguard/cli/internal/envfile"
	"sickleguard/cli/internal/evlog"
	"sickleguard/cli/internal/instance"
	"sickleguard/cli/internal/ui"
)

const (
	kasadaExtraMount = "/etc/kasada-edge/extra"
	sharedFile       = "sickleguard.caddy"
)

func kasadaContainer() string {
	if c := os.Getenv("SICKLEGUARD_KASADA_EDGE_CONTAINER"); c != "" {
		return c
	}
	return "kasada-edge-proxy-1"
}

// KasadaEdge describes kasada-edge on this host.
type KasadaEdge struct {
	Container string
	Running   bool
	Extra     string // host folder mounted at /etc/kasada-edge/extra ("" when missing)
}

var kasadaCache *KasadaEdge
var kasadaLooked bool

// kasadaEdge returns kasada-edge's details, or nil when that container does not exist here.
func kasadaEdge() *KasadaEdge {
	if kasadaLooked {
		return kasadaCache
	}
	kasadaLooked = true
	name := kasadaContainer()
	out, err := exec.Command("docker", "inspect", name).Output()
	if err != nil {
		return nil
	}
	var list []struct {
		State struct {
			Running bool `json:"Running"`
		} `json:"State"`
		Mounts []struct {
			Source      string `json:"Source"`
			Destination string `json:"Destination"`
		} `json:"Mounts"`
	}
	if json.Unmarshal(out, &list) != nil || len(list) == 0 {
		return nil
	}
	k := &KasadaEdge{Container: name, Running: list[0].State.Running}
	for _, m := range list[0].Mounts {
		if m.Destination == kasadaExtraMount {
			k.Extra = m.Source
		}
	}
	kasadaCache = k
	return k
}

// usable explains why the shared proxy cannot be used yet (nil when it can).
func (k *KasadaEdge) usable() error {
	if k.Extra == "" {
		return fmt.Errorf("%s has no extra-sites folder: in /opt/kasada/CustoCareAI run `kasada update --apply`, then run this again. Nothing of kasada's was changed", k.Container)
	}
	if !k.Running {
		return fmt.Errorf("%s is not running: in /opt/kasada/CustoCareAI run `kasada edge up`", k.Container)
	}
	return nil
}

// renderShared is sickleguard.caddy: one site block per installed instance with a DOMAIN.
func renderShared(root string) string {
	var blocks []string
	for _, name := range instance.List(root) {
		f, err := envfile.Load(filepath.Join(root, "deploy", name+".env"))
		if err != nil {
			continue
		}
		if mode := strings.ToLower(f.Value("EDGE_MODE")); mode == edgeOwn || mode == edgeExternal {
			continue
		}
		domain := strings.TrimSpace(f.Value("DOMAIN"))
		if domain == "" {
			continue
		}
		tls := ""
		if e := strings.TrimSpace(f.Value("ACME_EMAIL")); e != "" {
			tls = "\ttls " + e + "\n"
		}
		inst := instance.Instance{Name: name}
		blocks = append(blocks, fmt.Sprintf("# instance %s\n%s {\n\timport edge\n%s\treverse_proxy %s:80 {\n\t\tflush_interval -1\n\t}\n}\n",
			name, domain, tls, inst.WebAlias()))
	}
	if len(blocks) == 0 {
		return ""
	}
	return "# SickleGuard on this server's shared front proxy (CustoCare's kasada-edge). Written by the sickleguard CLI\n" +
		"# on deploy, update and `edge sync`; kasada never edits it. HTTPS ends in kasada-edge. flush_interval -1 lets the\n" +
		"# assistant's answers stream (Server-Sent Events).\n\n" + strings.Join(blocks, "\n")
}

// putFile writes atomically (".sickleguard.caddy.tmp" is not *.caddy, so Caddy never reads a half-written file),
// or removes the file when body is nil.
func putFile(path string, body *string) error {
	if body == nil {
		err := os.Remove(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".tmp")
	if err := os.WriteFile(tmp, []byte(*body), 0o644); err != nil {
		return err
	}
	_ = os.Chmod(tmp, 0o644)
	return os.Rename(tmp, path)
}

func kasadaCaddy(k *KasadaEdge, step string) (string, error) {
	out, err := exec.Command("docker", "exec", k.Container, "caddy", step, "--config", "/etc/caddy/Caddyfile",
		"--adapter", "caddyfile").CombinedOutput()
	return string(out), err
}

// syncKasada writes sickleguard.caddy (previous kept as deploy/edge/sickleguard.caddy.bak), validates and reloads
// kasada-edge. A failure puts the previous file back. No-op when kasada-edge is not on this host.
func (a *App) syncKasada() error {
	k := kasadaEdge()
	if k == nil || a.edgeModeSetting() == edgeOwn || a.edgeModeSetting() == edgeExternal {
		return nil
	}
	if err := k.usable(); err != nil {
		return err
	}
	target := filepath.Join(k.Extra, sharedFile)
	var old *string
	if b, err := os.ReadFile(target); err == nil {
		s := string(b)
		old = &s
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read %s: %w", target, err)
	}
	var newBody *string
	if s := renderShared(a.Root); s != "" {
		newBody = &s
	}
	if (old == nil && newBody == nil) || (old != nil && newBody != nil && *old == *newBody) {
		ui.OK("front proxy: %s unchanged", target)
		return nil
	}
	if old != nil {
		bak := filepath.Join(a.Root, "deploy", "edge", sharedFile+".bak")
		_ = os.MkdirAll(filepath.Dir(bak), 0o755)
		if err := os.WriteFile(bak, []byte(*old), 0o644); err != nil {
			return err
		}
	}
	if err := putFile(target, newBody); err != nil {
		return fmt.Errorf("write %s: %w", target, err)
	}
	for _, step := range []string{"validate", "reload"} {
		if out, err := kasadaCaddy(k, step); err != nil {
			_ = putFile(target, old)
			if step == "reload" { // the previous configuration is valid: load it again
				_, _ = kasadaCaddy(k, "reload")
			}
			a.Log.Event(evlog.Fail, "kasada-edge %s failed; previous %s put back", step, sharedFile)
			return fmt.Errorf("kasada-edge %s failed, so the previous file was put back:\n%s", step, tailStr(out, 800))
		}
	}
	verb := "wrote"
	if newBody == nil {
		verb = "removed (no instance with a DOMAIN)"
	}
	a.Log.Event(evlog.OK, "front proxy: %s %s, validated and reloaded %s", verb, target, k.Container)
	ui.OK("front proxy: %s %s, validated and reloaded %s", verb, target, k.Container)
	return nil
}

func tailStr(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return "…" + s[len(s)-n:]
	}
	return s
}
