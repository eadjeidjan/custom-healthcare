package backup

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDirNames(t *testing.T) {
	at := time.Date(2026, 11, 10, 14, 3, 9, 0, time.UTC)
	n := DirName("live", at)
	if n != "live-20261110-140309" {
		t.Fatal(n)
	}
	if got, ok := ParseDirName("live", n); !ok || !got.Equal(at) {
		t.Error(got, ok)
	}
	for _, bad := range []string{"live2-20261110-140309", "live-2026", "test-20261110-140309", "live-20261110-140309x"} {
		if _, ok := ParseDirName("live", bad); ok {
			t.Errorf("%s matched", bad)
		}
	}
}

func TestManifestVerify(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "postgres.sql.gz"), []byte("dump"), 0o600)
	os.WriteFile(filepath.Join(dir, "data.tar.gz"), []byte("files"), 0o600)
	m := &Manifest{Instance: "test", CreatedAt: time.Now()}
	if err := m.AddItem(dir, "postgres.sql.gz", "postgres", ""); err != nil {
		t.Fatal(err)
	}
	m.AddItem(dir, "data.tar.gz", "volume", "app-data")
	if err := Write(dir, m); err != nil {
		t.Fatal(err)
	}
	if err := Verify(dir); err != nil {
		t.Fatal(err)
	}
	r, _ := Read(dir)
	if r.Format != 1 || r.TotalBytes() != 9 || len(r.Find("volume")) != 1 || r.Find("volume")[0].Note != "app-data" {
		t.Errorf("%+v", r)
	}
	if st, _ := os.Stat(filepath.Join(dir, ManifestName)); st.Mode().Perm() != 0o600 {
		t.Error("manifest readable by others")
	}
	os.WriteFile(filepath.Join(dir, "data.tar.gz"), []byte("FILES"), 0o600)
	if Verify(dir) == nil {
		t.Error("tampered file verified")
	}
	if Verify(t.TempDir()) == nil {
		t.Error("empty dir verified")
	}
}

func TestListAndPrune(t *testing.T) {
	root := t.TempDir()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 5; i++ {
		os.MkdirAll(filepath.Join(root, DirName("live", base.Add(time.Duration(i)*time.Hour))), 0o700)
	}
	os.MkdirAll(filepath.Join(root, DirName("live2", base)), 0o700)
	os.MkdirAll(filepath.Join(root, "random"), 0o700)
	list, err := List(root, "live")
	if err != nil || len(list) != 5 {
		t.Fatal(len(list), err)
	}
	if !list[0].At.After(list[4].At) {
		t.Error("not newest first")
	}
	del := Prune(list, 2)
	if len(del) != 3 || del[0].Name != list[2].Name {
		t.Error(del)
	}
	if Prune(list, 0) != nil || Prune(list, 9) != nil {
		t.Error("keep 0 / large keep deletes")
	}
	if l, _ := List(filepath.Join(root, "missing"), "live"); l != nil {
		t.Error("missing root")
	}
}
