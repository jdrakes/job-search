#!/bin/zsh
# The weekday run, launched by ~/Library/LaunchAgents/com.example.job-search.plist.
#
# It runs from its OWN clone (`RUNNER` below, default
# `~/workspace/job-search-runner`), never from the checkout James works in.
# An earlier version did `git checkout main` and `git pull` in the working
# checkout (`REPO` below), which would switch a session off its branch
# mid-work at 06:30 — and more than one session works in that repository.
#
# The clone holds no secrets: credentials are read from the working
# checkout's .env, which stays the one copy on this machine.
set -euo pipefail

# Every path below is a variable with a default rather than a literal, so
# this script documents the shape of a scheduled run without describing any
# one machine. Override any of them in the environment that launches this
# script.
REPO="${JOB_SEARCH_REPO:-$HOME/workspace/job-search}"
RUNNER="${JOB_SEARCH_RUNNER_CLONE:-$HOME/workspace/job-search-runner}"
ENV_FILE="$REPO/.env"

# launchd gives a job almost no environment: no login shell, no nvm, and no
# node on PATH. Node is resolved from .nvmrc rather than pinned to a patch
# version, so upgrading node does not silently stop the morning run.
NODE_MAJOR="$(cat "$REPO/.nvmrc" 2>/dev/null || echo 24)"
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v"$NODE_MAJOR".*/bin 2>/dev/null | sort -V | tail -1)"
if [[ -z "$NODE_BIN" ]]; then
  echo "no node v$NODE_MAJOR under ~/.nvm — .nvmrc asks for it and nothing provides it" >&2
  exit 1
fi
export PATH="$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Without .env there is no JOB_SEARCH_DB_URL, and `openStore` throws rather
# than reporting a clean, empty day against a store holding twenty thousand
# postings.
if [[ ! -f "$ENV_FILE" ]]; then
  echo "no .env at $ENV_FILE — the run cannot reach the store" >&2
  exit 1
fi

# The remote is read from the working checkout rather than written here, so
# the URL has one copy. Verified 2026-09-15 that this clones and fetches
# without an interactive prompt, which is what launchd needs.
ORIGIN="$(git -C "$REPO" remote get-url origin)"
export GIT_TERMINAL_PROMPT=0

if [[ ! -d "$RUNNER/.git" ]]; then
  git clone --quiet "$ORIGIN" "$RUNNER"
fi

cd "$RUNNER"
# Whatever is on origin's main and nothing else. Not --ff-only: this clone
# has no work of its own to protect, so a force-push upstream should move it
# rather than stop the morning.
git fetch --quiet origin main
git checkout --quiet -B main origin/main
npm ci --silent

# The store of record is the local Postgres, not the hosted project (the
# design page's Data section). It is a container, so it can simply be down —
# and a run that cannot reach it must say so here, before `openStore` dials
# it and fails on the first read with a connection error where the log needs
# a sentence naming the container.
#
# Failing loudly rather than starting the container: Operation promises a job
# that "fails loudly rather than quietly doing nothing", and a runner that
# repairs its own environment hides the fact that the machine rebooted. The
# fix is one command in the message.
ARCHIVE_CONTAINER="${JOB_SEARCH_ARCHIVE_CONTAINER:-job-search-archive}"
ARCHIVE_COMPOSE_DIR="${JOB_SEARCH_ARCHIVE_COMPOSE_DIR:-$HOME/workspace/job-search-local}"
export JOB_SEARCH_DB_URL="postgres://postgres:postgres@localhost:55432/job_search"
if ! docker exec "$ARCHIVE_CONTAINER" pg_isready -U postgres -d job_search >/dev/null 2>&1; then
  echo "the archive database is not answering on localhost:55432 — the store of" >&2
  echo "record is down and this run has nothing to read or write." >&2
  echo "start it with: cd $ARCHIVE_COMPOSE_DIR && docker compose up -d" >&2
  exit 1
fi

# Where the run leaves its copy of the store of record (design page, Data and
# Operation). Absent, the backup phase logs "skipped" and the run is otherwise
# unchanged — which is right for a fresh checkout and wrong here, so this says
# where it is rather than leaving the one machine holding the only copy.
#
# Checked, not assumed: a path that is not a git repository would have the
# phase fail every morning with the same message, and a run that reports a
# failure it cannot fix is noise. This says it once, here, where the fix is.
export JOB_SEARCH_BACKUP_REPO="${JOB_SEARCH_BACKUP_REPO:-$HOME/workspace/job-search-backup}"
if [[ ! -d "$JOB_SEARCH_BACKUP_REPO/.git" ]]; then
  echo "no git repository at $JOB_SEARCH_BACKUP_REPO — the run has nowhere to" >&2
  echo "leave its copy of the store of record. Clone it, or unset" >&2
  echo "JOB_SEARCH_BACKUP_REPO to run without one." >&2
  exit 1
fi

echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
node --env-file="$ENV_FILE" src/daily.ts
