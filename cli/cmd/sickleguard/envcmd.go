package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"sickleguard/cli/internal/envfile"
	"sickleguard/cli/internal/evlog"
	"sickleguard/cli/internal/ui"
)

func envCmd() *cobra.Command {
	c := &cobra.Command{Use: "env", Short: "Read or change one setting in deploy/<instance>.env (in place, keeps .bak)"}
	var show bool
	get := &cobra.Command{
		Use: "get KEY", Short: "Show a setting (secrets masked unless --show)", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			v, ok := a.Env.Get(args[0])
			if !ok {
				return fmt.Errorf("%s is not set in %s", args[0], a.Inst.RelEnvPath())
			}
			if show && envfile.SecretKey(args[0]) {
				a.Log.Event(evlog.Info, "revealed %s on the terminal", args[0])
			}
			fmt.Println(envfile.Display(args[0], v, show))
			return nil
		},
	}
	get.Flags().BoolVar(&show, "show", false, "print a secret in clear (only on your own terminal)")
	c.AddCommand(get)

	c.AddCommand(&cobra.Command{
		Use: "list", Short: "List the settings (secrets masked)", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			m := a.Env.Map()
			for _, k := range a.Env.Keys() {
				fmt.Printf("  %-20s %s\n", k, envfile.Display(k, m[k], false))
			}
			return nil
		},
	})

	var noRestart bool
	set := &cobra.Command{
		Use:   "set KEY [VALUE]",
		Short: "Change a setting; secrets are asked with hidden input, then the app is recreated to use it",
		Long: `Change one setting in place (the previous file is kept as deploy/<instance>.env.bak). Secret keys
(*KEY, *TOKEN, *SECRET, *PASSWORD) are always asked with hidden input, never taken from the command line, so they
stay out of the shell history. Containers read settings only when created: the command offers to recreate them.`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			key := args[0]
			if !envfile.ValidKey(key) {
				return fmt.Errorf("%q is not a valid key", key)
			}
			secret := envfile.SecretKey(key)
			var val string
			switch {
			case secret && len(args) == 2:
				return fmt.Errorf("%s is a secret: run `env set %s` without the value and type it at the hidden prompt", key, key)
			case secret:
				if val, err = ui.AskSecret("New value for " + key); err != nil {
					return err
				}
			case len(args) == 2:
				val = args[1]
			default:
				val = ui.Ask("New value for "+key, a.Env.Value(key))
			}
			val = strings.TrimSpace(val)
			if key == "JWT_SECRET" && len(val) < 32 {
				return errors.New("JWT_SECRET needs at least 32 characters")
			}
			if secret {
				a.Log.Register(val)
			}
			changed, err := a.Env.Set(key, val)
			if err != nil {
				return err
			}
			if !changed {
				ui.Info("%s unchanged", key)
				return nil
			}
			if err := a.Env.Save(); err != nil {
				return err
			}
			if secret {
				a.Log.Event(evlog.OK, "set %s (secret, %d chars)", key, len(val))
				ui.OK("%s updated (%s); previous file kept as %s.bak", key, envfile.Mask(val), a.Inst.RelEnvPath())
			} else {
				a.Log.Event(evlog.OK, "set %s=%s", key, val)
				ui.OK("%s=%s; previous file kept as %s.bak", key, val, a.Inst.RelEnvPath())
			}
			if key == "JWT_SECRET" {
				ui.Warn("everyone is signed out when the app restarts")
			}
			if noRestart || len(a.running()) == 0 {
				ui.Info("takes effect at the next `sickleguard --instance %s deploy --no-build`", a.Inst.Name)
				return nil
			}
			if key == "POSTGRES_PASSWORD" || key == "POSTGRES_USER" || key == "POSTGRES_DB" {
				ui.Warn("the database keeps its existing password/user: change it inside Postgres too, or the app cannot connect")
			}
			if !ui.Confirm("Recreate the containers now so the change takes effect?") {
				ui.Info("later: sickleguard --instance %s deploy --no-build", a.Inst.Name)
				return nil
			}
			if err := a.reloadEnv(); err != nil {
				return err
			}
			if _, err := a.start(a.State.Tag()); err != nil {
				a.Log.Event(evlog.Fail, "recreate after setting %s: %v", key, err)
				return err
			}
			a.Log.Event(evlog.OK, "recreated after setting %s", key)
			return nil
		},
	}
	set.Flags().BoolVar(&noRestart, "no-restart", false, "don't offer to recreate the containers")
	c.AddCommand(set)
	return c
}
