// Package stack runs Docker Compose for one instance: `docker compose -p <project> --env-file deploy/<name>.env
// -f deploy/docker-compose.yml [-f deploy/shared-edge.yml] ...` with IMAGE_TAG set to the tag being run.
package stack

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Verbose echoes every docker command to stderr.
var Verbose bool

// Stack is one Compose project.
type Stack struct {
	Project  string
	EnvFile  string
	Files    []string // compose files, in order
	Tag      string   // IMAGE_TAG for interpolation
	Instance string   // SICKLEGUARD_INSTANCE (network alias sickleguard-<instance>-web in shared-edge.yml)
}

func (s Stack) args(a ...string) []string {
	base := []string{"compose", "-p", s.Project, "--env-file", s.EnvFile}
	for _, f := range s.Files {
		base = append(base, "-f", f)
	}
	return append(base, a...)
}

func (s Stack) env() []string {
	tag := s.Tag
	if tag == "" {
		tag = "latest"
	}
	// Process environment wins over --env-file for interpolation, so IMAGE_TAG here is the one that runs.
	return append(os.Environ(), "IMAGE_TAG="+tag, "COMPOSE_PROJECT_NAME="+s.Project, "SICKLEGUARD_INSTANCE="+s.Instance)
}

func echo(name string, a []string) {
	if Verbose {
		fmt.Fprintf(os.Stderr, "   → %s %s\n", name, strings.Join(a, " "))
	}
}

// Cmd builds a docker command (not started).
func (s Stack) Cmd(ctx context.Context, a ...string) *exec.Cmd {
	full := s.args(a...)
	echo("docker", full)
	c := exec.CommandContext(ctx, "docker", full...)
	c.Env = s.env()
	return c
}

// Run runs a compose subcommand with output to the terminal.
func (s Stack) Run(a ...string) error {
	c := s.Cmd(context.Background(), a...)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	return c.Run()
}

// RunQuiet runs a compose subcommand and returns its combined output only on error.
func (s Stack) RunQuiet(a ...string) error {
	c := s.Cmd(context.Background(), a...)
	var buf bytes.Buffer
	c.Stdout, c.Stderr = &buf, &buf
	if err := c.Run(); err != nil {
		return fmt.Errorf("%w\n%s", err, tail(buf.String(), 30))
	}
	return nil
}

// Output runs a compose subcommand and returns stdout.
func (s Stack) Output(a ...string) (string, error) {
	c := s.Cmd(context.Background(), a...)
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	err := c.Run()
	if err != nil {
		return out.String(), fmt.Errorf("%w: %s", err, strings.TrimSpace(tail(errb.String(), 10)))
	}
	return out.String(), nil
}

// Exec runs a command in a running service without a TTY, streaming stdin/stdout/stderr.
func (s Stack) Exec(service string, stdin io.Reader, stdout, stderr io.Writer, cmd ...string) error {
	a := append([]string{"exec", "-T", service}, cmd...)
	c := s.Cmd(context.Background(), a...)
	c.Stdin, c.Stdout, c.Stderr = stdin, stdout, stderr
	return c.Run()
}

// Volume is the Docker name of a project volume.
func (s Stack) Volume(name string) string { return s.Project + "_" + name }

// Container is one row of `docker compose ps`.
type Container struct {
	Name    string `json:"Name"`
	Service string `json:"Service"`
	State   string `json:"State"`
	Health  string `json:"Health"`
	Image   string `json:"Image"`
	Status  string `json:"Status"`
}

// PS lists the project's containers (all, including stopped).
func (s Stack) PS() ([]Container, error) {
	out, err := s.Output("ps", "-a", "--format", "json")
	if err != nil {
		return nil, err
	}
	return parsePS(out)
}

func parsePS(out string) ([]Container, error) {
	out = strings.TrimSpace(out)
	if out == "" {
		return nil, nil
	}
	var list []Container
	if strings.HasPrefix(out, "[") {
		err := json.Unmarshal([]byte(out), &list)
		return list, err
	}
	for _, line := range strings.Split(out, "\n") {
		var c Container
		if err := json.Unmarshal([]byte(line), &c); err == nil {
			list = append(list, c)
		}
	}
	return list, nil
}

// ---------------------------------------------------------------------------------------------- plain docker

// Docker runs `docker args...` and returns stdout.
func Docker(a ...string) (string, error) {
	echo("docker", a)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, "docker", a...)
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	if err := c.Run(); err != nil {
		return out.String(), fmt.Errorf("docker %s: %w: %s", first(a), err, strings.TrimSpace(tail(errb.String(), 10)))
	}
	return strings.TrimSpace(out.String()), nil
}

// DockerIO runs docker with the given stdin/stdout (for streaming tar archives).
func DockerIO(stdin io.Reader, stdout io.Writer, a ...string) error {
	echo("docker", a)
	c := exec.Command("docker", a...)
	var errb bytes.Buffer
	c.Stdin, c.Stdout, c.Stderr = stdin, stdout, &errb
	if err := c.Run(); err != nil {
		return fmt.Errorf("docker %s: %w: %s", first(a), err, strings.TrimSpace(tail(errb.String(), 10)))
	}
	return nil
}

// ImageExists reports whether image:tag is present locally.
func ImageExists(ref string) bool {
	_, err := Docker("image", "inspect", "--format", "{{.Id}}", ref)
	return err == nil
}

// VolumeExists reports whether a Docker volume exists.
func VolumeExists(name string) bool {
	_, err := Docker("volume", "inspect", "--format", "{{.Name}}", name)
	return err == nil
}

func first(a []string) string {
	if len(a) == 0 {
		return ""
	}
	return a[0]
}

func tail(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
