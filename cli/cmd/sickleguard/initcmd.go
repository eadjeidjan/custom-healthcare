package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"sickleguard/cli/internal/envfile"
	"sickleguard/cli/internal/evlog"
	"sickleguard/cli/internal/instance"
	"sickleguard/cli/internal/ui"
)

// LiveDomain is where the live instance is published.
const LiveDomain = "sickleguard.kasadaai.com"

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// randPassword is a 20-character password without symbols that need quoting.
func randPassword() string {
	b := make([]byte, 15)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// portFree reports whether nothing listens on 127.0.0.1:p (and 0.0.0.0:p).
func portFree(p int) bool {
	for _, host := range []string{"127.0.0.1", "0.0.0.0"} {
		l, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(p)))
		if err != nil {
			return false
		}
		_ = l.Close()
	}
	return true
}

// pickPort returns the first port from 8310 (live) or 8320+ that is free and not claimed by another instance.
func pickPort(root, name string) int {
	used := instance.UsedPorts(root, name, func(p string) map[string]string {
		f, err := envfile.Load(p)
		if err != nil {
			return nil
		}
		return f.Map()
	})
	start := 8310
	if name != "live" {
		start = 8320
	}
	for p := start; p < start+200; p++ {
		if _, taken := used[p]; !taken && portFree(p) {
			return p
		}
	}
	return start
}

func initCmd() *cobra.Command {
	var publicURL, domain, acme, adminEmail string
	var webPort int
	var demo, noDemo, adopt bool
	c := &cobra.Command{
		Use:   "init",
		Short: "Create the instance settings (deploy/<instance>.env) with random secrets",
		Long: `Create deploy/<instance>.env from deploy/env.example with random secrets (Postgres, JWT, MCP token,
admin password), the OpenAI key (hidden input), the public address and a free web port. It never overwrites an
existing file: change single keys with ` + "`sickleguard env set KEY`" + `.

--adopt-legacy turns deploy/.env from the old scripts/sg into deploy/live.env, keeping the Compose project "sg"
so the existing database and volumes stay in use.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, false)
			if err != nil {
				return err
			}
			if a.Env.Exists {
				return fmt.Errorf("%s already exists (left unchanged); change keys with `sickleguard --instance %s env set KEY`",
					a.Inst.RelEnvPath(), a.Inst.Name)
			}
			if adopt {
				return adoptLegacy(a)
			}
			ex, err := envfile.Load(a.Inst.ExampleEnv())
			if err != nil || !ex.Exists {
				return fmt.Errorf("deploy/env.example is missing")
			}
			f := &envfile.File{Path: a.Inst.EnvPath(), Lines: append([]string(nil), ex.Lines...)}
			live := a.Inst.IsLive()
			ui.Step("New instance %s (Compose project %s)", a.Inst.Name, a.Inst.Project(nil))
			if k := kasadaEdge(); k != nil {
				ui.Info("%s found: HTTPS through the shared front proxy (kasada mode)", k.Container)
			}

			// Address
			if webPort == 0 {
				webPort = pickPort(a.Root, a.Inst.Name)
			}
			webPort, _ = strconv.Atoi(ui.Ask("Web port on 127.0.0.1", strconv.Itoa(webPort)))
			if webPort <= 0 {
				return fmt.Errorf("invalid web port")
			}
			if !portFree(webPort) {
				ui.Warn("port %d is in use right now", webPort)
			}
			defDomain := ""
			if live {
				defDomain = LiveDomain
			}
			if domain == "" {
				domain = ui.Ask("Domain for HTTPS (empty: no HTTPS, local port only)", defDomain)
			}
			if publicURL == "" {
				def := fmt.Sprintf("http://localhost:%d", webPort)
				if domain != "" {
					def = "https://" + domain
				}
				publicURL = ui.Ask("Public URL", def)
			}
			if u, err := url.Parse(publicURL); err != nil || u.Host == "" {
				return fmt.Errorf("public URL %q is not a URL", publicURL)
			}
			if acme == "" && domain != "" {
				acme = ui.Ask("E-mail for Let's Encrypt", ex.Value("ACME_EMAIL"))
			}
			if adminEmail == "" {
				adminEmail = ui.Ask("Administrator e-mail", ex.Value("ADMIN_EMAIL"))
			}

			// Demo data: off on live unless asked, on elsewhere unless refused.
			seed := !live
			switch {
			case demo:
				seed = true
			case noDemo:
				seed = false
			case !ui.Yes && ui.Interactive():
				seed = ui.Confirm("Load fictional demo patients and demo accounts?")
			}

			// OpenAI key, hidden.
			key := os.Getenv("SG_OPENAI_API_KEY") // for automation; never on the command line
			if key == "" && !ui.Yes && ui.Interactive() {
				if key, err = ui.AskSecret("OpenAI API key (Enter to skip; add later with `env set OPENAI_API_KEY`)"); err != nil {
					return err
				}
			}

			adminPW := randPassword()
			vals := [][2]string{
				{"ENVIRONMENT", "production"},
				{"PUBLIC_URL", publicURL},
				{"DOMAIN", domain},
				{"ACME_EMAIL", acme},
				{"WEB_PORT", strconv.Itoa(webPort)},
				{"OPENAI_API_KEY", key},
				{"POSTGRES_PASSWORD", randHex(24)},
				{"JWT_SECRET", randHex(32)},
				{"MCP_TOKEN", randHex(24)},
				{"ADMIN_EMAIL", adminEmail},
				{"ADMIN_PASSWORD", adminPW},
				{"SEED_DEMO", strconv.FormatBool(seed)},
				{"SIMULATE_DEVICES", "false"},
			}
			if seed {
				vals = append(vals, [2]string{"DEMO_PASSWORD", randPassword()})
			} else {
				vals = append(vals, [2]string{"DEMO_PASSWORD", ""})
			}
			for _, kv := range vals {
				if _, err := f.Set(kv[0], kv[1]); err != nil {
					return err
				}
				if envfile.SecretKey(kv[0]) {
					a.Log.Register(kv[1])
				}
			}
			if err := f.Save(); err != nil {
				return err
			}
			_ = os.Remove(f.Path + ".bak") // nothing to keep on a new file
			a.Log.Event(evlog.OK, "created %s (port %d, url %s, demo %v, openai %v)", a.Inst.RelEnvPath(), webPort,
				publicURL, seed, key != "")
			ui.OK("%s created (mode 600)", a.Inst.RelEnvPath())
			ui.Info("sign in as %s — the password is ADMIN_PASSWORD (show it once with `sickleguard --instance %s env get ADMIN_PASSWORD --show`)",
				adminEmail, a.Inst.Name)
			if key == "" {
				ui.Info("no OpenAI key: the app runs without AI summaries and the assistant until you `env set OPENAI_API_KEY`")
			}
			ui.Info("next: sickleguard --instance %s check, then deploy", a.Inst.Name)
			return nil
		},
	}
	f := c.Flags()
	f.StringVar(&publicURL, "public-url", "", "public URL (default https://<domain>, or http://localhost:<port>)")
	f.StringVar(&domain, "domain", "", "domain for HTTPS (live suggests "+LiveDomain+")")
	f.StringVar(&acme, "email", "", "e-mail for Let's Encrypt certificate notices")
	f.StringVar(&acme, "acme-email", "", "same as --email")
	_ = f.MarkHidden("acme-email")
	f.StringVar(&adminEmail, "admin-email", "", "administrator e-mail")
	f.IntVar(&webPort, "web-port", 0, "web port on 127.0.0.1 (default: first free from 8310 for live, 8320 otherwise)")
	f.BoolVar(&demo, "demo", false, "load fictional demo patients and create demo accounts")
	f.BoolVar(&noDemo, "no-demo", false, "no demo data (default for live)")
	f.BoolVar(&adopt, "adopt-legacy", false, "turn deploy/.env from the old scripts/sg into this instance's settings")
	return c
}

// adoptLegacy copies deploy/.env to deploy/<instance>.env and pins COMPOSE_PROJECT_NAME=sg (its volumes).
func adoptLegacy(a *App) error {
	old, err := envfile.Load(a.Inst.LegacyEnvPath())
	if err != nil || !old.Exists {
		return fmt.Errorf("deploy/.env not found")
	}
	f := &envfile.File{Path: a.Inst.EnvPath(), Lines: append([]string(nil), old.Lines...)}
	if v, _ := f.Get("COMPOSE_PROJECT_NAME"); strings.TrimSpace(v) == "" {
		if _, err := f.Set("COMPOSE_PROJECT_NAME", "sg"); err != nil {
			return err
		}
	}
	if err := f.Save(); err != nil {
		return err
	}
	_ = os.Remove(f.Path + ".bak")
	a.Log.Event(evlog.OK, "adopted deploy/.env as %s (project sg)", a.Inst.RelEnvPath())
	ui.OK("%s created from deploy/.env (Compose project stays \"sg\"; deploy/.env left in place)", a.Inst.RelEnvPath())
	return nil
}
