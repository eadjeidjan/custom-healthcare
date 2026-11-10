// Package ui prints concise coloured output and asks questions (hidden input for secrets).
package ui

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"

	"golang.org/x/term"
)

var (
	color = term.IsTerminal(int(os.Stdout.Fd())) && os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb"
	in    = bufio.NewReader(os.Stdin)
	// Yes answers every confirmation with yes (--yes); questions with a default take the default.
	Yes bool
)

// ErrAborted is returned when the user declines.
var ErrAborted = errors.New("aborted")

func paint(code, s string) string {
	if !color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func Bold(s string) string   { return paint("1", s) }
func Dim(s string) string    { return paint("2", s) }
func Green(s string) string  { return paint("32", s) }
func Yellow(s string) string { return paint("33", s) }
func Red(s string) string    { return paint("31", s) }
func Cyan(s string) string   { return paint("36", s) }

// Step announces a stage of a command.
func Step(f string, a ...any) { fmt.Println(paint("1;36", "==>") + " " + Bold(fmt.Sprintf(f, a...))) }

// OK, Info, Warn and Fail print one result line.
func OK(f string, a ...any)   { fmt.Println("  " + Green("✓") + " " + fmt.Sprintf(f, a...)) }
func Info(f string, a ...any) { fmt.Println("  " + Dim("·") + " " + fmt.Sprintf(f, a...)) }
func Warn(f string, a ...any) { fmt.Fprintln(os.Stderr, "  "+Yellow("!")+" "+fmt.Sprintf(f, a...)) }
func Fail(f string, a ...any) { fmt.Fprintln(os.Stderr, "  "+Red("✗")+" "+fmt.Sprintf(f, a...)) }

// Interactive reports whether questions can be asked.
func Interactive() bool { return term.IsTerminal(int(os.Stdin.Fd())) }

func readLine() (string, error) {
	s, err := in.ReadString('\n')
	if err != nil && s == "" {
		return "", err
	}
	return strings.TrimRight(s, "\r\n"), nil
}

// Confirm asks a yes/no question; --yes answers yes, no terminal answers no.
func Confirm(q string) bool {
	if Yes {
		return true
	}
	if !Interactive() {
		return false
	}
	fmt.Printf("  %s %s [y/N] ", Yellow("?"), q)
	a, _ := readLine()
	a = strings.ToLower(strings.TrimSpace(a))
	return a == "y" || a == "yes"
}

// TypedConfirm makes the user type want (e.g. the instance name) before something destructive. --yes does not
// skip it unless allowYes is true.
func TypedConfirm(q, want string, allowYes bool) error {
	if Yes && allowYes {
		return nil
	}
	if !Interactive() {
		return fmt.Errorf("%s Type the name in a terminal, or pass --confirm %s", q, want)
	}
	fmt.Printf("  %s %s\n    Type %s to continue: ", Red("!"), q, Bold(want))
	a, _ := readLine()
	if strings.TrimSpace(a) != want {
		return ErrAborted
	}
	return nil
}

// Ask asks for a visible value; Enter (or --yes, or no terminal) gives def.
func Ask(q, def string) string {
	if Yes || !Interactive() {
		return def
	}
	if def != "" {
		fmt.Printf("  %s %s [%s]: ", Cyan("?"), q, def)
	} else {
		fmt.Printf("  %s %s: ", Cyan("?"), q)
	}
	a, err := readLine()
	if err != nil || strings.TrimSpace(a) == "" {
		return def
	}
	return strings.TrimSpace(a)
}

// AskSecret reads a secret without echo. Without a terminal it reads one line from stdin (for piping).
func AskSecret(q string) (string, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		s, err := readLine()
		if err != nil && !errors.Is(err, os.ErrClosed) && s == "" {
			return "", nil
		}
		return strings.TrimSpace(s), nil
	}
	fmt.Printf("  %s %s (hidden): ", Cyan("?"), q)
	b, err := term.ReadPassword(fd)
	fmt.Println()
	return strings.TrimSpace(string(b)), err
}
