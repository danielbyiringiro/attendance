#!/usr/bin/env bash
# ============================================================================
# Run the migrations against a throwaway Postgres container.
#
#   ./sql/tests/run.sh            apply everything and assert
#   ./sql/tests/run.sh --keep     leave the container up afterwards
#   ./sql/tests/run.sh --shell    apply everything, then drop into psql
#
# Migrations are one-shot and land on a database holding real attendance, so
# they cannot be rehearsed in Supabase. This applies them to a fixture that
# looks like production instead, twice over, and asserts on the result.
#
# Requires Docker. Nothing here touches any Supabase project.
# ============================================================================
set -euo pipefail

# Git Bash rewrites anything that looks like a path when it crosses into
# docker exec. Without this, `-c "SELECT ..."` and container paths get mangled.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MIGRATIONS_DIR="$ROOT/sql/migrations"

CONTAINER=attendance_migration_test
IMAGE=postgres:15-alpine
DB=attendance_test
PGUSER=postgres

KEEP=0
SHELL_AFTER=0
for arg in "$@"; do
  case "$arg" in
    --keep)  KEEP=1 ;;
    --shell) KEEP=1; SHELL_AFTER=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  else
    dim "container '$CONTAINER' left running — remove it with: docker rm -f $CONTAINER"
  fi
}
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  red "Docker is not running."
  echo "Start Docker Desktop and try again. Nothing was changed."
  exit 1
fi

# ----------------------------------------------------------------------------
# Fresh container every run, so a half-applied migration from a previous run
# can never make this one pass.
# ----------------------------------------------------------------------------
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
dim "starting $IMAGE ..."
# wal_level=logical so CREATE PUBLICATION behaves as it does on Supabase.
# On the default (replica) it still "works" but warns, which would make any
# assertion about the realtime publication meaningless.
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB="$DB" \
  "$IMAGE" -c wal_level=logical >/dev/null

# The image runs a temporary server on the unix socket to create the database,
# then shuts it down and starts the real one. pg_isready answers during that
# first phase, so a naive probe connects to a server that is about to vanish.
# Require several consecutive good round-trips to be sure init is finished.
READY=0
STREAK=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" psql -U "$PGUSER" -d "$DB" -tAc 'SELECT 1' >/dev/null 2>&1; then
    STREAK=$((STREAK + 1))
    if [ "$STREAK" -ge 4 ]; then READY=1; break; fi
  else
    STREAK=0
  fi
  sleep 0.5
done
if [ "$READY" -eq 0 ]; then
  red "Postgres never became ready."
  docker logs "$CONTAINER" 2>&1 | tail -20
  exit 1
fi

# Apply one .sql file. ON_ERROR_STOP so a failure mid-file is a failure.
apply() {
  local file="$1"
  docker exec -i "$CONTAINER" \
    psql -U "$PGUSER" -d "$DB" -v ON_ERROR_STOP=1 -q -f - < "$file"
}

query() {
  docker exec -i "$CONTAINER" \
    psql -U "$PGUSER" -d "$DB" -v ON_ERROR_STOP=1 -tAc "$1"
}

# ----------------------------------------------------------------------------
# Setup
# ----------------------------------------------------------------------------
dim "applying shim ..."
apply "$HERE/00_shim.sql"

dim "applying legacy fixture ..."
apply "$HERE/00_legacy_fixture.sql"

# ----------------------------------------------------------------------------
# Migrations, in filename order
# ----------------------------------------------------------------------------
shopt -s nullglob
MIGRATIONS=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob

if [ ${#MIGRATIONS[@]} -eq 0 ]; then
  dim "no migrations in sql/migrations yet — fixture only"
else
  for m in "${MIGRATIONS[@]}"; do
    dim "applying $(basename "$m") ..."
    apply "$m"
  done

  # Every migration must be safe to run twice: the user pastes these into the
  # Supabase SQL Editor by hand and will re-run one.
  dim "re-applying all migrations (idempotency) ..."
  for m in "${MIGRATIONS[@]}"; do
    if ! apply "$m" >/dev/null 2>&1; then
      red "NOT IDEMPOTENT: $(basename "$m") failed on second application"
      apply "$m" || true
      exit 1
    fi
  done
fi

# ----------------------------------------------------------------------------
# Assertions
#
# Each *.assert.sql raises an exception on failure, so ON_ERROR_STOP turns a
# failed assertion into a non-zero exit.
# ----------------------------------------------------------------------------
shopt -s nullglob
ASSERTIONS=("$HERE"/*.assert.sql)
shopt -u nullglob

FAILED=0
if [ ${#ASSERTIONS[@]} -eq 0 ]; then
  dim "no assertion files yet"
else
  for a in "${ASSERTIONS[@]}"; do
    name="$(basename "$a")"
    if apply "$a"; then
      green "  ok   $name"
    else
      red   "  FAIL $name"
      FAILED=1
    fi
  done
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
echo
echo "fixture:      $(query 'SELECT count(*) FROM public.students') students, $(query 'SELECT count(*) FROM public.present_students') check-ins"
if [ ${#MIGRATIONS[@]} -gt 0 ]; then
  echo "migrations:   ${#MIGRATIONS[@]} applied twice"
fi

if [ "$SHELL_AFTER" -eq 1 ]; then
  echo
  dim "dropping into psql — \\q to exit"
  docker exec -it "$CONTAINER" psql -U "$PGUSER" -d "$DB"
fi

if [ "$FAILED" -ne 0 ]; then
  red "FAILED"
  exit 1
fi
green "PASSED"
