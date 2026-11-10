// Package backup describes a backup folder backups/<instance>-<YYYYMMDD-HHMMSS>/: its manifest (manifest.json),
// SHA-256 checksums (SHA256SUMS, `sha256sum -c` compatible), listing and retention.
package backup

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	ManifestName = "manifest.json"
	SumsName     = "SHA256SUMS"
	stampLayout  = "20060102-150405"
)

// Item is one file of a backup.
type Item struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"` // postgres | qdrant-snapshot | qdrant-volume | volume
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	Note   string `json:"note,omitempty"`
}

// Manifest is manifest.json.
type Manifest struct {
	Format     int       `json:"format"`
	Instance   string    `json:"instance"`
	Project    string    `json:"project"`
	CreatedAt  time.Time `json:"created_at"`
	GitCommit  string    `json:"git_commit"`
	ImageTag   string    `json:"image_tag"`
	CLIVersion string    `json:"cli_version"`
	Reason     string    `json:"reason,omitempty"` // manual | update | pre-restore
	Items      []Item    `json:"items"`
}

// DirName is the folder name of a backup of instance taken at t.
func DirName(instance string, t time.Time) string {
	return instance + "-" + t.UTC().Format(stampLayout)
}

// ParseDirName returns the time of a backup folder of instance, or ok=false for anything else (another
// instance whose name shares the prefix, stray folders).
func ParseDirName(instance, name string) (time.Time, bool) {
	re := regexp.MustCompile(`^` + regexp.QuoteMeta(instance) + `-(\d{8}-\d{6})$`)
	m := re.FindStringSubmatch(name)
	if m == nil {
		return time.Time{}, false
	}
	t, err := time.Parse(stampLayout, m[1])
	return t, err == nil
}

// HashFile returns the size and SHA-256 of a file in dir.
func HashFile(dir, name string) (int64, string, error) {
	f, err := os.Open(filepath.Join(dir, name))
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(h.Sum(nil)), nil
}

// AddItem hashes dir/name and appends it to the manifest.
func (m *Manifest) AddItem(dir, name, kind, note string) error {
	n, sum, err := HashFile(dir, name)
	if err != nil {
		return err
	}
	m.Items = append(m.Items, Item{Name: name, Kind: kind, Bytes: n, SHA256: sum, Note: note})
	return nil
}

// Item returns the item with this kind, if any.
func (m *Manifest) Find(kind string) []Item {
	var out []Item
	for _, it := range m.Items {
		if it.Kind == kind {
			out = append(out, it)
		}
	}
	return out
}

// TotalBytes is the size of all items.
func (m *Manifest) TotalBytes() int64 {
	var t int64
	for _, it := range m.Items {
		t += it.Bytes
	}
	return t
}

// Write saves manifest.json and SHA256SUMS in dir (mode 0600: backups hold patient data).
func Write(dir string, m *Manifest) error {
	if m.Format == 0 {
		m.Format = 1
	}
	data, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, ManifestName), append(data, '\n'), 0o600); err != nil {
		return err
	}
	var b strings.Builder
	for _, it := range m.Items {
		fmt.Fprintf(&b, "%s  %s\n", it.SHA256, it.Name)
	}
	return os.WriteFile(filepath.Join(dir, SumsName), []byte(b.String()), 0o600)
}

// Read loads dir/manifest.json.
func Read(dir string) (*Manifest, error) {
	data, err := os.ReadFile(filepath.Join(dir, ManifestName))
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", ManifestName, err)
	}
	return &m, nil
}

// Verify checks every file listed in SHA256SUMS (and that the manifest agrees with it).
func Verify(dir string) error {
	m, err := Read(dir)
	if err != nil {
		return err
	}
	f, err := os.Open(filepath.Join(dir, SumsName))
	if err != nil {
		return err
	}
	defer f.Close()
	sums := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		parts := strings.SplitN(strings.TrimSpace(sc.Text()), "  ", 2)
		if len(parts) == 2 {
			sums[parts[1]] = parts[0]
		}
	}
	if len(m.Items) == 0 {
		return errors.New("the manifest lists no files")
	}
	for _, it := range m.Items {
		if strings.ContainsAny(it.Name, `/\`) || it.Name == ".." {
			return fmt.Errorf("%s: unexpected file name", it.Name)
		}
		if sums[it.Name] != it.SHA256 {
			return fmt.Errorf("%s: SHA256SUMS and manifest disagree", it.Name)
		}
		n, sum, err := HashFile(dir, it.Name)
		if err != nil {
			return fmt.Errorf("%s: %w", it.Name, err)
		}
		if sum != it.SHA256 || n != it.Bytes {
			return fmt.Errorf("%s: checksum mismatch (file changed or truncated)", it.Name)
		}
	}
	return nil
}

// Entry is a backup folder found on disk.
type Entry struct {
	Dir  string
	Name string
	At   time.Time
}

// List returns the backups of instance in root, newest first.
func List(root, instance string) ([]Entry, error) {
	des, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Entry
	for _, de := range des {
		if !de.IsDir() {
			continue
		}
		if t, ok := ParseDirName(instance, de.Name()); ok {
			out = append(out, Entry{Dir: filepath.Join(root, de.Name()), Name: de.Name(), At: t})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	return out, nil
}

// Prune returns the entries to delete so that only the newest keep remain (keep <= 0 keeps everything).
// entries must be newest first, as List returns them.
func Prune(entries []Entry, keep int) []Entry {
	if keep <= 0 || len(entries) <= keep {
		return nil
	}
	return entries[keep:]
}
