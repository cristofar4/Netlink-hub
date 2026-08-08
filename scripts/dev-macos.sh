#!/usr/bin/env bash
#
# Starts PostgreSQL, the API and the NetLink window, with hot reload.
# Ctrl-C stops everything it started.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

[ -f .env ] || { echo 'No .env — run ./scripts/setup-macos.sh first.' >&2; exit 1; }

step 'Starting PostgreSQL and Mailpit'
docker compose up -d

step 'Waiting for PostgreSQL'
for _ in $(seq 1 30); do
  docker compose exec -T postgres pg_isready -U netlink >/dev/null 2>&1 && break
  sleep 1
done

# Both children are killed on exit, so Ctrl-C does not leave an API listening on
# port 4000 that the next run then fails to bind.
API_PID=''
cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

step 'Starting the API'
npm run dev --workspace=@netlink/api &
API_PID=$!

# Wait for it to answer before opening the window, so the app does not start
# against a server that is not listening yet and show an error on first paint.
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:4000/api/health/live >/dev/null 2>&1 && break
  sleep 1
done

step 'Starting the NetLink window'
cd apps/desktop
wails dev
