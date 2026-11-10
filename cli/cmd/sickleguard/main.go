// Command sickleguard deploys and operates SickleGuard instances with Docker Compose.
// Every instance is a Compose project sickleguard-<name> with its settings in deploy/<name>.env.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"sickleguard/cli/internal/envfile"
	"sickleguard/cli/internal/evlog"
	"sickleguard/cli/internal/instance"
	"sickleguard/cli/internal/stack"
	"sickleguard/cli/internal/ui"
)

// Set by the Makefile (-ldflags -X).
var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
	// defaultRoot is the repository the binary was installed from (cli/install.sh), so it works from any folder.
	defaultRoot = ""
)

var (
	flagInstance string
	flagDir      string
	flagVerbose  bool
)

// App is the context of one command: repository, instance, settings, Compose project, state and event log.
type App struct {
	Root  string
	Inst  instance.Instance
	Env   *envfile.File
	Stack stack.Stack
	State *instance.State
	Log   *evlog.Log
}

func main() {
	root := newRoot()
	if err := root.Execute(); err != nil {
		if !errors.Is(err, errQuiet) {
			ui.Fail("%v", err)
		}
		os.Exit(1)
	}
}

// errQuiet ends a command with exit 1 after it already printed why.
var errQuiet = errors.New("failed")

func newRoot() *cobra.Command {
	name := filepath.Base(os.Args[0])
	if name != "sg" {
		name = "sickleguard"
	}
	root := &cobra.Command{
		Use:   name,
		Short: "Deploy and operate SickleGuard (Docker Compose instances behind Caddy)",
		Long: `Deploy and operate SickleGuard. Each instance is a Docker Compose project sickleguard-<name> with its
settings in deploy/<name>.env (default instance: live). Every action is recorded in deploy/logs/events.log without secrets.

First time on a server:  init → check → deploy (on the Kasada server HTTPS is set up by deploy).   Every day: status, logs, backup, update.`,
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRun: func(cmd *cobra.Command, _ []string) {
			stack.Verbose = flagVerbose
		},
	}
	def := os.Getenv("SG_INSTANCE")
	if def == "" {
		def = instance.Default
	}
	pf := root.PersistentFlags()
	pf.StringVarP(&flagInstance, "instance", "i", def, "instance name (Compose project sickleguard-<name>, settings deploy/<name>.env)")
	pf.StringVar(&flagDir, "dir", os.Getenv("SG_DIR"), "repository root (default: found from the current folder)")
	pf.BoolVarP(&ui.Yes, "yes", "y", false, "answer yes to questions (non-interactive)")
	pf.BoolVarP(&flagVerbose, "verbose", "v", false, "show the docker commands that run")

	root.AddCommand(initCmd(), checkCmd(), deployCmd(), updateCmd(), rollbackCmd(), statusCmd(), logsCmd(),
		restartCmd(), downCmd(), execCmd(), backupCmd(), restoreCmd(), usersCmd(), modelCmd(), knowledgeCmd(),
		demoCmd(), envCmd(), edgeCmd(), versionCmd())
	return root
}

// ---------------------------------------------------------------------------------------------- context

func isRepo(dir string) bool {
	_, e1 := os.Stat(filepath.Join(dir, "deploy", "docker-compose.yml"))
	_, e2 := os.Stat(filepath.Join(dir, "api", "app"))
	return e1 == nil && e2 == nil
}

func walkUp(dir string) string {
	for d := dir; ; d = filepath.Dir(d) {
		if isRepo(d) {
			return d
		}
		if p := filepath.Dir(d); p == d {
			return ""
		}
	}
}

// findRoot locates the repository: --dir / SG_DIR, the current folder or a parent, or the folder of the binary.
func findRoot() (string, error) {
	if flagDir != "" {
		abs, _ := filepath.Abs(flagDir)
		if !isRepo(abs) {
			return "", fmt.Errorf("%s is not a SickleGuard repository (no deploy/docker-compose.yml)", abs)
		}
		return abs, nil
	}
	if wd, err := os.Getwd(); err == nil {
		if r := walkUp(wd); r != "" {
			return r, nil
		}
	}
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			if r := walkUp(filepath.Dir(real)); r != "" {
				return r, nil
			}
		}
	}
	if defaultRoot != "" && isRepo(defaultRoot) {
		return defaultRoot, nil
	}
	return "", errors.New("not inside a SickleGuard repository: cd into it, or pass --dir / set SG_DIR")
}

func commandName(cmd *cobra.Command) string {
	parts := strings.Fields(cmd.CommandPath())
	if len(parts) > 1 {
		return strings.Join(parts[1:], " ")
	}
	return parts[0]
}

// load builds the App. needEnv: the instance's env file must exist.
func load(cmd *cobra.Command, needEnv bool) (*App, error) {
	root, err := findRoot()
	if err != nil {
		return nil, err
	}
	inst, err := instance.New(root, flagInstance)
	if err != nil {
		return nil, err
	}
	env, err := envfile.Load(inst.EnvPath())
	if err != nil {
		return nil, err
	}
	if needEnv && !env.Exists {
		hint := ""
		if _, err := os.Stat(inst.LegacyEnvPath()); err == nil && inst.IsLive() {
			hint = "\n  deploy/.env from the old scripts/sg exists: adopt it (data kept) with: sickleguard init --adopt-legacy"
		}
		return nil, fmt.Errorf("instance %q has no settings (%s): run `sickleguard --instance %s init` first%s",
			inst.Name, inst.RelEnvPath(), inst.Name, hint)
	}
	st, err := instance.LoadState(inst.StatePath())
	if err != nil {
		return nil, err
	}
	a := &App{Root: root, Inst: inst, Env: env, State: st}
	files := []string{inst.ComposeFile()}
	if m := strings.ToLower(env.Value("EDGE_MODE")); kasadaEdge() != nil && m != edgeOwn && m != edgeExternal {
		files = append(files, inst.SharedEdge()) // join kasada-edge's network as sickleguard-<instance>-web
	}
	a.Stack = stack.Stack{Project: inst.Project(env.Map()), EnvFile: inst.EnvPath(), Files: files, Tag: st.Tag(),
		Instance: inst.Name}
	a.Log = evlog.Open(filepath.Join(inst.LogsDir(), "events.log"), inst.Name, commandName(cmd))
	a.registerSecrets()
	return a, nil
}

func (a *App) registerSecrets() {
	for k, v := range a.Env.Map() {
		if envfile.SecretKey(k) {
			a.Log.Register(v)
		}
	}
}

// reloadEnv re-reads the env file after a change.
func (a *App) reloadEnv() error {
	env, err := envfile.Load(a.Inst.EnvPath())
	if err != nil {
		return err
	}
	a.Env = env
	a.registerSecrets()
	return nil
}

func (a *App) withTag(tag string) stack.Stack {
	s := a.Stack
	s.Tag = tag
	return s
}

// webPort is WEB_PORT (8310 when unset).
func (a *App) webPort() string {
	if p := a.Env.Value("WEB_PORT"); p != "" {
		return p
	}
	return "8310"
}

// localURL reaches the web container directly on this host.
func (a *App) localURL() string { return "http://127.0.0.1:" + a.webPort() }

// publicURL is PUBLIC_URL, or the local URL.
func (a *App) publicURL() string {
	if u := a.Env.Value("PUBLIC_URL"); u != "" && !strings.Contains(u, "example.com") {
		return u
	}
	return a.localURL()
}

// apiImage is the api image for the running tag, falling back to latest.
func (a *App) apiImage() string {
	ref := "sg-api:" + a.State.Tag()
	if stack.ImageExists(ref) {
		return ref
	}
	return "sg-api:latest"
}

// running returns the running services of the project.
func (a *App) running() map[string]stack.Container {
	out := map[string]stack.Container{}
	list, _ := a.Stack.PS()
	for _, c := range list {
		if c.State == "running" {
			out[c.Service] = c
		}
	}
	return out
}

func (a *App) needRunning(services ...string) error {
	r := a.running()
	for _, s := range services {
		if _, ok := r[s]; !ok {
			return fmt.Errorf("the %s container of instance %s is not running: start it with `sickleguard --instance %s deploy`",
				s, a.Inst.Name, a.Inst.Name)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------------------------- git

func gitOut(root string, args ...string) (string, error) {
	c := exec.Command("git", append([]string{"-C", root}, args...)...)
	out, err := c.Output()
	return strings.TrimSpace(string(out)), err
}

// gitInfo returns the short SHA and whether tracked or untracked (non-ignored) files changed.
func gitInfo(root string) (sha string, dirty bool) {
	sha, _ = gitOut(root, "rev-parse", "--short", "HEAD")
	st, _ := gitOut(root, "status", "--porcelain")
	return sha, st != ""
}

func newTag(root string) string {
	sha, dirty := gitInfo(root)
	return instance.MakeTag(sha, dirty, time.Now())
}

func ago(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

func humanBytes(n int64) string {
	const k = 1024
	if n < k {
		return fmt.Sprintf("%d B", n)
	}
	f, u := float64(n), "KMGT"
	i := -1
	for f >= k && i < len(u)-1 {
		f /= k
		i++
	}
	return fmt.Sprintf("%.1f %ciB", f, u[i])
}
