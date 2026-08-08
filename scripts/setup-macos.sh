#!/usr/bin/env bash
#
# NetLink setup for macOS.
#
# Checks prerequisites, installs dependencies, writes .env, starts PostgreSQL,
# applies migrations. Safe to run repeatedly — it never overwrites an existing
# .env, because regenerating the JWT secret would sign every session out.
#
# Usage:
#   ./scripts/setup-macos.sh
#   ./scripts/setup-macos.sh --skip-database    # using your own PostgreSQL

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_DATABASE=0
for arg in "$@"; do
  case "$arg" in
    --skip-database) SKIP_DATABASE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

step()  { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()    { printf '    \033[32m%s\033[0m\n' "$1"; }
warn()  { printf '    \033[33m%s\033[0m\n' "$1"; }
fail()  { printf '    \033[31m%s\033[0m\n' "$1"; exit 1; }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

step 'Checking prerequisites'

require() {
  local name="$1" install="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    fail "$name is missing. Install it with: $install"
  fi
  ok "$name $(command -v "$name")"
}

require node   'brew install node'
require npm    'brew install node'
require go     'brew install go'
require docker 'brew install --cask docker'

# Wails needs Go 1.25. Checked explicitly because the failure otherwise appears
# much later as an opaque build error in a dependency nobody has heard of.
GO_VERSION="$(go env GOVERSION | sed 's/^go//')"
GO_MAJOR="${GO_VERSION%%.*}"
GO_MINOR="$(echo "$GO_VERSION" | cut -d. -f2)"
if [ "$GO_MAJOR" -lt 1 ] || { [ "$GO_MAJOR" -eq 1 ] && [ "$GO_MINOR" -lt 25 ]; }; then
  fail "Go $GO_VERSION is too old — Wails v2.13 needs 1.25 or newer. Update with: brew upgrade go"
fi
ok "Go $GO_VERSION"

# Xcode command line tools. Not needed to build the agent, but needed for the
# desktop app and for the cgo build that lets a Mac be *controlled* remotely.
if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode command line tools $(xcode-select -p)"
else
  warn 'Xcode command line tools are missing.'
  warn 'The agent still builds and this Mac can still be viewed remotely,'
  warn 'but it cannot be controlled until you run: xcode-select --install'
fi

if ! command -v wails >/dev/null 2>&1; then
  step 'Installing the Wails CLI'
  go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0
  export PATH="$PATH:$(go env GOPATH)/bin"
  ok 'Wails installed'
  warn "Add $(go env GOPATH)/bin to your PATH so new terminals find it."
fi

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

step 'Installing dependencies'
npm install
ok 'npm workspaces installed'

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

step 'Environment'

if [ -f .env ]; then
  ok '.env already exists — left untouched'
  warn 'Regenerating the signing keys would sign every session out and'
  warn 'invalidate every enrolled agent, so this never rewrites it.'
else
  # 48 random bytes, base64. `openssl` ships with macOS.
  JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  # The power/session signing key is a 32-byte Ed25519 seed, base64url.
  POWER_KEY="$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n')"

  sed \
    -e "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=${JWT_SECRET}|" \
    -e "s|^# *POWER_SIGNING_KEY=.*|POWER_SIGNING_KEY=${POWER_KEY}|" \
    .env.example > .env

  if ! grep -q '^POWER_SIGNING_KEY=' .env; then
    printf '\nPOWER_SIGNING_KEY=%s\n' "$POWER_KEY" >> .env
  fi

  chmod 600 .env
  ok '.env written with freshly generated keys (mode 600)'
fi

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

if [ "$SKIP_DATABASE" -eq 1 ]; then
  step 'Skipping the database'
  warn 'Set DATABASE_URL in .env, then run: npm run db:deploy --workspace=@netlink/api'
else
  step 'Starting PostgreSQL and Mailpit'
  if ! docker info >/dev/null 2>&1; then
    fail 'Docker is installed but not running. Open Docker Desktop and try again.'
  fi
  docker compose up -d
  ok 'Containers started'

  step 'Waiting for PostgreSQL'
  for attempt in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U netlink >/dev/null 2>&1; then
      ok 'PostgreSQL is accepting connections'
      break
    fi
    [ "$attempt" -eq 30 ] && fail 'PostgreSQL did not become ready.'
    sleep 1
  done

  step 'Applying migrations'
  npm run db:deploy --workspace=@netlink/api
  ok 'Schema is up to date'
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

step 'Ready'
cat <<'DONE'

    Start everything:      ./scripts/dev-macos.sh
    Run the checks:        ./scripts/test-all.sh
    Read the mail:         http://localhost:8025

  This Mac can be both — the computer you reach from, and the computer you
  reach. To make it reachable, enrol its agent from the NetLink window.

DONE
