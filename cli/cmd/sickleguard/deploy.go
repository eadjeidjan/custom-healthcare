package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"sickleguard/cli/internal/evlog"
	"sickleguard/cli/internal/instance"
	"sickleguard/cli/internal/stack"
	"sickleguard/cli/internal/ui"
)

const healthTimeout = 4 * time.Minute

// validateSettings prints the settings issues and fails on fatal ones.
func (a *App) validateSettings() error {
	fatal := 0
	for _, is := range instance.Validate(a.Inst.Name, a.Env.Map()) {
		if is.Fatal {
			fatal++
			ui.Fail("%s", is.Msg)
		} else {
			ui.Warn("%s", is.Msg)
		}
	}
	if fatal > 0 {
		return fmt.Errorf("fix %s first (sickleguard --instance %s env set KEY)", a.Inst.RelEnvPath(), a.Inst.Name)
	}
	return nil
}

// build builds the api and web images as tag (and latest).
func (a *App) build(tag string) error {
	ui.Step("Building images sg-api:%s and sg-web:%s", tag, tag)
	s := a.withTag(tag)
	if err := s.Run("build", "api", "web"); err != nil {
		return fmt.Errorf("build failed: %w", err)
	}
	for _, img := range []string{"sg-api", "sg-web"} {
		if _, err := stack.Docker("tag", img+":"+tag, img+":latest"); err != nil {
			return err
		}
	}
	ui.OK("built %s", tag)
	return nil
}

func imagesExist(tag string) error {
	for _, img := range []string{"sg-api", "sg-web"} {
		if !stack.ImageExists(img + ":" + tag) {
			return fmt.Errorf("image %s:%s is not on this host (removed by docker prune?)", img, tag)
		}
	}
	return nil
}

// start runs the stack with tag and waits for health and the smoke test.
func (a *App) start(tag string) (*Health, error) {
	ui.Step("Starting %s with image tag %s", a.Stack.Project, tag)
	s := a.withTag(tag)
	if err := s.Run("up", "-d", "--wait", "--wait-timeout", "300", "--remove-orphans"); err != nil {
		return nil, fmt.Errorf("containers did not become healthy: %w (see `sickleguard --instance %s logs api`)", err, a.Inst.Name)
	}
	ui.OK("containers up")
	h, err := waitHealth(a.localURL(), healthTimeout)
	if err != nil {
		return nil, err
	}
	ui.OK("health: version %s, model %s, OpenAI %s, Qdrant %s, MCP %s", h.Version, h.Model.Version,
		onoff(h.OpenAI), onoff(h.Qdrant), onoff(h.MCP))
	warn, err := a.smoke(a.localURL())
	if err != nil {
		return h, fmt.Errorf("smoke test failed: %w", err)
	}
	if warn != "" {
		ui.Warn("%s", warn)
	} else {
		ui.OK("smoke test: admin sign-in and dashboard work")
	}
	return h, nil
}

func onoff(b bool) string {
	if b {
		return ui.Green("on")
	}
	return ui.Yellow("off")
}

// trainIfMissing runs `python -m app.train --if-missing` when the image's app.train supports that flag (otherwise
// the app trains a missing model itself on start). Failures are warnings.
func (a *App) trainIfMissing(tag string) {
	s := a.withTag(tag)
	var help bytes.Buffer
	if err := s.Exec("api", nil, &help, io.Discard, "python", "-m", "app.train", "--help"); err != nil ||
		!strings.Contains(help.String(), "--if-missing") {
		return // no app.train, or one without --if-missing: the app trains a missing model on start
	}
	var out bytes.Buffer
	if err := s.Exec("api", nil, &out, &out, "python", "-m", "app.train", "--if-missing"); err != nil {
		ui.Warn("model check (python -m app.train --if-missing) failed: %s", lastLine(out.String()))
		return
	}
	if l := lastLine(out.String()); l != "" {
		ui.Info("model: %s", l)
	}
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func (a *App) record(tag, action string) error {
	a.State.Promote(tag, action, time.Now())
	a.Stack.Tag = tag
	return a.State.Save(a.Inst.StatePath())
}

func (a *App) done(start time.Time) {
	ui.Step("SickleGuard %s is up: %s", a.Inst.Name, a.publicURL())
	ui.Info("local: %s   took %s", a.localURL(), ago(time.Since(start)))
}

func deployCmd() *cobra.Command {
	var noBuild, noTrain bool
	var tag string
	c := &cobra.Command{
		Use:   "deploy",
		Short: "Build images (tagged with the git SHA), start the stack, wait for health and run a smoke test",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			t0 := time.Now()
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			if err := a.validateSettings(); err != nil {
				return err
			}
			switch {
			case tag != "":
				if !instance.ValidTag(tag) {
					return fmt.Errorf("%q is not a valid tag", tag)
				}
			case noBuild:
				tag = a.State.Tag()
			default:
				tag = newTag(a.Root)
			}
			a.Log.Event(evlog.Info, "deploy %s (build %v)", tag, !noBuild)
			if !noBuild {
				if err := a.build(tag); err != nil {
					a.Log.Event(evlog.Fail, "%v", err)
					return err
				}
			} else if err := imagesExist(tag); err != nil {
				return err
			}
			if _, err := a.start(tag); err != nil {
				a.Log.Event(evlog.Fail, "deploy %s: %v", tag, err)
				return err
			}
			if err := a.record(tag, "deploy"); err != nil {
				return err
			}
			if !noTrain {
				a.trainIfMissing(tag)
			}
			a.Log.Event(evlog.OK, "deployed %s", tag)
			if err := a.syncKasada(); err != nil {
				ui.Fail("%v", err)
				ui.Info("the app runs on %s; fix the front proxy and run `sickleguard edge sync`", a.localURL())
				return errQuiet
			}
			a.done(t0)
			return nil
		},
	}
	c.Flags().BoolVar(&noBuild, "no-build", false, "use the images already built (the running tag, or --tag)")
	c.Flags().StringVar(&tag, "tag", "", "image tag to build or run (default: git short SHA)")
	c.Flags().BoolVar(&noTrain, "no-train", false, "skip `python -m app.train --if-missing` after the deploy")
	return c
}

func updateCmd() *cobra.Command {
	var noPull, noBackup, simulateFailure, askPAT bool
	c := &cobra.Command{
		Use:   "update",
		Short: "git pull --ff-only, back up, deploy the new code; roll back automatically if it is unhealthy",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			t0 := time.Now()
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			if err := a.validateSettings(); err != nil {
				return err
			}
			prev := a.State.Current
			if !noPull {
				ui.Step("Pulling the latest code")
				before, _ := gitOut(a.Root, "rev-parse", "--short", "HEAD")
				pat := os.Getenv("SICKLEGUARD_GIT_PAT")
				if pat == "" && askPAT {
					if pat, err = ui.AskSecret("Azure DevOps personal access token (Code: Read)"); err != nil {
						return err
					}
				}
				a.Log.Register(pat)
				if err := runGit(a.Root, pat, "pull", "--ff-only"); err != nil {
					a.Log.Event(evlog.Fail, "git pull --ff-only failed")
					return fmt.Errorf("git pull --ff-only failed (local changes or diverged history; never reset on the server — see docs/DEPLOY.md)")
				}
				after, _ := gitOut(a.Root, "rev-parse", "--short", "HEAD")
				a.Log.Event(evlog.Info, "git %s -> %s", before, after)
				ui.OK("code %s → %s", before, after)
			}
			if !noBackup {
				if len(a.running()) > 0 {
					if _, err := runBackup(a, "update", 0); err != nil {
						a.Log.Event(evlog.Fail, "pre-update backup failed: %v", err)
						return fmt.Errorf("backup before the update failed (nothing changed): %w", err)
					}
				} else {
					ui.Warn("stack not running: no backup taken")
				}
			}
			tag := newTag(a.Root)
			a.Log.Event(evlog.Info, "update %s -> %s", orNone(prev), tag)
			if err := a.build(tag); err != nil {
				a.Log.Event(evlog.Fail, "%v", err)
				return err // the old containers are still running
			}
			_, err = a.start(tag)
			if err == nil && simulateFailure {
				err = errors.New("simulated failure (--simulate-failure)")
			}
			if err == nil {
				if err := a.record(tag, "update"); err != nil {
					return err
				}
				a.trainIfMissing(tag)
				a.Log.Event(evlog.OK, "updated to %s", tag)
				if err := a.syncKasada(); err != nil {
					ui.Fail("%v", err)
					return errQuiet
				}
				a.done(t0)
				return nil
			}
			ui.Fail("%v", err)
			a.Log.Event(evlog.Fail, "update to %s failed: %v", tag, err)
			if prev == "" || imagesExist(prev) != nil {
				ui.Fail("no previous image to roll back to; fix and deploy again (backups: sickleguard backup list)")
				return errQuiet
			}
			ui.Step("Rolling back to %s", prev)
			a.State.History = append(a.State.History, instance.Entry{Tag: tag, Action: "failed", At: time.Now().UTC()})
			if _, rerr := a.start(prev); rerr != nil {
				a.Log.Event(evlog.Fail, "auto-rollback to %s failed: %v", prev, rerr)
				_ = a.State.Save(a.Inst.StatePath())
				return fmt.Errorf("rollback to %s also failed: %w (restore a backup: sickleguard restore <dir>)", prev, rerr)
			}
			a.State.Current = prev
			a.State.History = append(a.State.History, instance.Entry{Tag: prev, Action: "auto-rollback", At: time.Now().UTC()})
			if err := a.State.Save(a.Inst.StatePath()); err != nil {
				return err
			}
			a.Log.Event(evlog.Warn, "rolled back to %s after failed update to %s", prev, tag)
			ui.Warn("update failed and was rolled back to %s; the database was not changed back (restore a backup if the new code changed it)", prev)
			return errQuiet
		},
	}
	c.Flags().BoolVar(&noPull, "no-pull", false, "deploy the code as it is (no git pull)")
	c.Flags().BoolVar(&askPAT, "ask-pat", false, "ask (hidden) for an Azure DevOps token for the pull; or set SICKLEGUARD_GIT_PAT")
	c.Flags().BoolVar(&noBackup, "no-backup", false, "skip the backup before the update")
	c.Flags().BoolVar(&simulateFailure, "simulate-failure", false, "treat the new version as failed (tests the automatic rollback)")
	_ = c.Flags().MarkHidden("simulate-failure")
	return c
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

func rollbackCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rollback [tag]",
		Short: "Run the previous image tag again (or the tag given)",
		Long: `Run the previous image tag again (recorded in deploy/logs/<instance>.state), or the tag given.
Only the code goes back: the database stays as it is (restore a backup for that).`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			t0 := time.Now()
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			want := ""
			if len(args) == 1 {
				want = args[0]
			}
			tag, err := a.State.RollbackTarget(want)
			if err != nil {
				return err
			}
			if err := imagesExist(tag); err != nil {
				return err
			}
			if !ui.Confirm(fmt.Sprintf("Roll %s back from %s to %s?", a.Inst.Name, orNone(a.State.Current), tag)) {
				return ui.ErrAborted
			}
			from := a.State.Current
			if _, err := a.start(tag); err != nil {
				a.Log.Event(evlog.Fail, "rollback to %s: %v", tag, err)
				return err
			}
			if err := a.record(tag, "rollback"); err != nil {
				return err
			}
			a.Log.Event(evlog.OK, "rolled back %s -> %s", orNone(from), tag)
			a.done(t0)
			return nil
		},
	}
}

// runGit runs git in the repository with output to the terminal. pat (an Azure DevOps personal access token) is
// handed to git for this one command through GIT_CONFIG_* environment variables: never saved, never in argv.
func runGit(root, pat string, args ...string) error {
	c := exec.Command("git", append([]string{"-C", root}, args...)...)
	c.Stdout, c.Stderr = os.Stdout, os.Stderr
	if pat != "" {
		c.Env = append(os.Environ(), gitAuthEnv(pat)...)
	}
	return c.Run()
}

func gitAuthEnv(pat string) []string {
	basic := base64.StdEncoding.EncodeToString([]byte(":" + pat))
	return []string{"GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=http.extraHeader",
		"GIT_CONFIG_VALUE_0=Authorization: Basic " + basic, "GIT_TERMINAL_PROMPT=0"}
}
