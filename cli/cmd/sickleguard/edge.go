package main

import (
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"sickleguard/cli/internal/evlog"
	"sickleguard/cli/internal/stack"
	"sickleguard/cli/internal/ui"
)

// Edge modes (EDGE_MODE):
//
//	kasada   the Kasada server: CustoCare's kasada-edge Caddy holds 80/443; we join its network and write one file,
//	         sickleguard.caddy, into its extra-sites folder (see kasada.go)
//	own      SickleGuard's own Caddy on 80/443 (project sickleguard-edge, deploy/edge/) — a fresh server
//	external another reverse proxy on this host; `edge snippet` prints a site block for it
//	auto     (default) kasada when kasada-edge exists, else own when 80/443 are free, else external
const (
	edgeAuto     = "auto"
	edgeKasada   = "kasada"
	edgeOwn      = "own"
	edgeExternal = "external"
	edgeProject  = "sickleguard-edge"
)

func listening(port int) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(port)), 800*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func (a *App) edgeStack() stack.Stack {
	return stack.Stack{Project: edgeProject, EnvFile: a.Inst.EnvPath(), Files: []string{a.Inst.EdgeCompose()}}
}

// ownEdgeRunning reports whether our Caddy (project sickleguard-edge) runs.
func (a *App) ownEdgeRunning() bool {
	list, err := a.edgeStack().PS()
	if err != nil {
		return false
	}
	for _, c := range list {
		if c.State == "running" {
			return true
		}
	}
	return false
}

// edgeModeSetting is EDGE_MODE as written (auto when empty or unknown).
func (a *App) edgeModeSetting() string {
	switch m := strings.ToLower(strings.TrimSpace(a.Env.Value("EDGE_MODE"))); m {
	case edgeKasada, edgeOwn, edgeExternal:
		return m
	}
	return edgeAuto
}

// edgeMode resolves EDGE_MODE; why explains the choice.
func (a *App) edgeMode() (mode, why string) {
	if m := a.edgeModeSetting(); m != edgeAuto {
		return m, "EDGE_MODE=" + m
	}
	if k := kasadaEdge(); k != nil {
		return edgeKasada, "auto: " + k.Container + " is on this server"
	}
	if a.ownEdgeRunning() {
		return edgeOwn, "auto: SickleGuard's Caddy (sickleguard-edge) is running"
	}
	if listening(80) || listening(443) {
		return edgeExternal, "auto: ports 80/443 are used by another proxy"
	}
	return edgeOwn, "auto: ports 80/443 are free"
}

// upstreamFor turns --upstream into host:port for the reverse_proxy line:
//
//	host (default)  127.0.0.1:<WEB_PORT>  — Caddy on the host, or in Docker with network_mode: host
//	docker-host     host.docker.internal:<WEB_PORT> — Caddy in a Docker bridge network with
//	                extra_hosts host.docker.internal:host-gateway (WEB_BIND must then be the bridge gateway)
//	bridge          172.17.0.1:<WEB_PORT> — the default docker0 gateway (WEB_BIND=172.17.0.1)
//	<host:port>     anything else, used as given
func (a *App) upstreamFor(mode string) (string, error) {
	port := a.webPort()
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", "host":
		return "127.0.0.1:" + port, nil
	case "docker-host":
		return "host.docker.internal:" + port, nil
	case "bridge":
		return "172.17.0.1:" + port, nil
	}
	if _, _, err := net.SplitHostPort(mode); err != nil {
		return "", fmt.Errorf("--upstream %q: use host, docker-host, bridge or host:port", mode)
	}
	return mode, nil
}

// snippet is the Caddy site block for an existing Caddy.
func (a *App) snippet(upstream string) string {
	domain := a.Env.Value("DOMAIN")
	if domain == "" {
		domain = LiveDomain
	}
	return fmt.Sprintf(`# SickleGuard (%s instance) — add to the existing Caddyfile, then reload Caddy.
%s {
	encode zstd gzip
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
	request_body {
		max_size 25MB
	}
	# The assistant streams answers (Server-Sent Events): pass them through immediately.
	reverse_proxy %s {
		flush_interval -1
	}
}
`, a.Inst.Name, domain, upstream)
}

const snippetNote = `Which upstream? Look at how the existing Caddy container runs:
    docker inspect -f '{{.HostConfig.NetworkMode}}' <caddy-container>
  · "host" (or Caddy not in Docker): --upstream host (127.0.0.1:%[1]s, the default). Nothing else to change.
  · a bridge network: the container's 127.0.0.1 is itself, not the server. Either
      --upstream docker-host  (host.docker.internal:%[1]s; that container needs
                               extra_hosts: ["host.docker.internal:host-gateway"]), or
      --upstream bridge       (172.17.0.1:%[1]s, the docker0 gateway: docker network inspect bridge),
    and make the web port listen there: sickleguard env set WEB_BIND <gateway IP>, then deploy --no-build
    (keep the firewall closed for that port from outside).
  · DNS: an A record for %[2]s → this server's public IP. Check with: sickleguard check`

func edgeCmd() *cobra.Command {
	c := &cobra.Command{Use: "edge", Short: "HTTPS in front of the instance: kasada-edge (Kasada server), our own Caddy, or another proxy"}
	c.AddCommand(&cobra.Command{
		Use:   "up",
		Short: "Set up HTTPS for DOMAIN: kasada mode writes sickleguard.caddy; own mode starts our Caddy",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			domain := a.Env.Value("DOMAIN")
			if domain == "" {
				return fmt.Errorf("DOMAIN is empty: sickleguard --instance %s env set DOMAIN", a.Inst.Name)
			}
			mode, why := a.edgeMode()
			ui.Step("Edge for %s: %s mode (%s)", domain, mode, why)
			switch mode {
			case edgeKasada:
				if _, ok := a.running()["web"]; !ok {
					ui.Warn("the web container is not running: `sickleguard --instance %s deploy` joins it to kasada-edge", a.Inst.Name)
				}
				return a.syncKasada()
			case edgeExternal:
				up, _ := a.upstreamFor("")
				fmt.Println()
				fmt.Print(a.snippet(up))
				fmt.Println()
				fmt.Printf(snippetNote+"\n", a.webPort(), domain)
				a.Log.Event(evlog.Info, "edge up: external mode, snippet printed for %s", domain)
				return nil
			}
			if a.Env.Value("ACME_EMAIL") == "" {
				ui.Warn("ACME_EMAIL is empty: Let's Encrypt works, but sends no expiry warnings")
			}
			if err := a.edgeStack().Run("up", "-d"); err != nil {
				a.Log.Event(evlog.Fail, "edge up: %v", err)
				return err
			}
			a.Log.Event(evlog.OK, "edge up (own Caddy) for %s -> 127.0.0.1:%s", domain, a.webPort())
			ui.OK("Caddy started; the certificate is requested on the first HTTPS visit — check with `edge status`")
			return nil
		},
	})
	c.AddCommand(&cobra.Command{
		Use: "sync", Short: "kasada mode: rewrite sickleguard.caddy for all instances, validate and reload kasada-edge",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, false)
			if err != nil {
				return err
			}
			if kasadaEdge() == nil {
				return fmt.Errorf("%s is not on this server (kasada mode only)", kasadaContainer())
			}
			return a.syncKasada()
		},
	})

	var upstream string
	snip := &cobra.Command{
		Use:   "snippet",
		Short: "Print a Caddy site block for another existing proxy (external mode)",
		Long: `Print a Caddy site block for this instance, for a reverse proxy that is not kasada-edge (on the Kasada
server use kasada mode instead: it is automatic). The block goes to stdout, the notes to stderr.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			up, err := a.upstreamFor(upstream)
			if err != nil {
				return err
			}
			fmt.Print(a.snippet(up))
			fmt.Fprintf(os.Stderr, "\n"+snippetNote+"\n", a.webPort(), a.Env.Value("DOMAIN"))
			a.Log.Event(evlog.Info, "edge snippet printed (upstream %s)", up)
			return nil
		},
	}
	snip.Flags().StringVar(&upstream, "upstream", "host", "how that proxy reaches the web port: host | docker-host | bridge | <host:port>")
	c.AddCommand(snip)

	c.AddCommand(&cobra.Command{
		Use: "status", Short: "Edge mode, the kasada-edge site file, DNS, certificate and the HTTPS health check", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			domain := a.Env.Value("DOMAIN")
			mode, why := a.edgeMode()
			ui.Step("Edge: %s mode (%s)", mode, why)
			switch mode {
			case edgeKasada:
				k := kasadaEdge()
				if k == nil {
					ui.Fail("%s not found on this server", kasadaContainer())
					break
				}
				if err := k.usable(); err != nil {
					ui.Fail("%v", err)
					break
				}
				ui.OK("%s running", k.Container)
				target := filepath.Join(k.Extra, sharedFile)
				b, err := os.ReadFile(target)
				switch {
				case err != nil:
					ui.Warn("%s missing: sickleguard edge sync", target)
				case domain != "" && strings.Contains(string(b), domain+" {"):
					ui.OK("%s has %s → %s:80", target, domain, a.Inst.WebAlias())
					if string(b) != renderShared(a.Root) {
						ui.Warn("the file differs from the current settings: sickleguard edge sync")
					}
				default:
					ui.Warn("%s does not list %s: sickleguard edge sync", target, domain)
				}
			case edgeOwn:
				if a.ownEdgeRunning() {
					ui.OK("SickleGuard Caddy (sickleguard-edge) running")
				} else {
					ui.Warn("SickleGuard Caddy not running: sickleguard edge up")
				}
			}
			if domain == "" {
				ui.Warn("DOMAIN is empty")
				return nil
			}
			checkDNS(domain)
			checkTLS(domain)
			if h, err := health("https://" + domain); err != nil {
				ui.Fail("https://%s/api/v1/health: %v", domain, err)
			} else {
				ui.OK("https://%s answers (API %s)", domain, h.Version)
			}
			return nil
		},
	})
	c.AddCommand(&cobra.Command{
		Use: "down", Short: "Stop our own Caddy (own mode)", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			if !ui.Confirm("Stop the HTTPS proxy sickleguard-edge? The site is unreachable over HTTPS until edge up.") {
				return ui.ErrAborted
			}
			if err := a.edgeStack().Run("down"); err != nil {
				return err
			}
			a.Log.Event(evlog.OK, "edge down")
			return nil
		},
	})
	return c
}

// ---------------------------------------------------------------------------------------------- network checks

// publicIP asks a public echo service (5 s).
func publicIP() (string, error) {
	c := &http.Client{Timeout: 5 * time.Second}
	for _, u := range []string{"https://api.ipify.org", "https://ifconfig.me/ip"} {
		resp, err := c.Get(u)
		if err != nil {
			continue
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 100))
		resp.Body.Close()
		if ip := net.ParseIP(strings.TrimSpace(string(b))); ip != nil {
			return ip.String(), nil
		}
	}
	return "", fmt.Errorf("could not find this host's public IP")
}

// checkDNS reports whether domain points at this host. Returns false on a mismatch.
func checkDNS(domain string) bool {
	addrs, err := net.LookupHost(domain)
	if err != nil || len(addrs) == 0 {
		ui.Fail("DNS: %s does not resolve (add an A record → this server's public IP)", domain)
		return false
	}
	ip, err := publicIP()
	if err != nil {
		ui.Warn("DNS: %s → %s (%v)", domain, strings.Join(addrs, ", "), err)
		return true
	}
	for _, a := range addrs {
		if a == ip {
			ui.OK("DNS: %s → %s (this host)", domain, ip)
			return true
		}
	}
	ui.Warn("DNS: %s → %s, but this host's public IP is %s (fine only when running check elsewhere)", domain,
		strings.Join(addrs, ", "), ip)
	return false
}

// checkTLS reports the certificate served for domain and its expiry.
func checkTLS(domain string) {
	d := &net.Dialer{Timeout: 5 * time.Second}
	conn, err := tls.DialWithDialer(d, "tcp", domain+":443", &tls.Config{ServerName: domain})
	if err != nil {
		ui.Warn("TLS: no valid certificate on %s:443 yet (%v)", domain, shortErr(err))
		return
	}
	defer conn.Close()
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		ui.Warn("TLS: no certificate")
		return
	}
	left := time.Until(certs[0].NotAfter)
	msg := fmt.Sprintf("TLS: certificate by %s, expires %s (%d days)", certs[0].Issuer.CommonName,
		certs[0].NotAfter.Format("2006-01-02"), int(left.Hours()/24))
	if left < 14*24*time.Hour {
		ui.Warn("%s — renewal overdue?", msg)
	} else {
		ui.OK("%s", msg)
	}
}

func shortErr(err error) string {
	s := err.Error()
	if len(s) > 120 {
		s = s[:120] + "…"
	}
	return s
}
