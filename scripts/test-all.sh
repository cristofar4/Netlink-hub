#!/usr/bin/env bash
#
# Every NetLink check: formatting, linting, type checking, Go tests, API tests,
# frontend tests and production builds.
#
# This is the gate. A phase is not complete while any of it fails.
#
# The API integration tests need PostgreSQL, because they exercise the real
# guards against real SQL — a mocked repository would prove nothing about
# whether a revoked device is actually refused.
#
# Usage:
#   ./scripts/test-all.sh
#   ./scripts/test-all.sh --skip-builds
#   ./scripts/test-all.sh --skip-integration
#   ./scripts/test-all.sh --fix-formatting

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_BUILDS=0
SKIP_INTEGRATION=0
FIX_FORMATTING=0
for arg in "$@"; do
  case "$arg" in
    --skip-builds)      SKIP_BUILDS=1 ;;
    --skip-integration) SKIP_INTEGRATION=1 ;;
    --fix-formatting)   FIX_FORMATTING=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

FAILURES=()

check() {
  local name="$1" dir="$2"; shift 2
  printf '\n\033[36m==> %s\033[0m\n' "$name"
  if (cd "$dir" && "$@"); then
    printf '    \033[32mpassed\033[0m\n'
  else
    printf '    \033[31mFAILED\033[0m\n'
    FAILURES+=("$name")
  fi
}

# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

if [ "$FIX_FORMATTING" -eq 1 ]; then
  check 'Prettier (writing)' . npx prettier --write \
    'apps/api/src/**/*.ts' 'apps/api/test/**/*.ts' \
    'packages/contracts/src/**/*.ts' \
    'apps/desktop/frontend/src/**/*.{ts,tsx,css}' \
    'apps/mobile/src/**/*.{ts,tsx}'
  check 'gofmt (writing)' services/agent gofmt -w .
  check 'gofmt desktop (writing)' apps/desktop gofmt -w .
else
  check 'Prettier' . npx prettier --check \
    'apps/api/src/**/*.ts' 'apps/api/test/**/*.ts' \
    'packages/contracts/src/**/*.ts' \
    'apps/desktop/frontend/src/**/*.{ts,tsx,css}' \
    'apps/mobile/src/**/*.{ts,tsx}'

  # gofmt -l prints files that need formatting and exits 0 either way, so the
  # output has to be turned into the exit status by hand.
  check 'gofmt' services/agent bash -c '[ -z "$(gofmt -l .)" ] || { gofmt -l .; false; }'
  check 'gofmt desktop' apps/desktop bash -c '[ -z "$(gofmt -l .)" ] || { gofmt -l .; false; }'
fi

# ---------------------------------------------------------------------------
# Static analysis
# ---------------------------------------------------------------------------

check 'ESLint (API)' apps/api npx eslint 'src/**/*.ts' 'test/**/*.ts'
check 'go vet (agent)' services/agent go vet ./...
check 'go vet (desktop)' apps/desktop go vet ./...

check 'TypeScript — contracts' packages/contracts npx tsc -p tsconfig.json --noEmit
check 'TypeScript — ui' packages/ui npx tsc -p tsconfig.json --noEmit
check 'TypeScript — api' apps/api npx tsc -p tsconfig.json --noEmit
check 'TypeScript — frontend' apps/desktop/frontend npx tsc -b --force
check 'TypeScript — mobile' apps/mobile npx tsc -p tsconfig.json --noEmit

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

check 'Contract tests' packages/contracts npx vitest run
check 'Go tests (agent)' services/agent go test ./...
check 'Frontend tests' apps/desktop/frontend npx vitest run

if [ "$SKIP_INTEGRATION" -eq 1 ]; then
  check 'API unit tests' apps/api npm run test:unit
else
  check 'API tests' apps/api npx jest --config jest.config.js --runInBand
fi

# ---------------------------------------------------------------------------
# Builds
# ---------------------------------------------------------------------------

if [ "$SKIP_BUILDS" -eq 0 ]; then
  check 'Build contracts' packages/contracts npm run build
  check 'Build API' apps/api npm run build
  check 'Build frontend' apps/desktop/frontend npm run build

  # Every platform NetLink claims to support is cross-compiled here, so a
  # platform-specific file that stopped compiling is caught by whoever broke it
  # rather than by whoever next tries to ship for that platform.
  check 'Cross-compile agent — windows/amd64' services/agent \
    env GOOS=windows GOARCH=amd64 go build ./...
  check 'Cross-compile agent — darwin/arm64' services/agent \
    env GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build ./...
  check 'Cross-compile agent — darwin/amd64' services/agent \
    env GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build ./...
  check 'Cross-compile agent — linux/amd64' services/agent \
    env GOOS=linux GOARCH=amd64 go build ./...

  # The darwin tests only run on a Mac, but they must at least compile
  # everywhere, or a broken one is discovered by the first person on a Mac.
  check 'Compile darwin tests' services/agent bash -c '
    for pkg in ./internal/printers ./internal/remote ./pkg/identity ./internal/power; do
      GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go test -c -o /dev/null "$pkg" || exit 1
    done'
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  printf '\033[32mEverything passed.\033[0m\n'
  exit 0
fi

printf '\033[31m%d check(s) failed:\033[0m\n' "${#FAILURES[@]}"
for failure in "${FAILURES[@]}"; do
  printf '  - %s\n' "$failure"
done
exit 1
