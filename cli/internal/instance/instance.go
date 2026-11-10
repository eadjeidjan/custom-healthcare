// Package instance maps an instance name to its Compose project, env file, state file and backups, keeps the
// deployed image tags (for rollback) and validates an instance's settings.
package instance

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Default is the instance used when --instance is not given.
const Default = "live"

var (
	nameRe   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,29}$`)
	tagRe    = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
	domainRe = regexp.MustCompile(`^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$`)
	// Reserved names: "dev" is the Mac development stack (scripts/dev.sh, project sg-dev), "edge" SickleGuard's own
	// HTTPS proxy (project sickleguard-edge).
	reserved = map[string]string{"dev": "it means the development stack (scripts/dev.sh)", "edge": "sickleguard-edge is the HTTPS proxy"}
)

// ValidateName checks an instance name: lower-case letters, digits and dashes, starting with a letter.
func ValidateName(name string) error {
	if !nameRe.MatchString(name) || strings.HasSuffix(name, "-") {
		return fmt.Errorf("instance name %q: use lower-case letters, digits and dashes, starting with a letter (max 30)", name)
	}
	if why, ok := reserved[name]; ok {
		return fmt.Errorf("instance name %q is reserved: %s", name, why)
	}
	return nil
}

// Instance is one deployment of SickleGuard on this host.
type Instance struct {
	Name string
	Root string // repository root
}

// New validates name and returns the instance.
func New(root, name string) (Instance, error) {
	if err := ValidateName(name); err != nil {
		return Instance{}, err
	}
	return Instance{Name: name, Root: root}, nil
}

// Project is the Compose project name: sickleguard-<name>, unless the env file pins COMPOSE_PROJECT_NAME (an adopted
// install from the old scripts/sg used project "sg").
func (i Instance) Project(env map[string]string) string {
	if p := strings.TrimSpace(env["COMPOSE_PROJECT_NAME"]); p != "" {
		return p
	}
	return "sickleguard-" + i.Name
}

// WebAlias is the web container's name on the kasada-edge network (deploy/shared-edge.yml).
func (i Instance) WebAlias() string { return "sickleguard-" + i.Name + "-web" }

func (i Instance) EnvPath() string     { return filepath.Join(i.Root, "deploy", i.Name+".env") }
func (i Instance) LogsDir() string     { return filepath.Join(i.Root, "deploy", "logs") }
func (i Instance) StatePath() string   { return filepath.Join(i.LogsDir(), i.Name+".state") }
func (i Instance) BackupsDir() string  { return filepath.Join(i.Root, "backups") }
func (i Instance) ComposeFile() string { return filepath.Join(i.Root, "deploy", "docker-compose.yml") }
func (i Instance) EdgeCompose() string {
	return filepath.Join(i.Root, "deploy", "edge", "docker-compose.yml")
}
func (i Instance) SharedEdge() string    { return filepath.Join(i.Root, "deploy", "shared-edge.yml") }
func (i Instance) ExampleEnv() string    { return filepath.Join(i.Root, "deploy", "env.example") }
func (i Instance) IsLive() bool          { return i.Name == "live" }
func (i Instance) RelEnvPath() string    { return filepath.Join("deploy", i.Name+".env") }
func (i Instance) LegacyEnvPath() string { return filepath.Join(i.Root, "deploy", ".env") }

// List returns the names of instances that have an env file in deploy/.
func List(root string) []string {
	matches, _ := filepath.Glob(filepath.Join(root, "deploy", "*.env"))
	var out []string
	for _, m := range matches {
		n := strings.TrimSuffix(filepath.Base(m), ".env")
		if ValidateName(n) == nil {
			out = append(out, n)
		}
	}
	return out
}

// ---------------------------------------------------------------------------------------------- image tags

// ValidTag reports a Docker tag.
func ValidTag(t string) bool { return tagRe.MatchString(t) }

// MakeTag is the image tag for a build: the git short SHA, plus "-dirty-<UTC time>" when the working tree has
// changes, so two builds of different uncommitted code never share a tag (and rollback finds the right one).
func MakeTag(sha string, dirty bool, now time.Time) string {
	sha = strings.TrimSpace(sha)
	if sha == "" {
		sha = "nogit"
	}
	if dirty {
		return sha + "-dirty-" + now.UTC().Format("20060102150405")
	}
	return sha
}

// ---------------------------------------------------------------------------------------------- state

// Entry is one deployment in the history.
type Entry struct {
	Tag    string    `json:"tag"`
	Action string    `json:"action"` // deploy | update | rollback | auto-rollback
	At     time.Time `json:"at"`
}

// State is deploy/logs/<instance>.state: the running image tag and the one before it.
type State struct {
	Current  string  `json:"current"`
	Previous string  `json:"previous"`
	History  []Entry `json:"history"`
}

const historyMax = 30

// LoadState reads the state file; a missing file is an empty state.
func LoadState(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return &State{}, nil
	}
	if err != nil {
		return nil, err
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &s, nil
}

// Save writes the state file atomically.
func (s *State) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(s, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Tag is the tag to run: the current one, or "latest" before the first deploy.
func (s *State) Tag() string {
	if s.Current != "" {
		return s.Current
	}
	return "latest"
}

// Promote records tag as running; the tag it replaces becomes Previous (unless it is the same tag).
func (s *State) Promote(tag, action string, now time.Time) {
	if s.Current != "" && s.Current != tag {
		s.Previous = s.Current
	}
	s.Current = tag
	s.History = append(s.History, Entry{Tag: tag, Action: action, At: now.UTC()})
	if len(s.History) > historyMax {
		s.History = s.History[len(s.History)-historyMax:]
	}
}

// RollbackTarget is the tag a rollback goes to: explicit when given, else Previous.
func (s *State) RollbackTarget(explicit string) (string, error) {
	t := strings.TrimSpace(explicit)
	if t == "" {
		t = s.Previous
	}
	if t == "" {
		return "", errors.New("no previous image tag recorded: name one (sickleguard rollback <tag>; tags: sickleguard status)")
	}
	if !ValidTag(t) {
		return "", fmt.Errorf("%q is not a valid image tag", t)
	}
	if t == s.Current {
		return "", fmt.Errorf("%s is already running", t)
	}
	return t, nil
}

// KnownTags lists tags from the history, newest first, each once.
func (s *State) KnownTags() []string {
	seen := map[string]bool{}
	var out []string
	for i := len(s.History) - 1; i >= 0; i-- {
		if t := s.History[i].Tag; !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// ---------------------------------------------------------------------------------------------- settings

// Issue is a problem found in an instance's settings.
type Issue struct {
	Fatal bool
	Msg   string
}

// Required keys must be present and non-empty for the stack to start.
var Required = []string{"POSTGRES_PASSWORD", "JWT_SECRET", "MCP_TOKEN", "PUBLIC_URL", "WEB_PORT"}

// Validate checks the settings of instance name. Fatal issues stop a deploy.
func Validate(name string, env map[string]string) []Issue {
	var out []Issue
	fatal := func(f string, a ...any) { out = append(out, Issue{true, fmt.Sprintf(f, a...)}) }
	warn := func(f string, a ...any) { out = append(out, Issue{false, fmt.Sprintf(f, a...)}) }
	for _, k := range Required {
		if strings.TrimSpace(env[k]) == "" {
			fatal("%s is empty", k)
		}
	}
	if j := env["JWT_SECRET"]; j != "" && (len(j) < 32 || strings.HasPrefix(j, "dev-")) {
		fatal("JWT_SECRET must be a random value of at least 32 characters")
	}
	if p := env["POSTGRES_PASSWORD"]; p != "" && len(p) < 16 {
		warn("POSTGRES_PASSWORD is short (%d characters)", len(p))
	}
	if p := env["WEB_PORT"]; p != "" {
		if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
			fatal("WEB_PORT %q is not a port number", p)
		}
	}
	if e := env["ENVIRONMENT"]; e != "" && e != "production" {
		warn("ENVIRONMENT is %q (production turns off the API docs and enforces secrets)", e)
	}
	if env["ADMIN_PASSWORD"] == "" {
		warn("ADMIN_PASSWORD is empty: no administrator is created on a fresh database")
	}
	if u := env["PUBLIC_URL"]; u != "" {
		pu, err := url.Parse(u)
		switch {
		case err != nil || pu.Host == "":
			fatal("PUBLIC_URL %q is not a URL", u)
		case strings.Contains(pu.Host, "example.com"):
			warn("PUBLIC_URL is still the example (%s)", u)
		case name == "live" && pu.Scheme != "https":
			warn("PUBLIC_URL should be https:// on live")
		}
	}
	if d := env["DOMAIN"]; d != "" && !domainRe.MatchString(d) {
		fatal("DOMAIN %q is not a host name", d)
	} else if strings.Contains(d, "example.com") {
		warn("DOMAIN is still the example (%s)", d)
	}
	if name == "live" {
		if isTrue(env["SEED_DEMO"]) {
			warn("SEED_DEMO=true on live: fictional demo patients are loaded on an empty database")
		}
		if isTrue(env["SIMULATE_DEVICES"]) {
			warn("SIMULATE_DEVICES=true on live: simulated device readings are generated")
		}
	}
	return out
}

func isTrue(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// UsedPorts returns WEB_PORT of every other instance's env file in deploy/.
func UsedPorts(root, except string, read func(path string) map[string]string) map[int]string {
	out := map[int]string{}
	for _, n := range List(root) {
		if n == except {
			continue
		}
		env := read(filepath.Join(root, "deploy", n+".env"))
		if p, err := strconv.Atoi(env["WEB_PORT"]); err == nil {
			out[p] = n
		}
	}
	return out
}
