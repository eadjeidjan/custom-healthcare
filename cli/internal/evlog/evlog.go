// Package evlog appends one line per event to deploy/logs/events.log:
// "2026-11-10T12:00:00Z  test   deploy    OK    message". Registered secrets are replaced by "****" before writing.
package evlog

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Level of an event.
const (
	Info = "INFO"
	OK   = "OK"
	Warn = "WARN"
	Fail = "FAIL"
)

// Log is the event log of one command run.
type Log struct {
	mu       sync.Mutex
	path     string
	instance string
	command  string
	secrets  []string
	now      func() time.Time
}

// Open prepares the log at path (created on the first event). A Log with an empty path discards events.
func Open(path, instance, command string) *Log {
	return &Log{path: path, instance: instance, command: command, now: time.Now}
}

// Register adds a value that must never be written (values shorter than 6 characters are ignored: masking
// them would mangle ordinary words).
func (l *Log) Register(values ...string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, v := range values {
		if v = strings.TrimSpace(v); len(v) >= 6 {
			l.secrets = append(l.secrets, v)
		}
	}
	// Longest first, so a secret that contains another is masked whole.
	sort.Slice(l.secrets, func(i, j int) bool { return len(l.secrets[i]) > len(l.secrets[j]) })
}

// Mask replaces every secret in s with ****.
func Mask(s string, secrets []string) string {
	for _, v := range secrets {
		if v != "" {
			s = strings.ReplaceAll(s, v, "****")
		}
	}
	return s
}

// Line formats one event line.
func Line(t time.Time, instance, command, level, msg string) string {
	msg = strings.Join(strings.Fields(strings.ReplaceAll(msg, "\n", " ")), " ")
	if instance == "" {
		instance = "-"
	}
	return fmt.Sprintf("%s  %-10s %-16s %-4s  %s\n", t.UTC().Format(time.RFC3339), instance, command, level, msg)
}

// Event appends a line; failures to write the log never stop the command.
func (l *Log) Event(level, format string, a ...any) {
	if l == nil || l.path == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	msg := Mask(fmt.Sprintf(format, a...), l.secrets)
	if err := os.MkdirAll(filepath.Dir(l.path), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(Line(l.now(), l.instance, l.command, level, msg))
}
