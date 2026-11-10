# sickleguard CLI.  make build -> dist/sickleguard (+ dist/sg symlink)
VERSION ?= 1.0.0
COMMIT  ?= $(shell git -C .. rev-parse --short HEAD 2>/dev/null || echo unknown)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
ROOT    ?=
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.buildDate=$(DATE) -X main.defaultRoot=$(ROOT)
PLATFORMS := linux/amd64 linux/arm64 darwin/arm64
PREFIX ?= /usr/local/bin

.PHONY: build test vet cross install clean

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/sickleguard ./cmd/sickleguard
	ln -sf sickleguard dist/sg

test:
	go test ./...

vet:
	go vet ./...

cross:
	@for p in $(PLATFORMS); do os=$${p%/*}; arch=$${p#*/}; \
		echo "dist/sickleguard-$$os-$$arch"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" \
			-o dist/sickleguard-$$os-$$arch ./cmd/sickleguard || exit 1; \
	done

install: build
	install -m 0755 dist/sickleguard $(PREFIX)/sickleguard
	ln -sf $(PREFIX)/sickleguard $(PREFIX)/sg

clean:
	rm -rf dist
