package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"sickleguard/cli/internal/evlog"
	"sickleguard/cli/internal/stack"
	"sickleguard/cli/internal/ui"
)

func bgCtx() context.Context { return context.Background() }

var services = []string{"db", "qdrant", "api", "mcp", "web"}

func validService(s string) error {
	for _, v := range services {
		if v == s {
			return nil
		}
	}
	return fmt.Errorf("unknown service %q (services: %s)", s, strings.Join(services, ", "))
}

func statusCmd() *cobra.Command {
	var noDisk bool
	c := &cobra.Command{
		Use:   "status",
		Short: "Containers, health, image tag, versions, volume sizes, model and OpenAI",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			sha, dirty := gitInfo(a.Root)
			if dirty {
				sha += " (uncommitted changes)"
			}
			ui.Step("SickleGuard %s — %s", a.Inst.Name, a.publicURL())
			ui.Info("project %s · settings %s · code %s", a.Stack.Project, a.Inst.RelEnvPath(), sha)
			ui.Info("image tag %s · previous %s", ui.Bold(orNone(a.State.Current)), orNone(a.State.Previous))
			if n := len(a.State.History); n > 0 {
				e := a.State.History[n-1]
				ui.Info("last %s %s ago", e.Action, ago(time.Since(e.At)))
			}

			list, err := a.Stack.PS()
			if err != nil {
				return err
			}
			fmt.Println()
			if len(list) == 0 {
				ui.Warn("no containers: start with `sickleguard --instance %s deploy`", a.Inst.Name)
			} else {
				fmt.Printf("  %-8s %-10s %-10s %s\n", "SERVICE", "STATE", "HEALTH", "IMAGE")
				for _, c := range list {
					st := c.State
					if st == "running" {
						st = ui.Green(fmt.Sprintf("%-10s", st))
					} else {
						st = ui.Red(fmt.Sprintf("%-10s", st))
					}
					h := c.Health
					if h == "" {
						h = "-"
					}
					fmt.Printf("  %-8s %s %-10s %s\n", c.Service, st, h, c.Image)
				}
			}
			fmt.Println()
			if h, err := health(a.localURL()); err != nil {
				ui.Fail("API health: %v", err)
			} else {
				ui.OK("API %s healthy · model %s (AUC %.3f) · OpenAI %s · Qdrant %s · MCP %s", h.Version,
					h.Model.Version, h.Model.AUC, onoff(h.OpenAI), onoff(h.Qdrant), onoff(h.MCP))
			}
			if !noDisk {
				img := a.apiImage()
				if stack.ImageExists(img) {
					var parts []string
					for _, v := range []string{"db-data", "qdrant-data", "app-data"} {
						vol := a.Stack.Volume(v)
						if !stack.VolumeExists(vol) {
							continue
						}
						out, err := stack.Docker("run", "--rm", "--user", "0", "--network", "none", "-v", vol+":/v:ro",
							"--entrypoint", "du", img, "-sh", "/v")
						if err == nil {
							parts = append(parts, v+" "+strings.Fields(out)[0])
						}
					}
					if len(parts) > 0 {
						ui.Info("volumes: %s", strings.Join(parts, " · "))
					}
				}
			}
			return nil
		},
	}
	c.Flags().BoolVar(&noDisk, "no-disk", false, "skip measuring the volumes")
	return c
}

func logsCmd() *cobra.Command {
	var follow bool
	var tail string
	c := &cobra.Command{
		Use:   "logs [service]",
		Short: "Show logs (api, mcp, web, db, qdrant)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			cargs := []string{"logs", "--tail", tail}
			if follow {
				cargs = append(cargs, "-f")
			}
			if len(args) == 1 {
				if err := validService(args[0]); err != nil {
					return err
				}
				cargs = append(cargs, args[0])
			}
			return a.Stack.Run(cargs...)
		},
	}
	c.Flags().BoolVarP(&follow, "follow", "f", false, "keep following")
	c.Flags().StringVarP(&tail, "tail", "n", "200", "lines from the end of each log")
	return c
}

func restartCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "restart [service]",
		Short: "Restart all containers or one (settings changes need `deploy --no-build` instead)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			cargs := []string{"restart"}
			if len(args) == 1 {
				if err := validService(args[0]); err != nil {
					return err
				}
				cargs = append(cargs, args[0])
			}
			ui.Step("Restarting %s", strings.Join(append([]string{a.Stack.Project}, args...), " "))
			if err := a.Stack.Run(cargs...); err != nil {
				a.Log.Event(evlog.Fail, "restart %s: %v", strings.Join(args, " "), err)
				return err
			}
			if _, err := waitHealth(a.localURL(), healthTimeout); err != nil {
				a.Log.Event(evlog.Warn, "restart %s: %v", strings.Join(args, " "), err)
				return err
			}
			a.Log.Event(evlog.OK, "restarted %s", strings.Join(args, " "))
			ui.OK("healthy")
			return nil
		},
	}
}

func downCmd() *cobra.Command {
	var volumes bool
	var confirm string
	c := &cobra.Command{
		Use:   "down",
		Short: "Stop and remove the containers (data kept; --volumes deletes it)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			if volumes {
				if confirm != "" {
					if confirm != a.Inst.Name {
						return fmt.Errorf("--confirm %q does not match the instance name", confirm)
					}
				} else if err := ui.TypedConfirm(fmt.Sprintf("This DELETES the database, vectors and uploaded files of %s.",
					a.Inst.Name), a.Inst.Name, false); err != nil {
					return err
				}
			} else if !ui.Confirm(fmt.Sprintf("Stop instance %s (%s)? Data is kept.", a.Inst.Name, a.Stack.Project)) {
				return ui.ErrAborted
			}
			cargs := []string{"down", "--remove-orphans"}
			if volumes {
				cargs = append(cargs, "--volumes")
			}
			if err := a.Stack.Run(cargs...); err != nil {
				return err
			}
			if volumes {
				a.Log.Event(evlog.Warn, "down with volumes deleted")
				ui.OK("%s stopped and its data deleted", a.Inst.Name)
			} else {
				a.Log.Event(evlog.OK, "down (data kept)")
				ui.OK("%s stopped (data kept; start again with deploy --no-build)", a.Inst.Name)
			}
			return nil
		},
	}
	c.Flags().BoolVar(&volumes, "volumes", false, "also delete the instance's volumes (asks you to type the instance name)")
	c.Flags().StringVar(&confirm, "confirm", "", "instance name, to confirm --volumes without a terminal")
	return c
}

func execCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "exec <service> -- <command...>",
		Short: "Run a command in a running container",
		Example: `  sickleguard exec api -- python -m app.manage list
  sickleguard exec db -- psql -U sg sickleguard`,
		Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			a, err := load(cmd, true)
			if err != nil {
				return err
			}
			svc := args[0]
			if err := validService(svc); err != nil {
				return err
			}
			rest := args[1:]
			if d := cmd.ArgsLenAtDash(); d > 1 {
				return fmt.Errorf("put the command after --: exec %s -- <command>", svc)
			}
			cargs := []string{"exec"}
			if !term.IsTerminal(int(os.Stdin.Fd())) {
				cargs = append(cargs, "-T")
			}
			cargs = append(append(cargs, svc), rest...)
			a.Log.Event(evlog.Info, "exec %s: %s", svc, rest[0])
			err = a.Stack.Run(cargs...)
			if ee, ok := err.(*exec.ExitError); ok {
				os.Exit(ee.ExitCode())
			}
			return err
		},
	}
}
