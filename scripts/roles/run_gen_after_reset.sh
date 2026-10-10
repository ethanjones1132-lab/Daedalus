#!/usr/bin/env bash
# Restarts DeepSeek teacher generation after the OpenCode Go monthly quota resets (about 03:30 EDT on 2026-10-10), under a
# self-imposed token cap (owner: yes to a cap, 2026-10-09). Network only: no GPU. The plan's quota is shared with the
# owner's other OpenCode Go use, so the cap is deliberately about half of what the first two rounds cost (an estimate of
# ~6M tokens: ~2.2M completions in 394 runs, ~2.7M prompts, ~1.5M seed rounds).
# Priority: dev and test seeds first, then train, then faults. One process at a time, <= 6 concurrent calls.
# usage: run_gen_after_reset.sh [token-cap]      markers: $LOG, $DONE
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DIR=E:/AI/teacher-data/gen-v0
LOG=/e/AI/teacher-data/gen-restart.log
DONE=/e/AI/teacher-data/gen-restart.done
export REPO
export TEACHER_TOKEN_CAP=${1:-3000000}
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$LOG"; }
rm -f "$DONE"

START=$(date -d "03:35 tomorrow" +%s)
[ "$(date +%H)" -lt 12 ] && START=$(date -d "03:35" +%s)  # run after midnight: today's 03:35
now=$(date +%s)
[ "$now" -lt "$START" ] && { say "waiting $((START - now)) s until 03:35"; sleep $((START - now)); }

# probe: one tiny call; exit 3 = the plan's window is still spent
for k in $(seq 1 24); do
  "$PY" - <<'EOF' >> "$LOG" 2>&1
import sys
import os; sys.path.insert(0, os.environ["REPO"] + "/scripts/moe-bench")
import opencode_go
try:
    print("probe:", repr(opencode_go.Client().chat("Reply with the word ok.", max_tokens=8, json_mode=False)))
except opencode_go.GoUsageLimitError as e:
    print("probe: window still spent:", e)
    sys.exit(3)
EOF
  rc=$?
  [ "$rc" = 0 ] && break
  say "probe $k: rc=$rc; waiting 15 min"
  sleep 900
  [ "$k" = 24 ] && { say "quota never came back; giving up"; touch "$DONE"; exit 0; }
done

export TEACHER_BUDGET_SINCE=$(date +%s)
say "generation starts; cap $TEACHER_TOKEN_CAP tokens since $TEACHER_BUDGET_SINCE"
cd "$REPO/scripts/teacher" || exit 1
"$PY" teacher_gen.py gen --out "$DIR" --backend deepseek --seeds-file seeds-clean.jsonl --splits dev,test --workers 6 >> "$DIR/gen-eval.out" 2>&1
say "dev,test phase ended (rc $?)"
"$PY" teacher_gen.py gen --out "$DIR" --backend deepseek --seeds-file seeds-clean.jsonl --splits train --workers 6 >> "$DIR/gen-train.out" 2>&1
say "train phase ended (rc $?)"
cd "$REPO/scripts/roles" || exit 1
"$PY" faults.py --dir "$DIR" --per-seed 2 --splits train,dev --workers 6 >> "$DIR/faults.out" 2>&1
say "faults phase ended (rc $?)"
say "tokens spent under this cap: $("$PY" -c "
import sys; sys.path.insert(0, '$REPO/scripts/teacher'); sys.path.insert(0, '$REPO/scripts/moe-bench')
import teacher_gen as tg; print(tg.spent_tokens($TEACHER_BUDGET_SINCE))")"
touch "$DONE"
