#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Seed Jarvis Cron Jobs
# ═══════════════════════════════════════════════════════════════
# Creates the self-improvement cron jobs by directly inserting into
# the SQLite database. Run this from WSL2 while Jarvis desktop is stopped.
#
# Usage: bash seed-cron-jobs.sh [path_to_jarvis_db]
#
    10|# If no path is provided, searches common locations.

set -euo pipefail

# ── Find the database ─────────────────────────────────────────────────────────
DB_PATH="${1:-}"

if [ -z "$DB_PATH" ]; then
    # Search common locations
    CANDIDATES=(
    20|        "/mnt/c/Users/ethan/.openclaw/jarvis/memory/jarvis.db"
        "/mnt/c/Users/ethan/.local/share/com.jarvis.desktop/jarvis.db"
        "/mnt/c/Users/ethan/AppData/Local/com.jarvis.desktop/jarvis.db"
        "/mnt/c/Users/ethan/AppData/Roaming/jarvis-desktop/jarvis.db"
        "/home/ethan/.openclaw/jarvis/jarvis.db"
        "/home/ethan/.openclaw/agents/coderclaw/workspace/home-base/jarvis.db"
    )
    for c in "${CANDIDATES[@]}"; do
        if [ -f "$c" ]; then
            DB_PATH="$c"
    30|            break
        fi
    done
fi

if [ -z "$DB_PATH" ] || [ ! -f "$DB_PATH" ]; then
    echo "ERROR: Could not find Jarvis SQLite database."
    echo "Searched:"
    printf '  %s\n' "${CANDIDATES[@]}"
    echo ""
    40|    echo "Provide path manually: bash seed-cron-jobs.sh /path/to/jarvis.db"
    exit 1
fi

echo "[seed] Using database: $DB_PATH"

# ── Ensure tables exist ───────────────────────────────────────────────────────
sqlite3 "$DB_PATH" "CREATE TABLE IF NOT EXISTS cron_jobs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    50|    schedule    TEXT NOT NULL,
    agent_id    TEXT NOT NULL DEFAULT 'jarvis',
    session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    prompt      TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_run    TEXT,
    next_run    TEXT,
    run_count   INTEGER NOT NULL DEFAULT 0,
    metadata    TEXT CHECK(metadata IS NULL OR json_valid(metadata)),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    60|    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);" 2>/dev/null

sqlite3 "$DB_PATH" "CREATE TABLE IF NOT EXISTS cron_runs (
    id          TEXT PRIMARY KEY,
    cron_job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
    status      TEXT NOT NULL CHECK(status IN ('success','failed','timeout','cancelled')),
    output      TEXT NOT NULL DEFAULT '',
    error       TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    70|    started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at TEXT
);" 2>/dev/null

# ── Generate IDs ─────────────────────────────────────────────────────────────
LEARNING_ID="cron-learning-001"
REVIEW_ID="cron-review-001"
CODEBASE_AUDIT_ID="cron-codebase-audit-001"
FOOTBALL_AUDIT_ID="cron-football-audit-001"

    80|# ── Delete existing jobs with same IDs (idempotent) ──────────────────────────
sqlite3 "$DB_PATH" "DELETE FROM cron_runs WHERE cron_job_id IN ('$LEARNING_ID', '$REVIEW_ID', '$CODEBASE_AUDIT_ID', '$FOOTBALL_AUDIT_ID');" 2>/dev/null || true
sqlite3 "$DB_PATH" "DELETE FROM cron_jobs WHERE id IN ('$LEARNING_ID', '$REVIEW_ID', '$CODEBASE_AUDIT_ID', '$FOOTBALL_AUDIT_ID');" 2>/dev/null || true

# ── Compute next runs ─────────────────────────────────────────────────────────
NEXT_LEARNING=$(date -u -d "+1 day 03:00" +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u -v+1d -v3H -v0M -v0S +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || echo "$(date -u +'%Y-%m-%dT03:00:00.000Z')")
NEXT_REVIEW=$(date -u -d "+12 hours" +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u -v+12H +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || echo "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')")
NEXT_CODEBASE=$(date -u -d "+1 day 04:00" +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u -v+1d -v4H -v0M -v0S +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || echo "$(date -u +'%Y-%m-%dT04:00:00.000Z')")
NEXT_FOOTBALL=$(date -u -d "+1 day 05:00" +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u -v+1d -v5H -v0M -v0S +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || echo "$(date -u +'%Y-%m-%dT05:00:00.000Z')")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    90|
# ── Insert Learning Session Job ───────────────────────────────────────────────
sqlite3 "$DB_PATH" "INSERT INTO cron_jobs (id, name, schedule, agent_id, prompt, enabled, next_run, run_count, created_at, updated_at)
VALUES ('$LEARNING_ID', 'Learning Session', '0 3 * * *', 'jarvis', '', 1, '$NEXT_LEARNING', 0, '$NOW', '$NOW');" 2>/dev/null

# ── Insert Conversation Review Job ────────────────────────────────────────────
sqlite3 "$DB_PATH" "INSERT INTO cron_jobs (id, name, schedule, agent_id, prompt, enabled, next_run, run_count, created_at, updated_at)
VALUES ('$REVIEW_ID', 'Self-Improvement Review', '0 */12 * * *', 'jarvis', '', 1, '$NEXT_REVIEW', 0, '$NOW', '$NOW');" 2>/dev/null

# ── Insert Codebase Quality Audit Job ──────────────────────────────────────────
   100|sqlite3 "$DB_PATH" "INSERT INTO cron_jobs (id, name, schedule, agent_id, prompt, enabled, next_run, run_count, created_at, updated_at)
VALUES ('$CODEBASE_AUDIT_ID', 'Codebase Quality Audit', '0 4 * * *', 'jarvis', '', 1, '$NEXT_CODEBASE', 0, '$NOW', '$NOW');" 2>/dev/null

# ── Insert Football DB Validation Job ─────────────────────────────────────────
sqlite3 "$DB_PATH" "INSERT INTO cron_jobs (id, name, schedule, agent_id, prompt, enabled, next_run, run_count, created_at, updated_at)
VALUES ('$FOOTBALL_AUDIT_ID', 'Football DB Validation', '0 5 * * *', 'jarvis', '', 1, '$NEXT_FOOTBALL', 0, '$NOW', '$NOW');" 2>/dev/null

echo "[seed] Cron jobs created successfully:"
echo ""
sqlite3 "$DB_PATH" -header -column "SELECT id, name, schedule, enabled, next_run FROM cron_jobs WHERE id IN ('$LEARNING_ID', '$REVIEW_ID', '$CODEBASE_AUDIT_ID', '$FOOTBALL_AUDIT_ID');"
   110|echo ""
echo "[seed] Done. These jobs will appear in the Jarvis Cron tab when the desktop app starts."
