package evlog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEventsAreMasked(t *testing.T) {
	p := filepath.Join(t.TempDir(), "logs", "events.log")
	l := Open(p, "test", "env set")
	l.Register("supersecretvalue", "abc", "supersecret")
	l.Event(OK, "set KEY to supersecretvalue and supersecret\nnext line")
	l.Event(Fail, "plain abc stays")
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if strings.Contains(s, "supersecret") {
		t.Errorf("secret written: %s", s)
	}
	if !strings.Contains(s, "set KEY to **** and **** next line") || !strings.Contains(s, "plain abc stays") {
		t.Error(s)
	}
	if n := strings.Count(s, "\n"); n != 2 {
		t.Errorf("%d lines", n)
	}
	if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
		t.Error("mode", st.Mode())
	}
}

func TestLineFormat(t *testing.T) {
	line := Line(time.Date(2026, 11, 10, 1, 2, 3, 0, time.UTC), "", "deploy", OK, "done")
	if !strings.HasPrefix(line, "2026-11-10T01:02:03Z  -") || !strings.HasSuffix(line, "OK    done\n") {
		t.Errorf("%q", line)
	}
	var nilLog *Log
	nilLog.Event(OK, "no panic")
}
