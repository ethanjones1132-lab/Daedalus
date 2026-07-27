import json
import sqlite3
import sys

db = r"C:\Users\ethan\.openclaw\jarvis\self-tuning.db"
run_id = sys.argv[1] if len(sys.argv) > 1 else "run_7e3c27b8-35b9-43db-bdea-e4d40b1a2833"
session = sys.argv[2] if len(sys.argv) > 2 else "canary-opt2-merge-1c8f4497"

con = sqlite3.connect(db)
con.row_factory = sqlite3.Row

print("=== recent canary agent_runs ===")
for r in con.execute(
    """
    SELECT id, session_id, outcome, verified_via, check_tier, duration_ms, tool_calls_count
    FROM agent_runs
    WHERE session_id LIKE 'canary%' OR id = ?
    ORDER BY rowid DESC LIMIT 10
    """,
    (run_id,),
):
    print(dict(r))

print("=== agent_runs for target ===")
for r in con.execute(
    """
    SELECT id, session_id, outcome, verified_via, check_tier, duration_ms, tool_calls_count, substr(user_request,1,120) as req
    FROM agent_runs WHERE id=? OR session_id=?
    ORDER BY rowid DESC LIMIT 5
    """,
    (run_id, session),
):
    print(dict(r))

# Prefer newest canary run if present
row = con.execute(
    "SELECT id FROM agent_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1",
    (session,),
).fetchone()
if row:
    run_id = row["id"]
print("using_run_id", run_id)

print("=== stage_runs ===")
for r in con.execute(
    """
    SELECT mode_id, turn_number, was_successful, had_error, duration_ms, error_message, stop_reason, partial_error_code
    FROM stage_runs WHERE agent_run_id=? ORDER BY rowid
    """,
    (run_id,),
):
    print(dict(r))

print("=== attributions ===")
for r in con.execute(
    """
    SELECT stage_id, agent_id, provider, model_id, was_successful, had_error, duration_ms, fallback_used
    FROM model_attributions WHERE agent_run_id=? ORDER BY rowid
    """,
    (run_id,),
):
    print(dict(r))

print("=== directives ===")
for r in con.execute(
    """
    SELECT stage, directive_type, decision_source, reason, inject_note, escalation_id
    FROM conductor_directives WHERE agent_run_id=? ORDER BY rowid
    """,
    (run_id,),
):
    d = dict(r)
    for k in ("reason", "inject_note"):
        if d.get(k):
            d[k] = str(d[k])[:200]
    print(d)

print("=== tools by stage ===")
for r in con.execute(
    "SELECT mode_id, tool_calls_json FROM stage_runs WHERE agent_run_id=?",
    (run_id,),
):
    tools = json.loads(r["tool_calls_json"] or "[]")
    names = [(t.get("name"), bool(t.get("is_error"))) for t in tools]
    print(r["mode_id"], names)
