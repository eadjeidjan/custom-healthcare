#!/bin/sh
# Build and install the sickleguard CLI (and the `sg` alias) into /usr/local/bin.
#
#   cli/install.sh [--yes] [--prefix DIR] [--no-alias]
#
# Needs Go (version from cli/go.mod). On Ubuntu/Debian without a new enough Go it installs the official release
# (pinned below, SHA-256 verified) into /usr/local/go. On macOS it suggests `brew install go`. Idempotent.
set -eu

GO_VERSION="1.27.1"
sha_for() {
	case "$1" in
	go1.27.1.linux-amd64.tar.gz) echo 63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445 ;;
	go1.27.1.linux-arm64.tar.gz) echo 3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec ;;
	*) echo "" ;;
	esac
}

YES=0
PREFIX=/usr/local/bin
ALIAS=1
while [ $# -gt 0 ]; do
	case "$1" in
	--yes | -y) YES=1 ;;
	--prefix) shift; PREFIX="${1:?--prefix needs a folder}" ;;
	--no-alias) ALIAS=0 ;;
	-h | --help) sed -n '2,8p' "$0"; exit 0 ;;
	*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
	shift
done

say() { printf '==> %s\n' "$*"; }
die() { printf 'x %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
ask() {
	[ "$YES" = 1 ] && return 0
	[ -r /dev/tty ] || return 1
	printf '? %s [y/N] ' "$1" >/dev/tty
	read -r a </dev/tty || a=""
	case "$a" in y | Y | yes) return 0 ;; esac
	return 1
}
SUDO=""
[ "$(id -u)" = 0 ] || { have sudo && SUDO=sudo; }

SRC=$(cd "$(dirname "$0")" && pwd)
NEED=$(sed -n 's/^go \([0-9.]*\).*/\1/p' "$SRC/go.mod")
PATH="/usr/local/go/bin:$PATH"

ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
have_go() { have go && ver_ge "$(go env GOVERSION | sed 's/^go//')" "$NEED"; }

if ! have_go; then
	OS=$(uname -s)
	case "$OS" in
	Darwin) die "Go $NEED or newer is needed: brew install go, then run this again" ;;
	Linux) ;;
	*) die "unsupported OS $OS" ;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) ARCH=amd64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) die "unsupported architecture $(uname -m)" ;;
	esac
	ask "Go $NEED+ not found. Install Go $GO_VERSION into /usr/local/go?" || die "Go is required"
	have curl || { $SUDO apt-get update -q && $SUDO apt-get install -y -q curl ca-certificates; }
	TGZ="go$GO_VERSION.linux-$ARCH.tar.gz"
	TMP=$(mktemp -d)
	trap 'rm -rf "$TMP"' EXIT
	say "downloading $TGZ"
	curl -fsSL "https://go.dev/dl/$TGZ" -o "$TMP/$TGZ"
	WANT=$(sha_for "$TGZ")
	[ -n "$WANT" ] || die "no pinned checksum for $TGZ"
	GOT=$(sha256sum "$TMP/$TGZ" | cut -d' ' -f1)
	[ "$GOT" = "$WANT" ] || die "checksum mismatch for $TGZ"
	$SUDO rm -rf /usr/local/go
	$SUDO tar -C /usr/local -xzf "$TMP/$TGZ"
	say "Go $(/usr/local/go/bin/go env GOVERSION) installed in /usr/local/go"
fi

say "building sickleguard with $(go env GOVERSION)"
REPO=$(cd "$SRC/.." && pwd)
COMMIT=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)
# The repository path is built in, so `sickleguard` works from any folder.
(cd "$SRC" && CGO_ENABLED=0 go build -trimpath \
	-ldflags "-s -w -X main.version=1.0.0 -X main.commit=$COMMIT -X main.defaultRoot=$REPO -X main.buildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	-o dist/sickleguard ./cmd/sickleguard)

W=""
[ -w "$PREFIX" ] || W="$SUDO"
$W mkdir -p "$PREFIX"
$W install -m 0755 "$SRC/dist/sickleguard" "$PREFIX/sickleguard"
if [ "$ALIAS" = 1 ]; then
	# Ubuntu has /usr/bin/sg (run a command as another group); ours in /usr/local/bin comes first on PATH.
	[ -e /usr/bin/sg ] && say "note: /usr/bin/sg (shadow utils) exists; $PREFIX/sg takes precedence on PATH (use --no-alias to skip)"
	$W ln -sf "$PREFIX/sickleguard" "$PREFIX/sg"
fi
say "installed: $("$PREFIX/sickleguard" version | head -n1)"
say "it works from any folder (repository: $REPO). Next: sickleguard check"
