#!/usr/bin/env bash
# stage-build-inputs.sh — make the Rust check runnable in a fresh worktree.
#
# `cargo check` (via tauri-build and the embedded frontendDist / bundled MCP
# binary) needs two generated directories that are gitignored and therefore
# absent from every new worktree:
#
#   src-ui/dist/index.html
#   server-jarvis/dist/mcp-stdio-server.js
#
# This script copies them from the repository's main checkout (found through
# the git common dir) when they are missing here, and does nothing when they
# are already present. It is a check-environment helper only: it does not
# change any gate command, and it never overwrites tracked files, writes
# outside the repo root, or deletes anything.
#
# Usage:
#   bash scripts/stage-build-inputs.sh
#
# Exit code is 0 when both inputs are present (staged or already there), and 1
# when one is missing here and in the main checkout too — the message then
# names the directory and the real build command.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# `--show-toplevel` proves we are inside a checkout at all; ROOT is then the
# tree this script lives in, which is the tree it stages into. In a real
# checkout the two are the same, and a throwaway copy under a worktree is
# still stageable without hand-set paths.
WORKTREE_TOP="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$WORKTREE_TOP" ]; then
  echo "stage-build-inputs: not inside a git checkout ($SCRIPT_DIR/..)" >&2
  exit 1
fi
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

# Absolute path of the shared git dir, then the main checkout that owns it
# (a linked worktree's common dir is <main-checkout>/.git).
COMMON_DIR="$(git -C "$WORKTREE_TOP" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -z "$COMMON_DIR" ]; then
  COMMON_DIR="$(git -C "$WORKTREE_TOP" rev-parse --git-common-dir)"
  case "$COMMON_DIR" in
    /*|[A-Za-z]:*) : ;;                        # already absolute
    *) COMMON_DIR="$WORKTREE_TOP/$COMMON_DIR" ;; # relative to the worktree root
  esac
fi
COMMON_DIR="$(cd "$COMMON_DIR" && pwd -P)"
MAIN_ROOT="$(dirname "$COMMON_DIR")"

# The two generated inputs `cargo check` needs, with the real build commands
# from src-ui/package.json and server-jarvis/package.json.

FAILED=0

# stage_one <rel-dir> <sentinel> <build-hint>
stage_one() {
  local rel="$1" sentinel="$2" hint="$3"
  local src="$MAIN_ROOT/$rel"
  local dest="$ROOT/$rel"

  # 1. Already there: say so and touch nothing (this is the idempotent path).
  if [ -f "$dest/$sentinel" ]; then
    echo "already present $rel"
    return 0
  fi

  # Safety rails: stay inside this worktree, and never write over tracked files.
  case "$dest" in
    "$ROOT"/*) : ;;
    *) echo "stage-build-inputs: refusing to write outside $ROOT: $dest" >&2; return 1 ;;
  esac
  if [ -L "$dest" ]; then
    echo "stage-build-inputs: refusing to stage into symlinked $rel" >&2
    return 1
  fi
  if [ -e "$dest" ] && [ ! -d "$dest" ]; then
    echo "stage-build-inputs: refusing to replace non-directory $rel" >&2
    return 1
  fi
  local tracked
  tracked="$(git -C "$WORKTREE_TOP" ls-files -- "$rel/")" || tracked=""
  if [ -n "$tracked" ]; then
    echo "stage-build-inputs: refusing to overwrite tracked files under $rel" >&2
    return 1
  fi

  # 2. Find the artefact in the main checkout, or explain how to build it here.
  if [ ! -f "$src/$sentinel" ]; then
    if [ "$MAIN_ROOT" = "$ROOT" ]; then
      echo "stage-build-inputs: $rel is missing and this is the main checkout ($ROOT)." >&2
    else
      echo "stage-build-inputs: $rel is missing here and not found in the main checkout ($MAIN_ROOT)." >&2
    fi
    echo "  build it with: $hint" >&2
    return 1
  fi

  # 3. Copy without deleting: a whole directory when absent, its contents when
  #    a partial dist/ already exists.
  if [ -d "$dest" ]; then
    cp -R "$src"/. "$dest"/
  else
    cp -R "$src" "$dest"
  fi

  if [ ! -f "$dest/$sentinel" ]; then
    echo "stage-build-inputs: copy of $rel did not produce $sentinel; build it with: $hint" >&2
    return 1
  fi

  echo "staged $rel from $src"
  return 0
}

# `src-ui` builds its dist with `npm run build` (tsc -b && vite build, see
# src-ui/package.json); `server-jarvis` bundles the native server + the
# standalone MCP stdio binary with `bun run build` (src/build-frontend.ts).
# One output line per directory, so a gate log shows exactly what happened.

stage_one "src-ui/dist" "index.html" "cd src-ui && npm run build" || FAILED=1
stage_one "server-jarvis/dist" "mcp-stdio-server.js" "cd server-jarvis && bun run build" || FAILED=1

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
exit 0
