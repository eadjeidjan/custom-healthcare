package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"

	"sickleguard/cli/internal/evlog"
	"sickleguard/cli/internal/ui"
)

var roles = []string{"admin", "clinician", "patient", "policy"}

func validRole(r string) error {
	for _, v := range roles {
		if v == r {
			return nil
		}
	}
	return fmt.Errorf("role %q: use one of %s", r, strings.Join(roles, ", "))
}

// py runs `python <args>` in the api container, streaming output; stdin feeds e.g. a password.
// It returns the captured stderr too, to recognise "No module named ...".
func (a *App) py(stdin io.Reader, args ...string) (string, error) {
	if err := a.needRunning("api"); err != nil {
		return "", err
	}
	var errb bytes.Buffer
	err := a.Stack.Exec("api", stdin, os.Stdout, io.MultiWriter(os.Stderr, &errb), append([]string{"python"}, args...)...)
	return errb.String(), err
}

func exitCode(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

func missingModule(stderr, mod string) bool {
	return strings.Contains(stderr, "No module named "+mod) || strings.Contains(stderr, "No module named '"+mod+"'")
}

// manage runs `python -m app.manage <args>`.
func (a *App) manage(stdin io.Reader, logMsg string, args ...string) error {
	stderr, err := a.py(stdin, append([]string{"-m", "app.manage"}, args...)...)
	if err != nil {
		if missingModule(stderr, "app.manage") {
			return errors.New("this image has no app.manage yet: deploy the current code first")
		}
		a.Log.Event(evlog.Fail, "%s", logMsg)
		return errQuiet
	}
	if logMsg != "" {
		a.Log.Event(evlog.OK, "%s", logMsg)
	}
	return nil
}

// askNewPassword asks twice (hidden). Empty means "generate one". --yes generates.
func askNewPassword() (string, error) {
	if ui.Yes || !ui.Interactive() {
		return "", nil
	}
	p1, err := ui.AskSecret("New password (Enter to generate one)")
	if err != nil || p1 == "" {
		return "", err
	}
	if len(p1) < 10 {
		return "", errors.New("use at least 10 characters")
	}
	p2, err := ui.AskSecret("Repeat the password")
	if err != nil {
		return "", err
	}
	if p1 != p2 {
		return "", errors.New("the passwords differ")
	}
	return p1, nil
}

func usersCmd() *cobra.Command {
	c := &cobra.Command{Use: "users", Short: "Manage sign-in accounts (runs app.manage in the api container)"}
	run := func(fn func(a *App, args []string) error) func(*cobra.Command, []string) error {
		return func(cmd *cobra.Command, args []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			return fn(a, args)
		}
	}

	c.AddCommand(&cobra.Command{
		Use: "list", Short: "List accounts", Args: cobra.NoArgs,
		RunE: run(func(a *App, _ []string) error { return a.manage(nil, "", "list") }),
	})

	var name, role, mrn string
	create := &cobra.Command{
		Use:   "create <email>",
		Short: "Create an account (password: hidden prompt, or generated and shown once)",
		Args:  cobra.ExactArgs(1),
		RunE: run(func(a *App, args []string) error {
			if err := validRole(role); err != nil {
				return err
			}
			if role == "patient" && mrn == "" {
				return errors.New("a patient account needs --mrn (the patient's record number)")
			}
			pw, err := askNewPassword()
			if err != nil {
				return err
			}
			margs := []string{"create", args[0], "--role", role}
			if name != "" {
				margs = append(margs, "--name", name)
			}
			if mrn != "" {
				margs = append(margs, "--mrn", mrn)
			}
			var stdin io.Reader
			if pw != "" {
				margs = append(margs, "--password-stdin")
				stdin = strings.NewReader(pw + "\n")
			}
			return a.manage(stdin, fmt.Sprintf("users create %s (%s)", args[0], role), margs...)
		}),
	}
	create.Flags().StringVar(&name, "name", "", "display name")
	create.Flags().StringVar(&role, "role", "clinician", "admin | clinician | patient | policy")
	create.Flags().StringVar(&mrn, "mrn", "", "patient record number (role patient)")
	c.AddCommand(create)

	c.AddCommand(&cobra.Command{
		Use: "set-role <email> <role>", Short: "Change an account's role", Args: cobra.ExactArgs(2),
		RunE: run(func(a *App, args []string) error {
			if err := validRole(args[1]); err != nil {
				return err
			}
			return a.manage(nil, fmt.Sprintf("users set-role %s %s", args[0], args[1]), "set-role", args[0], args[1])
		}),
	})
	c.AddCommand(&cobra.Command{
		Use: "reset-password <email>", Short: "Set a new password (hidden prompt, or generated and shown once)",
		Args: cobra.ExactArgs(1),
		RunE: run(func(a *App, args []string) error {
			pw, err := askNewPassword()
			if err != nil {
				return err
			}
			margs := []string{"reset-password", args[0]}
			var stdin io.Reader
			if pw != "" {
				margs = append(margs, "--password-stdin")
				stdin = strings.NewReader(pw + "\n")
			}
			return a.manage(stdin, "users reset-password "+args[0], margs...)
		}),
	})
	c.AddCommand(&cobra.Command{
		Use: "link-patient <email> <mrn>", Short: "Link a patient account to a patient record (by MRN)",
		Args: cobra.ExactArgs(2),
		RunE: run(func(a *App, args []string) error {
			return a.manage(nil, fmt.Sprintf("users link-patient %s %s", args[0], args[1]), "link-patient", args[0], args[1])
		}),
	})
	c.AddCommand(&cobra.Command{
		Use: "disable <email>", Short: "Stop an account from signing in", Args: cobra.ExactArgs(1),
		RunE: run(func(a *App, args []string) error {
			if !ui.Confirm(fmt.Sprintf("Disable %s on %s?", args[0], a.Inst.Name)) {
				return ui.ErrAborted
			}
			return a.manage(nil, "users disable "+args[0], "disable", args[0])
		}),
	})
	c.AddCommand(&cobra.Command{
		Use: "enable <email>", Short: "Allow a disabled account to sign in again", Args: cobra.ExactArgs(1),
		RunE: run(func(a *App, args []string) error {
			return a.manage(nil, "users enable "+args[0], "enable", args[0])
		}),
	})
	return c
}

func modelCmd() *cobra.Command {
	c := &cobra.Command{Use: "model", Short: "The VOC risk model: train it, show its card"}
	c.AddCommand(&cobra.Command{
		Use:   "train [-- train options]",
		Short: "Retrain the risk model in the running api container (python -m app.train), then reload api and mcp",
		Long: `Retrain the model inside the running api container and restart api and mcp to load it. The image already
ships a model trained at build time; a retrained one lasts until the containers are recreated (deploy, update,
rollback). To make a change permanent, change the training code and deploy.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			if !contains(args, "--no-report") { // the report belongs in the repository (docs/), not in the container
				args = append(args, "--no-report")
			}
			ui.Step("Training the model on %s", a.Inst.Name)
			a.Log.Event(evlog.Info, "model train %s", strings.Join(args, " "))
			stderr, err := a.py(nil, append([]string{"-m", "app.train"}, args...)...)
			if err != nil {
				if missingModule(stderr, "app.train") {
					ui.Warn("this image has no app.train yet (deploy newer code). The model trains itself on first start when missing.")
					a.Log.Event(evlog.Warn, "model train: app.train not in the image")
					return errQuiet
				}
				a.Log.Event(evlog.Fail, "model train failed (exit %d)", exitCode(err))
				return errQuiet
			}
			a.Log.Event(evlog.OK, "model trained")
			ui.OK("model trained")
			// mcp scores with its own copy of /app/models: give it the new model.
			if _, ok := a.running()["mcp"]; ok {
				tmp, err := os.MkdirTemp("", "sickleguard-model-")
				if err != nil {
					return err
				}
				defer os.RemoveAll(tmp)
				if err := a.Stack.RunQuiet("cp", "api:/app/models/.", tmp); err != nil {
					return fmt.Errorf("copy the model from api: %w", err)
				}
				if err := a.Stack.RunQuiet("cp", tmp+"/.", "mcp:/app/models/"); err != nil {
					return fmt.Errorf("copy the model to mcp: %w", err)
				}
			}
			if ui.Confirm("Restart api and mcp so they load the new model?") {
				if err := a.Stack.Run("restart", "api", "mcp"); err != nil {
					return err
				}
				if _, err := waitHealth(a.localURL(), healthTimeout); err != nil {
					return err
				}
				a.Log.Event(evlog.OK, "api and mcp restarted for the new model")
				ui.OK("api and mcp use the new model")
			} else {
				ui.Info("the running app keeps the old model until `sickleguard restart api` and `restart mcp`")
			}
			return nil
		},
	})
	c.AddCommand(&cobra.Command{
		Use: "status", Short: "Show the model card summary", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			h, err := health(a.localURL())
			if err != nil {
				return fmt.Errorf("API not reachable: %w", err)
			}
			ui.Step("Model on %s", a.Inst.Name)
			ui.Info("version %s · AUC %.3f", h.Model.Version, h.Model.AUC)
			tok, err := login(a.localURL(), a.Env.Value("ADMIN_EMAIL"), a.Env.Value("ADMIN_PASSWORD"))
			if err != nil {
				ui.Warn("model card needs an admin sign-in (%v)", err)
				return nil
			}
			var card struct {
				TrainedAt    string   `json:"trained_at"`
				TrainingRows int      `json:"training_rows"`
				PositiveRate float64  `json:"positive_rate"`
				AUC          float64  `json:"auc"`
				Brier        float64  `json:"brier"`
				DataNote     string   `json:"data_note"`
				Limitations  []string `json:"limitations"`
				Features     []any    `json:"features"`
			}
			if _, err := getJSON(a.localURL()+"/api/v1/model", tok, &card); err != nil {
				return err
			}
			ui.Info("trained %s on %d rows (positive rate %.1f%%) · Brier %.3f · %d features", card.TrainedAt,
				card.TrainingRows, card.PositiveRate*100, card.Brier, len(card.Features))
			if len(card.Limitations) > 0 {
				ui.Warn("%s", card.Limitations[0])
			}
			return nil
		},
	})
	return c
}

func knowledgeCmd() *cobra.Command {
	c := &cobra.Command{Use: "knowledge", Short: "The guidance library used for answers (RAG)"}
	c.AddCommand(&cobra.Command{
		Use: "reindex", Short: "Re-index the bundled guidance into Qdrant (e.g. after adding the OpenAI key)",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			return a.manage(nil, "knowledge reindex", "reindex-knowledge")
		},
	})
	return c
}

func demoCmd() *cobra.Command {
	c := &cobra.Command{Use: "demo", Short: "Fictional demo data"}
	var force bool
	var confirm string
	reset := &cobra.Command{
		Use:   "reset",
		Short: "Delete all patient data and load the fictional demo patients again (python -m app.seed --reset)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			if a.Inst.IsLive() && !force {
				return errors.New("refused on live: it deletes real patient data (use --force only if live holds demo data)")
			}
			if confirm != "" {
				if confirm != a.Inst.Name {
					return fmt.Errorf("--confirm %q does not match the instance name", confirm)
				}
			} else if err := ui.TypedConfirm(fmt.Sprintf("This DELETES the patient data of %s and loads demo patients.", a.Inst.Name),
				a.Inst.Name, false); err != nil {
				return err
			}
			a.Log.Event(evlog.Warn, "demo reset")
			stderr, err := a.py(nil, "-m", "app.seed", "--reset")
			if err != nil {
				if strings.Contains(stderr, "unrecognized arguments") || strings.Contains(stderr, "--reset") {
					ui.Warn("this image's app.seed has no --reset yet: deploy newer code")
				}
				a.Log.Event(evlog.Fail, "demo reset failed")
				return errQuiet
			}
			a.Log.Event(evlog.OK, "demo data reset")
			ui.OK("demo data loaded")
			return nil
		},
	}
	reset.Flags().BoolVar(&force, "force", false, "allow on the live instance")
	reset.Flags().StringVar(&confirm, "confirm", "", "instance name, to confirm without a terminal")
	c.AddCommand(reset)
	return c
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
