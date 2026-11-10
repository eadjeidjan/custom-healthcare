package envfile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sample = `# comment
ENVIRONMENT=production
export OPENAI_API_KEY=sk-abc
QUOTED="a b # not comment"
SINGLE='x $y'
TRAIL=value # comment
EMPTY=

JWT_SECRET=old
JWT_SECRET=newest
`

func TestParse(t *testing.T) {
	f := Parse(sample)
	cases := map[string]string{"ENVIRONMENT": "production", "OPENAI_API_KEY": "sk-abc", "QUOTED": "a b # not comment",
		"SINGLE": "x $y", "TRAIL": "value", "EMPTY": "", "JWT_SECRET": "newest"}
	for k, want := range cases {
		if got, ok := f.Get(k); !ok || got != want {
			t.Errorf("%s = %q (%v), want %q", k, got, ok, want)
		}
	}
	if _, ok := f.Get("MISSING"); ok {
		t.Error("MISSING found")
	}
	if got := strings.Join(f.Keys(), ","); got != "ENVIRONMENT,OPENAI_API_KEY,QUOTED,SINGLE,TRAIL,EMPTY,JWT_SECRET" {
		t.Errorf("keys %s", got)
	}
}

func TestSetKeepsEverythingElse(t *testing.T) {
	f := Parse(sample)
	changed, err := f.Set("JWT_SECRET", "s3cret")
	if err != nil || !changed {
		t.Fatal(changed, err)
	}
	if v := f.Value("JWT_SECRET"); v != "s3cret" {
		t.Errorf("got %q", v)
	}
	if !strings.HasPrefix(string(f.Bytes()), "# comment\nENVIRONMENT=production\n") {
		t.Error("comment or order lost")
	}
	if c, _ := f.Set("JWT_SECRET", "s3cret"); c {
		t.Error("same value reported as change")
	}
	f.Set("NEW_KEY", "v")
	if !strings.HasSuffix(string(f.Bytes()), "NEW_KEY=v\n") {
		t.Error("new key not appended")
	}
	if _, err := f.Set("BAD KEY", "x"); err == nil {
		t.Error("bad key accepted")
	}
	if _, err := f.Set("K", "two\nlines"); err == nil {
		t.Error("newline accepted")
	}
}

func TestQuoteRoundTrip(t *testing.T) {
	for _, v := range []string{"plain", "with space", "has#hash", "dollar$sign", `it's "quoted" $x`, "", `back\slash`} {
		f := &File{}
		f.Set("K", v)
		if got := Parse(string(f.Bytes())).Value("K"); got != v {
			t.Errorf("round trip %q -> %q (line %s)", v, got, f.Lines[0])
		}
	}
}

func TestSaveKeepsBackupAndMode(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "live.env")
	os.WriteFile(p, []byte("A=1\n"), 0o644)
	f, _ := Load(p)
	f.Set("A", "2")
	if err := f.Save(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p + ".bak"); string(b) != "A=1\n" {
		t.Errorf("bak = %q", b)
	}
	if b, _ := os.ReadFile(p); string(b) != "A=2\n" {
		t.Errorf("file = %q", b)
	}
	if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", st.Mode().Perm())
	}
	missing, _ := Load(filepath.Join(dir, "nope.env"))
	if missing.Exists {
		t.Error("missing file exists")
	}
}

func TestSecretsAndMasking(t *testing.T) {
	for _, k := range []string{"OPENAI_API_KEY", "JWT_SECRET", "MCP_TOKEN", "ADMIN_PASSWORD", "DEMO_PASSWORD", "POSTGRES_PASSWORD"} {
		if !SecretKey(k) {
			t.Errorf("%s not secret", k)
		}
	}
	for _, k := range []string{"PUBLIC_URL", "DOMAIN", "WEB_PORT", "SEED_DEMO", "ADMIN_EMAIL", "CHAT_MODEL"} {
		if SecretKey(k) {
			t.Errorf("%s secret", k)
		}
	}
	key := "sk-proj-" + strings.Repeat("x", 40)
	m := Mask(key)
	if strings.Contains(m, "xxxx") || !strings.HasPrefix(m, "sk-") {
		t.Errorf("mask %q", m)
	}
	if Mask("") != "(empty)" || strings.Contains(Mask("hunter2hunter2"), "hunter") {
		t.Error("mask leaks")
	}
	if Display("PUBLIC_URL", "https://x", false) != "https://x" || Display("JWT_SECRET", "abcdefgh", false) == "abcdefgh" {
		t.Error("display")
	}
	if Display("JWT_SECRET", "abcdefgh", true) != "abcdefgh" {
		t.Error("--show")
	}
}
