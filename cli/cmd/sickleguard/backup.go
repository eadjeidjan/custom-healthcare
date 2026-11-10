package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"sickleguard/cli/internal/backup"
	"sickleguard/cli/internal/evlog"
	"sickleguard/cli/internal/stack"
	"sickleguard/cli/internal/ui"
)

// Volumes holding files (not databases): uploaded files. The risk model is baked into the api image at build
// time (each image tag carries its own model), so it needs no backup.
var fileVolumes = []struct{ Volume, File, Mount string }{
	{"app-data", "data.tar.gz", "/app/data"},
}

func knownVolume(name string) bool {
	for _, v := range fileVolumes {
		if v.Volume == name {
			return true
		}
	}
	return false
}

const qdrant = "http://qdrant:6333"

// qcurl runs curl against Qdrant from the api image: in the running api container, or in a throw-away one.
func (a *App) qcurl(stdin io.Reader, stdout io.Writer, args ...string) error {
	var errb bytes.Buffer
	cmd := append([]string{"curl", "-fsS", "--max-time", "600"}, args...)
	var err error
	if _, ok := a.running()["api"]; ok {
		err = a.Stack.Exec("api", stdin, stdout, &errb, cmd...)
	} else {
		c := a.Stack.Cmd(bgCtx(), append([]string{"run", "--rm", "--no-deps", "-T", "api"}, cmd...)...)
		c.Stdin, c.Stdout, c.Stderr = stdin, stdout, &errb
		err = c.Run()
	}
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(errb.String()))
	}
	return nil
}

func (a *App) qdrantCollections() ([]string, error) {
	var out bytes.Buffer
	if err := a.qcurl(nil, &out, qdrant+"/collections"); err != nil {
		return nil, err
	}
	var r struct {
		Result struct {
			Collections []struct {
				Name string `json:"name"`
			} `json:"collections"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		return nil, err
	}
	var names []string
	for _, c := range r.Result.Collections {
		names = append(names, c.Name)
	}
	return names, nil
}

// snapshotQdrant saves one snapshot file per collection into dir.
func (a *App) snapshotQdrant(dir string, m *backup.Manifest) error {
	cols, err := a.qdrantCollections()
	if err != nil {
		return err
	}
	if len(cols) == 0 {
		ui.Info("qdrant: no collections yet (nothing to snapshot)")
		return nil
	}
	for _, col := range cols {
		var out bytes.Buffer
		if err := a.qcurl(nil, &out, "-X", "POST", qdrant+"/collections/"+url.PathEscape(col)+"/snapshots?wait=true"); err != nil {
			return err
		}
		var r struct {
			Result struct {
				Name string `json:"name"`
			} `json:"result"`
		}
		if err := json.Unmarshal(out.Bytes(), &r); err != nil || r.Result.Name == "" {
			return fmt.Errorf("qdrant snapshot of %s: unexpected answer", col)
		}
		name := "qdrant-" + col + ".snapshot"
		f, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		snapURL := qdrant + "/collections/" + url.PathEscape(col) + "/snapshots/" + url.PathEscape(r.Result.Name)
		err = a.qcurl(nil, f, snapURL)
		f.Close()
		_ = a.qcurl(nil, io.Discard, "-X", "DELETE", snapURL) // don't let snapshots pile up in the volume
		if err != nil {
			return err
		}
		if err := m.AddItem(dir, name, "qdrant-snapshot", col); err != nil {
			return err
		}
		ui.OK("qdrant collection %s", col)
	}
	return nil
}

// tarVolume streams a volume as tar.gz into dir/file (read-only mount, as root to read every file).
func (a *App) tarVolume(volume, dir, file string) error {
	f, err := os.OpenFile(filepath.Join(dir, file), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	return stack.DockerIO(nil, f, "run", "--rm", "--user", "0", "--network", "none", "-v", volume+":/v:ro",
		"--entrypoint", "tar", a.apiImage(), "czf", "-", "-C", "/v", ".")
}

// runBackup takes a backup of the running instance into backups/<instance>-<time>/ and prunes to keep (0 = all).
func runBackup(a *App, reason string, keep int) (string, error) {
	if _, ok := a.running()["db"]; !ok {
		return "", fmt.Errorf("the database container is not running (start the instance first)")
	}
	t := time.Now()
	dir := filepath.Join(a.Inst.BackupsDir(), backup.DirName(a.Inst.Name, t))
	ui.Step("Backup of %s → %s", a.Inst.Name, rel(a.Root, dir))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	_ = os.Chmod(a.Inst.BackupsDir(), 0o700)
	sha, _ := gitInfo(a.Root)
	m := &backup.Manifest{Instance: a.Inst.Name, Project: a.Stack.Project, CreatedAt: t.UTC(), GitCommit: sha,
		ImageTag: a.State.Tag(), CLIVersion: version, Reason: reason}
	fail := func(err error) (string, error) {
		a.Log.Event(evlog.Fail, "backup %s: %v", filepath.Base(dir), err)
		return dir, err
	}

	// Postgres
	f, err := os.OpenFile(filepath.Join(dir, "postgres.sql.gz"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fail(err)
	}
	gz := gzip.NewWriter(f)
	var errb bytes.Buffer
	err = a.Stack.Exec("db", nil, gz, &errb, "sh", "-c", `pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges`)
	cerr := gz.Close()
	f.Close()
	if err != nil {
		return fail(fmt.Errorf("pg_dump: %v: %s", err, strings.TrimSpace(errb.String())))
	}
	if cerr != nil {
		return fail(cerr)
	}
	if err := m.AddItem(dir, "postgres.sql.gz", "postgres", ""); err != nil {
		return fail(err)
	}
	ui.OK("postgres (%s)", humanBytes(m.Items[len(m.Items)-1].Bytes))

	// Qdrant: snapshots through its API; if that fails, the volume as files.
	if err := a.snapshotQdrant(dir, m); err != nil {
		ui.Warn("qdrant snapshot failed (%v); saving the volume instead", err)
		if err := a.tarVolume(a.Stack.Volume("qdrant-data"), dir, "qdrant-volume.tar.gz"); err != nil {
			return fail(err)
		}
		if err := m.AddItem(dir, "qdrant-volume.tar.gz", "qdrant-volume", "copied while running"); err != nil {
			return fail(err)
		}
		ui.OK("qdrant volume")
	}

	// Uploaded files and the model
	for _, v := range fileVolumes {
		vol := a.Stack.Volume(v.Volume)
		if !stack.VolumeExists(vol) {
			ui.Info("%s: no volume yet", v.Mount)
			continue
		}
		if err := a.tarVolume(vol, dir, v.File); err != nil {
			return fail(err)
		}
		if err := m.AddItem(dir, v.File, "volume", v.Volume); err != nil {
			return fail(err)
		}
		ui.OK("%s (%s)", v.Mount, humanBytes(m.Items[len(m.Items)-1].Bytes))
	}

	if err := backup.Write(dir, m); err != nil {
		return fail(err)
	}
	if err := backup.Verify(dir); err != nil {
		return fail(fmt.Errorf("verify: %w", err))
	}
	a.Log.Event(evlog.OK, "backup %s (%s, %d files, %s)", filepath.Base(dir), reason, len(m.Items), humanBytes(m.TotalBytes()))
	ui.OK("backup complete: %s, %s, checksums verified", rel(a.Root, dir), humanBytes(m.TotalBytes()))

	if keep > 0 {
		list, _ := backup.List(a.Inst.BackupsDir(), a.Inst.Name)
		for _, old := range backup.Prune(list, keep) {
			if err := os.RemoveAll(old.Dir); err == nil {
				a.Log.Event(evlog.Info, "retention: removed %s", old.Name)
				ui.Info("removed old backup %s (keeping %d)", old.Name, keep)
			}
		}
	}
	return dir, nil
}

func rel(root, p string) string {
	if r, err := filepath.Rel(root, p); err == nil && !strings.HasPrefix(r, "..") {
		return r
	}
	return p
}

func backupCmd() *cobra.Command {
	var keep int
	c := &cobra.Command{
		Use:   "backup",
		Short: "Back up Postgres, Qdrant and uploaded files into backups/<instance>-<time>/",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			_, err = runBackup(a, "manual", keep)
			return err
		},
	}
	c.Flags().IntVar(&keep, "keep", 0, "keep only the newest N backups of this instance (0: keep all)")
	c.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List this instance's backups",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, false)
			if err != nil {
				return err
			}
			list, err := backup.List(a.Inst.BackupsDir(), a.Inst.Name)
			if err != nil {
				return err
			}
			if len(list) == 0 {
				ui.Info("no backups of %s in backups/", a.Inst.Name)
				return nil
			}
			fmt.Printf("  %-28s %-8s %-10s %-11s %s\n", "BACKUP", "AGE", "SIZE", "REASON", "IMAGE TAG")
			for _, e := range list {
				m, err := backup.Read(e.Dir)
				if err != nil {
					fmt.Printf("  %-28s %-8s %s\n", e.Name, ago(time.Since(e.At)), ui.Red("no manifest"))
					continue
				}
				fmt.Printf("  %-28s %-8s %-10s %-11s %s\n", e.Name, ago(time.Since(e.At)), humanBytes(m.TotalBytes()),
					m.Reason, m.ImageTag)
			}
			return nil
		},
	})
	return c
}

// ---------------------------------------------------------------------------------------------- restore

func (a *App) ensureVolume(name string) error {
	vol := a.Stack.Volume(name)
	if stack.VolumeExists(vol) {
		return nil
	}
	_, err := stack.Docker("volume", "create", "--label", "com.docker.compose.project="+a.Stack.Project,
		"--label", "com.docker.compose.volume="+name, vol)
	return err
}

// untarVolume replaces the content of a volume with dir/file.
func (a *App) untarVolume(name, dir, file string) error {
	if err := a.ensureVolume(name); err != nil {
		return err
	}
	f, err := os.Open(filepath.Join(dir, file))
	if err != nil {
		return err
	}
	defer f.Close()
	return stack.DockerIO(f, nil, "run", "--rm", "-i", "--user", "0", "--network", "none", "-v",
		a.Stack.Volume(name)+":/v", "--entrypoint", "sh", a.apiImage(), "-c",
		"find /v -mindepth 1 -delete && tar xzf - -C /v")
}

func restoreCmd() *cobra.Command {
	var confirm string
	var noSafety bool
	c := &cobra.Command{
		Use:   "restore <backup-dir>",
		Short: "Restore a backup into this instance (asks you to type the instance name)",
		Long: `Restore a backup folder (path, or its name under backups/) into this instance: checks the checksums,
takes a safety backup of the current data, stops api/mcp/web, replaces Postgres, Qdrant and the uploaded files,
and starts everything again. Restoring another instance's backup (e.g. live into a drill instance) works.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			t0 := time.Now()
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			dir := args[0]
			if _, err := os.Stat(dir); err != nil {
				dir = filepath.Join(a.Inst.BackupsDir(), args[0])
			}
			dir, _ = filepath.Abs(dir)
			ui.Step("Checking %s", rel(a.Root, dir))
			if err := backup.Verify(dir); err != nil {
				return fmt.Errorf("backup is not usable: %w", err)
			}
			m, _ := backup.Read(dir)
			ui.OK("checksums verified: %d files, %s, taken %s from instance %s (image %s)", len(m.Items),
				humanBytes(m.TotalBytes()), m.CreatedAt.Local().Format("2006-01-02 15:04"), m.Instance, m.ImageTag)
			if m.Instance != a.Inst.Name {
				ui.Warn("this backup comes from instance %s, not %s", m.Instance, a.Inst.Name)
			}
			if confirm != "" {
				if confirm != a.Inst.Name {
					return fmt.Errorf("--confirm %q does not match the instance name", confirm)
				}
			} else if err := ui.TypedConfirm(fmt.Sprintf("This REPLACES all data of instance %s.", a.Inst.Name), a.Inst.Name, false); err != nil {
				return err
			}
			a.Log.Event(evlog.Info, "restore from %s started", filepath.Base(dir))

			if !noSafety {
				if _, err := runBackup(a, "pre-restore", 0); err != nil {
					ui.Warn("safety backup failed: %v", err)
					if !ui.Confirm("Continue the restore without a safety backup?") {
						return ui.ErrAborted
					}
				}
			}
			fail := func(err error) error {
				a.Log.Event(evlog.Fail, "restore from %s: %v", filepath.Base(dir), err)
				return fmt.Errorf("%w\n  the app is stopped; fix and run restore again, or `sickleguard --instance %s deploy --no-build`",
					err, a.Inst.Name)
			}

			ui.Step("Stopping web, mcp and api")
			if err := a.Stack.RunQuiet("stop", "web", "mcp", "api"); err != nil {
				return fail(err)
			}
			if err := a.Stack.RunQuiet("up", "-d", "--wait", "db", "qdrant"); err != nil {
				return fail(err)
			}

			// Postgres: empty the schema, then load the dump.
			ui.Step("Restoring")
			psql := `psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"`
			var errb bytes.Buffer
			if err := a.Stack.Exec("db", nil, io.Discard, &errb, "sh", "-c",
				psql+` -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'`); err != nil {
				return fail(fmt.Errorf("reset database: %v: %s", err, strings.TrimSpace(errb.String())))
			}
			for _, it := range m.Find("postgres") {
				f, err := os.Open(filepath.Join(dir, it.Name))
				if err != nil {
					return fail(err)
				}
				zr, err := gzip.NewReader(f)
				if err != nil {
					f.Close()
					return fail(err)
				}
				errb.Reset()
				err = a.Stack.Exec("db", zr, io.Discard, &errb, "sh", "-c", psql)
				f.Close()
				if err != nil {
					return fail(fmt.Errorf("load database: %v: %s", err, lastLine(errb.String())))
				}
				ui.OK("postgres")
			}

			// Qdrant
			for _, it := range m.Find("qdrant-snapshot") {
				f, err := os.Open(filepath.Join(dir, it.Name))
				if err != nil {
					return fail(err)
				}
				err = a.qcurl(f, io.Discard, "-X", "POST", "-F", "snapshot=@-",
					qdrant+"/collections/"+url.PathEscape(it.Note)+"/snapshots/upload?priority=snapshot&wait=true")
				f.Close()
				if err != nil {
					return fail(fmt.Errorf("qdrant %s: %w", it.Note, err))
				}
				ui.OK("qdrant collection %s", it.Note)
			}
			for _, it := range m.Find("qdrant-volume") {
				if err := a.Stack.RunQuiet("stop", "qdrant"); err != nil {
					return fail(err)
				}
				if err := a.untarVolume("qdrant-data", dir, it.Name); err != nil {
					return fail(err)
				}
				ui.OK("qdrant volume")
			}

			// Files
			for _, it := range m.Find("volume") {
				if !knownVolume(it.Note) {
					ui.Info("skipped %s (%s is no longer a volume)", it.Name, it.Note)
					continue
				}
				if err := a.untarVolume(it.Note, dir, it.Name); err != nil {
					return fail(fmt.Errorf("%s: %w", it.Note, err))
				}
				ui.OK("volume %s", it.Note)
			}

			if _, err := a.start(a.State.Tag()); err != nil {
				return fail(err)
			}
			a.Log.Event(evlog.OK, "restored %s into %s", filepath.Base(dir), a.Inst.Name)
			ui.Step("Restore complete in %s", ago(time.Since(t0)))
			return nil
		},
	}
	c.Flags().StringVar(&confirm, "confirm", "", "instance name, to confirm without a terminal")
	c.Flags().BoolVar(&noSafety, "no-safety-backup", false, "don't back up the current data first")
	return c
}
