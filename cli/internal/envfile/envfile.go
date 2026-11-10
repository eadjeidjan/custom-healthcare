// Package envfile reads and edits Docker Compose env files in place: comments, order and unknown lines are kept,
// a changed key is rewritten on its own line, and every save keeps the previous file as <path>.bak.
package envfile

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var keyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// File is an env file as lines, so an edit changes only the line of that key.
type File struct {
	Path   string
	Lines  []string
	Exists bool
}

// Load reads path; a missing file gives an empty File with Exists false.
func Load(path string) (*File, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return &File{Path: path}, nil
	}
	if err != nil {
		return nil, err
	}
	f := Parse(string(data))
	f.Path, f.Exists = path, true
	return f, nil
}

// Parse splits text into lines (a trailing newline does not make an extra empty line).
func Parse(text string) *File {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.TrimSuffix(text, "\n")
	f := &File{}
	if text != "" {
		f.Lines = strings.Split(text, "\n")
	}
	return f
}

// ValidKey reports whether k can be an env key.
func ValidKey(k string) bool { return keyRe.MatchString(k) }

// ParseLine returns the key and value of an assignment line ("KEY=value", "export KEY=value", quoted values,
// trailing " # comment" on unquoted values). Comments and blank lines give ok=false.
func ParseLine(line string) (key, value string, ok bool) {
	s := strings.TrimSpace(line)
	if s == "" || strings.HasPrefix(s, "#") {
		return "", "", false
	}
	s = strings.TrimPrefix(s, "export ")
	i := strings.IndexByte(s, '=')
	if i <= 0 {
		return "", "", false
	}
	key = strings.TrimSpace(s[:i])
	if !ValidKey(key) {
		return "", "", false
	}
	return key, unquote(strings.TrimSpace(s[i+1:])), true
}

func unquote(v string) string {
	if len(v) >= 2 && v[0] == '\'' {
		if j := strings.IndexByte(v[1:], '\''); j >= 0 {
			return v[1 : j+1]
		}
	}
	if len(v) >= 2 && v[0] == '"' {
		var b strings.Builder
		for i := 1; i < len(v); i++ {
			c := v[i]
			if c == '\\' && i+1 < len(v) {
				i++
				switch v[i] {
				case 'n':
					b.WriteByte('\n')
				default:
					b.WriteByte(v[i])
				}
				continue
			}
			if c == '"' {
				return strings.ReplaceAll(b.String(), "$$", "$")
			}
			b.WriteByte(c)
		}
	}
	if j := strings.Index(v, " #"); j >= 0 {
		v = strings.TrimSpace(v[:j])
	}
	return v
}

// Quote formats a value so Compose reads it back unchanged: plain when safe, single-quoted (no interpolation)
// when it has spaces, '#', quotes or '$', double-quoted with escapes when it contains a single quote.
func Quote(v string) string {
	if v == "" || !strings.ContainsAny(v, " \t#'\"$\\`") {
		return v
	}
	if !strings.Contains(v, "'") {
		return "'" + v + "'"
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `$`, `$$`)
	return `"` + r.Replace(v) + `"`
}

// Get returns the value of the last assignment of key (Compose uses the last one).
func (f *File) Get(key string) (string, bool) {
	val, found := "", false
	for _, l := range f.Lines {
		if k, v, ok := ParseLine(l); ok && k == key {
			val, found = v, true
		}
	}
	return val, found
}

// Value returns Get(key) or "" when missing.
func (f *File) Value(key string) string {
	v, _ := f.Get(key)
	return v
}

// Map returns every key with its value.
func (f *File) Map() map[string]string {
	m := map[string]string{}
	for _, l := range f.Lines {
		if k, v, ok := ParseLine(l); ok {
			m[k] = v
		}
	}
	return m
}

// Keys returns the keys in file order (each once).
func (f *File) Keys() []string {
	seen := map[string]bool{}
	var out []string
	for _, l := range f.Lines {
		if k, _, ok := ParseLine(l); ok && !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}

// Set changes key in place (every assignment of it, so the last one wins with the new value) or appends it.
// It reports whether the file changed.
func (f *File) Set(key, value string) (bool, error) {
	if !ValidKey(key) {
		return false, fmt.Errorf("invalid key %q", key)
	}
	if strings.ContainsAny(value, "\n\r") {
		return false, fmt.Errorf("%s: value must be one line", key)
	}
	line := key + "=" + Quote(value)
	found, changed := false, false
	for i, l := range f.Lines {
		if k, _, ok := ParseLine(l); ok && k == key {
			found = true
			if l != line {
				f.Lines[i], changed = line, true
			}
		}
	}
	if !found {
		f.Lines = append(f.Lines, line)
		changed = true
	}
	return changed, nil
}

// Bytes is the file content with a final newline.
func (f *File) Bytes() []byte {
	if len(f.Lines) == 0 {
		return nil
	}
	return []byte(strings.Join(f.Lines, "\n") + "\n")
}

// Save writes the file atomically with mode 0600. An existing file is copied to <path>.bak first.
func (f *File) Save() error {
	if f.Path == "" {
		return fmt.Errorf("env file has no path")
	}
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
		return err
	}
	if old, err := os.ReadFile(f.Path); err == nil {
		if err := os.WriteFile(f.Path+".bak", old, 0o600); err != nil {
			return fmt.Errorf("keep backup: %w", err)
		}
	}
	tmp := f.Path + ".tmp"
	if err := os.WriteFile(tmp, f.Bytes(), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, f.Path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	f.Exists = true
	return os.Chmod(f.Path, 0o600)
}

// SecretKey reports a key whose value must never be printed or logged.
func SecretKey(k string) bool {
	k = strings.ToUpper(k)
	for _, w := range []string{"SECRET", "PASSWORD", "TOKEN", "KEY", "PASSWD", "PRIVATE", "DSN"} {
		if strings.Contains(k, w) {
			return true
		}
	}
	return strings.HasPrefix(k, "DATABASE_URL")
}

// Mask hides a secret: "(empty)", "(set, 12 chars)" or, for long API keys, the 3-character prefix
// ("sk-…, 164 chars") so the kind of key is recognisable without revealing it.
func Mask(v string) string {
	switch {
	case v == "":
		return "(empty)"
	case len(v) >= 20 && strings.HasPrefix(v, "sk-"):
		return fmt.Sprintf("sk-…(%d chars)", len(v))
	default:
		return fmt.Sprintf("••••(%d chars)", len(v))
	}
}

// Display returns the value as it may be shown: masked for secret keys unless show is true.
func Display(key, value string, show bool) string {
	if show || !SecretKey(key) {
		return value
	}
	return Mask(value)
}
