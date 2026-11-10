package main

import (
	"fmt"
	"net/http"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"sickleguard/cli/internal/evlog"
	"sickleguard/cli/internal/instance"
	"sickleguard/cli/internal/stack"
	"sickleguard/cli/internal/ui"
)

type tally struct{ ok, warn, fail int }

func (t *tally) OK(f string, a ...any)   { t.ok++; ui.OK(f, a...) }
func (t *tally) Warn(f string, a ...any) { t.warn++; ui.Warn(f, a...) }
func (t *tally) Fail(f string, a ...any) { t.fail++; ui.Fail(f, a...) }

// openAIKeyStatus lists models (cheap, no tokens) with a 5 s timeout. The key is never printed.
func openAIKeyStatus(key string) (bool, string) {
	req, _ := http.NewRequest("GET", "https://api.openai.com/v1/models?limit=1", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	c := &http.Client{Timeout: 5 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return false, "OpenAI not reachable (" + shortErr(err) + ")"
	}
	resp.Body.Close()
	switch {
	case resp.StatusCode == 200:
		return true, "OpenAI key works"
	case resp.StatusCode == 401:
		return false, "OpenAI rejected the key (401): set a new one with `env set OPENAI_API_KEY`"
	case resp.StatusCode == 429:
		return true, "OpenAI key accepted but rate-limited or out of credit (429)"
	default:
		return false, fmt.Sprintf("OpenAI answered HTTP %d", resp.StatusCode)
	}
}

func checkCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "check",
		Aliases: []string{"doctor"},
		Short:   "Check the host and the instance: docker, resources, ports, settings, DNS, TLS, OpenAI, containers",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			var t tally
			ui.Step("Host")
			if v, err := stack.Docker("version", "--format", "{{.Server.Version}}"); err != nil {
				t.Fail("Docker engine not reachable: %v", shortErr(err))
			} else {
				t.OK("Docker %s", v)
			}
			if v, err := stack.Docker("compose", "version", "--short"); err != nil {
				t.Fail("Docker Compose v2 plugin missing")
			} else if maj, min := semver2(v); maj < 2 || (maj == 2 && min < 20) {
				t.Warn("Docker Compose %s: 2.20 or newer is needed for `up --wait`", v)
			} else {
				t.OK("Docker Compose %s", v)
			}
			var fs syscall.Statfs_t
			if syscall.Statfs(a.Root, &fs) == nil {
				free := int64(fs.Bavail) * int64(fs.Bsize)
				if free < 5<<30 {
					t.Warn("disk: %s free (keep at least 5 GiB for images and backups)", humanBytes(free))
				} else {
					t.OK("disk: %s free", humanBytes(free))
				}
			}
			if v, err := stack.Docker("info", "--format", "{{.MemTotal}} {{.NCPU}}"); err == nil {
				f := strings.Fields(v)
				mem, _ := strconv.ParseInt(f[0], 10, 64)
				msg := fmt.Sprintf("memory for containers: %s, %s CPUs (%s)", humanBytes(mem), f[len(f)-1], runtime.GOOS)
				if mem < 3<<30 {
					t.Warn("%s — 4 GiB or more recommended", msg)
				} else {
					t.OK("%s", msg)
				}
			}

			ui.Step("Settings (%s)", a.Inst.RelEnvPath())
			issues := instance.Validate(a.Inst.Name, a.Env.Map())
			for _, is := range issues {
				if is.Fatal {
					t.Fail("%s", is.Msg)
				} else {
					t.Warn("%s", is.Msg)
				}
			}
			if len(issues) == 0 {
				t.OK("required settings present, JWT_SECRET %d characters, production flags fine", len(a.Env.Value("JWT_SECRET")))
			}

			ui.Step("Ports")
			running := a.running()
			port, _ := strconv.Atoi(a.webPort())
			if _, ok := running["web"]; ok {
				t.OK("web port %d used by this instance", port)
			} else if !portFree(port) {
				t.Fail("web port %d is taken by another program: sickleguard env set WEB_PORT <port>", port)
			} else {
				t.OK("web port %d free", port)
			}
			domain := a.Env.Value("DOMAIN")
			if domain != "" {
				mode, why := a.edgeMode()
				switch mode {
				case edgeKasada:
					if k := kasadaEdge(); k == nil {
						t.Fail("edge: EDGE_MODE=kasada but %s is not on this server", kasadaContainer())
					} else if err := k.usable(); err != nil {
						t.Fail("edge: %v", err)
					} else {
						t.OK("edge: kasada mode (%s); sites file %s", why, filepath.Join(k.Extra, sharedFile))
					}
				case edgeExternal:
					t.Warn("edge: external mode (%s) — add `sickleguard edge snippet` to that proxy", why)
				default:
					if listening(80) || listening(443) {
						if !a.ownEdgeRunning() {
							t.Fail("edge: own mode but ports 80/443 are taken by another program")
							break
						}
					}
					t.OK("edge: own Caddy (%s)", why)
				}
			}

			ui.Step("Network")
			if domain != "" && !strings.Contains(domain, "example.com") {
				if !checkDNS(domain) {
					t.warn++
				} else {
					t.ok++
				}
				if _, ok := running["web"]; ok {
					checkTLS(domain)
				}
			} else {
				ui.Info("no DOMAIN: HTTPS checks skipped (local access only)")
			}
			if key := a.Env.Value("OPENAI_API_KEY"); key == "" {
				t.Warn("no OpenAI key: AI summaries and the assistant are off")
			} else if ok, msg := openAIKeyStatus(key); ok {
				t.OK("%s", msg)
			} else {
				t.Fail("%s", msg)
			}

			ui.Step("Containers (%s)", a.Stack.Project)
			list, _ := a.Stack.PS()
			if len(list) == 0 {
				ui.Info("not deployed yet")
			}
			for _, c := range list {
				switch {
				case c.State != "running":
					t.Fail("%s %s", c.Service, c.State)
				case c.Health != "" && c.Health != "healthy":
					t.Warn("%s %s", c.Service, c.Health)
				default:
					t.OK("%s running%s", c.Service, map[bool]string{true: ", " + c.Health, false: ""}[c.Health != ""])
				}
			}
			if len(list) > 0 {
				if h, err := health(a.localURL()); err != nil {
					t.Fail("API health: %v", err)
				} else {
					t.OK("API healthy (OpenAI %s, Qdrant %s, MCP %s)", onoff(h.OpenAI), onoff(h.Qdrant), onoff(h.MCP))
				}
			}

			fmt.Println()
			summary := fmt.Sprintf("%d ok, %d warnings, %d problems", t.ok, t.warn, t.fail)
			a.Log.Event(map[bool]string{true: evlog.Fail, false: evlog.OK}[t.fail > 0], "check: %s", summary)
			if t.fail > 0 {
				ui.Fail("%s", summary)
				return errQuiet
			}
			ui.OK("%s", summary)
			return nil
		},
	}
}

func semver2(v string) (int, int) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	p := strings.SplitN(v, ".", 3)
	maj, _ := strconv.Atoi(p[0])
	min := 0
	if len(p) > 1 {
		min, _ = strconv.Atoi(strings.TrimLeft(p[1], "v"))
	}
	return maj, min
}

func versionCmd() *cobra.Command {
	return &cobra.Command{
		Use: "version", Short: "Print the CLI version (and the code and image tag of the instance)", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			fmt.Printf("sickleguard %s (commit %s, built %s, %s %s/%s)\n", version, commit, buildDate,
				runtime.Version(), runtime.GOOS, runtime.GOARCH)
			if a, err := load(cmd, false); err == nil {
				sha, dirty := gitInfo(a.Root)
				d := ""
				if dirty {
					d = " + uncommitted changes"
				}
				fmt.Printf("repository %s at %s%s; instance %s runs %s\n", a.Root, sha, d, a.Inst.Name, orNone(a.State.Current))
			}
			return nil
		},
	}
}
