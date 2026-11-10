package instance

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNames(t *testing.T) {
	for _, n := range []string{"live", "test", "demo-2", "a"} {
		if err := ValidateName(n); err != nil {
			t.Errorf("%s: %v", n, err)
		}
	}
	for _, n := range []string{"", "Live", "1x", "a_b", "x-", "dev", "edge", "../etc", strings.Repeat("a", 31)} {
		if ValidateName(n) == nil {
			t.Errorf("%q accepted", n)
		}
	}
	i, _ := New("/r", "test")
	if i.Project(nil) != "sickleguard-test" || i.WebAlias() != "sickleguard-test-web" || i.EnvPath() != "/r/deploy/test.env" || i.StatePath() != "/r/deploy/logs/test.state" {
		t.Error(i.Project(nil), i.EnvPath(), i.StatePath())
	}
	if i.Project(map[string]string{"COMPOSE_PROJECT_NAME": "sg"}) != "sg" {
		t.Error("pinned project ignored")
	}
}

func TestTags(t *testing.T) {
	now := time.Date(2026, 11, 10, 9, 8, 7, 0, time.UTC)
	if MakeTag("abc1234", false, now) != "abc1234" {
		t.Error("clean")
	}
	if got := MakeTag("abc1234", true, now); got != "abc1234-dirty-20261110090807" || !ValidTag(got) {
		t.Error(got)
	}
	if MakeTag("", false, now) != "nogit" {
		t.Error("nogit")
	}
	if ValidTag("a b") || ValidTag("") || ValidTag("-x") {
		t.Error("bad tag accepted")
	}
}

func TestStatePromoteAndRollback(t *testing.T) {
	p := filepath.Join(t.TempDir(), "logs", "x.state")
	s, err := LoadState(p)
	if err != nil || s.Tag() != "latest" {
		t.Fatal(err, s.Tag())
	}
	if _, err := s.RollbackTarget(""); err == nil {
		t.Error("rollback without history")
	}
	now := time.Now()
	s.Promote("aaa", "deploy", now)
	s.Promote("aaa", "deploy", now) // redeploy of the same tag keeps no self-previous
	if s.Previous != "" {
		t.Error("previous set to itself")
	}
	s.Promote("bbb", "update", now)
	if s.Current != "bbb" || s.Previous != "aaa" {
		t.Error(s.Current, s.Previous)
	}
	if tg, err := s.RollbackTarget(""); err != nil || tg != "aaa" {
		t.Error(tg, err)
	}
	if _, err := s.RollbackTarget("bbb"); err == nil {
		t.Error("rollback to running tag")
	}
	if err := s.Save(p); err != nil {
		t.Fatal(err)
	}
	s2, _ := LoadState(p)
	if s2.Current != "bbb" || s2.Previous != "aaa" || len(s2.History) != 3 {
		t.Errorf("%+v", s2)
	}
	if got := strings.Join(s2.KnownTags(), ","); got != "bbb,aaa" {
		t.Error(got)
	}
	for i := 0; i < 40; i++ {
		s2.Promote("t", "deploy", now)
	}
	if len(s2.History) != historyMax {
		t.Error(len(s2.History))
	}
}

func TestValidate(t *testing.T) {
	good := map[string]string{"POSTGRES_PASSWORD": strings.Repeat("p", 48), "JWT_SECRET": strings.Repeat("j", 64),
		"MCP_TOKEN": "t", "PUBLIC_URL": "https://sickleguard.kasadaai.com", "WEB_PORT": "8310", "ADMIN_PASSWORD": "x",
		"ENVIRONMENT": "production", "SEED_DEMO": "false"}
	if is := Validate("live", good); len(is) != 0 {
		t.Errorf("%+v", is)
	}
	bad := map[string]string{}
	for k, v := range good {
		bad[k] = v
	}
	bad["JWT_SECRET"] = "short"
	bad["SEED_DEMO"] = "true"
	bad["PUBLIC_URL"] = "http://x.org"
	delete(bad, "MCP_TOKEN")
	fatal, warn := 0, 0
	for _, i := range Validate("live", bad) {
		if i.Fatal {
			fatal++
		} else {
			warn++
		}
	}
	if fatal != 2 || warn != 2 {
		t.Errorf("fatal %d warn %d: %+v", fatal, warn, Validate("live", bad))
	}
	bad2 := map[string]string{}
	for k, v := range good {
		bad2[k] = v
	}
	bad2["DOMAIN"] = "bad{"
	if is := Validate("live", bad2); len(is) != 1 || !is[0].Fatal {
		t.Errorf("bad domain: %+v", is)
	}
	good["DOMAIN"] = "sickleguard.kasadaai.com"
	if is := Validate("live", good); len(is) != 0 {
		t.Errorf("%+v", is)
	}
	if len(Validate("test", map[string]string{"SEED_DEMO": "true"})) == 0 {
		t.Error("empty env passes")
	}
}

func TestListAndUsedPorts(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "deploy"), 0o755)
	for n, port := range map[string]string{"live": "8310", "test": "8390", ".": "1"} {
		os.WriteFile(filepath.Join(root, "deploy", n+"env"), []byte("WEB_PORT="+port), 0o600)
	}
	os.WriteFile(filepath.Join(root, "deploy", "live.env"), []byte("WEB_PORT=8310"), 0o600)
	os.WriteFile(filepath.Join(root, "deploy", "test.env"), []byte("WEB_PORT=8390"), 0o600)
	if got := strings.Join(List(root), ","); got != "live,test" {
		t.Error(got)
	}
	read := func(p string) map[string]string {
		b, _ := os.ReadFile(p)
		k, v, _ := strings.Cut(string(b), "=")
		return map[string]string{k: v}
	}
	used := UsedPorts(root, "test", read)
	if used[8310] != "live" || used[8390] != "" {
		t.Errorf("%v", used)
	}
}
