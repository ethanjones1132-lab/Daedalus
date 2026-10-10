#!/usr/bin/env bash
# Phase 2c, unattended (owner, 2026-10-10: "resume the roadmap, stop at 2c"): baselines, arm-S training, dev gates,
# checkpoint choice on dev only, test gates once, retention. Resumable: every phase file, adapter and conversion that
# already exists is skipped, so a rerun continues where this stopped.
#   run_2c.sh pre     baselines (dev, test) and base retention on the data so far; GPU only; no waiting
#   run_2c.sh full    wait for the DeepSeek restart to finish, freeze the data, top the baselines up, then everything else
# Sizes are the ladder the smoke test left: 4B, 2B, 0.8B (the 9B did not fit). LoRA targets are attention + MLP only,
# because llama.cpp's LoRA converter cannot reshape the gated-delta-net projections (serve gate, 2026-10-09).
set -u
MODE=${1:-full}
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
UPY=$HOME/.unsloth/studio/unsloth_studio/Scripts/python.exe
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DIR=E:/AI/teacher-data/gen-v0
D=E:/AI/role-adapters/data
W=E:/AI/role-adapters/eval
RUNS=E:/AI/role-adapters/runs
LOGS=/e/AI/role-adapters/logs
M=$LOGS/2c-markers
SIZES="4B 2B 0.8B"
ROLES="plan build fix"
LC=$HOME/.unsloth/llama.cpp
mkdir -p "$M" "$W" "$RUNS"
cd "$REPO" || exit 1
say() { echo "$(date +%m-%d\ %H:%M:%S) $*" | tee -a "$LOGS/2c.log"; }
upy() { PYTHONPATH=E:/AI/role-adapters/pylibs HF_HOME=E:/AI/hf-cache "$UPY" "$@"; }
once() { # marker-name command...   (skips when the marker exists; marks only on success)
  local name=$1; shift
  [ -f "$M/$name.ok" ] && return 0
  say "start $name"
  if "$@" >> "$LOGS/2c-$name.out" 2>&1; then touch "$M/$name.ok"; say "done  $name"; else say "FAILED $name (rc $?)"; return 1; fi
}
no_server() { while tasklist 2>/dev/null | grep -qi "llama-server"; do say "a llama-server is still up; waiting"; sleep 30; done; }

baselines() {
  for s in $SIZES; do
    for sp in dev test; do
      no_server
      say "baseline $s $sp"
      $PY scripts/roles/eval_roles.py baseline --size "$s" --split "$sp" --work "$W" >> "$LOGS/baseline-$s-$sp.out" 2>&1 || say "baseline $s $sp rc $?"
    done
    no_server
    once "retention-$s-base" $PY scripts/roles/retention.py run --size "$s" --name base --work "$W"
  done
}

if [ "$MODE" = pre ]; then
  baselines
  say "pre-baselines finished"
  exit 0
fi

# ---- wait for the capped DeepSeek restart (network only) -------------------------------------------------------------
DEADLINE=$(( $(date +%s) + 12 * 3600 ))
while [ ! -f /e/AI/teacher-data/gen-restart.done ] && [ "$(date +%s)" -lt "$DEADLINE" ]; do sleep 60; done
say "generation marker: $([ -f /e/AI/teacher-data/gen-restart.done ] && echo present || echo ABSENT, going on with the data so far)"

# ---- freeze the data ---------------------------------------------------------------------------------------------------
$PY scripts/roles/prepare_seeds.py --dir "$DIR" >> "$LOGS/2c-prepare.out" 2>&1
$PY scripts/roles/samples.py --dir "$DIR" --out "$D" > "$LOGS/2c-manifest.out" 2>&1
cp "$D/manifest.json" "$LOGS/2c-manifest.json"
say "data frozen: $($PY -c "import json;print(json.load(open('$D/manifest.json'))['counts'])")"
touch "$M/data-frozen"

# ---- baselines (top up what the earlier pre-pass did not cover) ---------------------------------------------------------
baselines

# ---- train arm S -----------------------------------------------------------------------------------------------------------
dev_losses_flat() { # run dir -> exit 0 when the dev loss barely moved (underfit)
  $PY - "$1" <<'EOF'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1] + "/log.jsonl", encoding="utf-8") if l.strip()]
dev = [r["dev_loss"] for r in rows if "dev_loss" in r]
sys.exit(0 if len(dev) >= 2 and (dev[0] - min(dev)) / dev[0] < 0.03 else 1)
EOF
}
best_dev() { $PY -c "import json;print(json.load(open('$1/summary.json'))['best_dev_loss'])"; }

for s in $SIZES; do
  for role in $ROLES; do
    R=$RUNS/$s-S-$role
    [ -f "$R/summary.json" ] && continue
    tn=$(wc -l < "$D/$role-train.jsonl" 2>/dev/null || echo 0); dn=$(wc -l < "$D/$role-dev.jsonl" 2>/dev/null || echo 0)
    if [ "$tn" -lt 8 ] || [ "$dn" -lt 3 ]; then say "SKIP training $s $role: train $tn, dev $dn"; continue; fi
    no_server
    say "train $s $role (train $tn, dev $dn)"
    upy scripts/roles/train_lora.py --model "E:/AI/role-adapters/models/Qwen3.5-$s" --train "$D/$role-train.jsonl" \
      --dev "$D/$role-dev.jsonl" --out "$R" --targets attn-mlp --max-len 6144 --eval-every 10 \
      >> "$LOGS/train-$s-S-$role.out" 2>&1 || { say "train $s $role FAILED"; continue; }
    if dev_losses_flat "$R"; then
      say "train $s $role: dev loss flat, one rerun at lr 2e-4"
      upy scripts/roles/train_lora.py --model "E:/AI/role-adapters/models/Qwen3.5-$s" --train "$D/$role-train.jsonl" \
        --dev "$D/$role-dev.jsonl" --out "$R-lr2e4" --targets attn-mlp --max-len 6144 --eval-every 10 --lr 2e-4 \
        >> "$LOGS/train-$s-S-$role-lr2e4.out" 2>&1
      if [ -f "$R-lr2e4/summary.json" ]; then
        a=$(best_dev "$R"); b=$(best_dev "$R-lr2e4")
        echo "{\"size\":\"$s\",\"role\":\"$role\",\"lr1e-4\":$a,\"lr2e-4\":$b}" >> "$LOGS/2c-lr-choices.jsonl"
        if $PY -c "import sys;sys.exit(0 if $b < $a else 1)"; then mv "$R" "$R-lr1e4" && mv "$R-lr2e4" "$R"; say "  lr 2e-4 kept ($b < $a)"; else say "  lr 1e-4 kept ($a <= $b)"; fi
      fi
    fi
  done
done

# ---- convert best + final and run the dev gates ------------------------------------------------------------------------
cands() { $PY -c "import sys,json;sys.path.insert(0,'scripts/roles');import choose_ckpt as c;print(' '.join(c.candidates(json.load(open('$1/summary.json')))))"; }
for s in $SIZES; do
  for role in $ROLES; do
    R=$RUNS/$s-S-$role
    [ -f "$R/summary.json" ] || continue
    for ck in $(cands "$R"); do
      [ -f "$R/$ck.gguf" ] || upy "$LC/convert_lora_to_gguf.py" --base "E:/AI/role-adapters/models/Qwen3.5-$s" \
        --outfile "$R/$ck.gguf" --outtype f16 "$R/$ck" >> "$LOGS/convert-$s-S-$role.out" 2>&1
      no_server
      say "dev gate $s $role $ck"
      $PY scripts/roles/eval_roles.py "$role-adapter" --size "$s" --split dev --work "$W" --name "$s-S-$role-$ck" \
        --lora "$R/$ck.gguf" >> "$LOGS/dev-$s-S-$role.out" 2>&1 || say "dev gate $s $role $ck rc $?"
    done
  done
done

# ---- choose on dev only, then the test gates once per chosen adapter ---------------------------------------------------------
$PY scripts/roles/choose_ckpt.py --work "$W" --runs "$RUNS" --arm S --sizes "${SIZES// /,}" > "$LOGS/2c-choose.out" 2>&1
cp "$W/chosen-S.json" "$LOGS/2c-chosen-S.json"
say "checkpoints chosen on dev: $(tr -d '\n ' < "$W/chosen-S.json")"
for s in $SIZES; do
  for role in $ROLES; do
    ck=$($PY -c "import json;print(json.load(open('$W/chosen-S.json')).get('$s',{}).get('$role',''))")
    [ -n "$ck" ] || continue
    R=$RUNS/$s-S-$role
    no_server
    say "test gate $s $role $ck"
    $PY scripts/roles/eval_roles.py "$role-adapter" --size "$s" --split test --work "$W" --name "$s-S-$role" \
      --lora "$R/$ck.gguf" >> "$LOGS/test-$s-S-$role.out" 2>&1 || say "test gate $s $role rc $?"
  done
  if [ -f "$W/$s/test/builds-$s-S-build-from-teacher.jsonl" ] && [ -f "$W/$s/test/builds-base-from-$s-S-plan.jsonl" ] \
     && [ -f "$W/$s/test/fixes-$s-S-fix.jsonl" ]; then
    $PY scripts/roles/eval_roles.py report --size "$s" --split test --work "$W" --plan "$s-S-plan" --build "$s-S-build" \
      --fix "$s-S-fix" > "$LOGS/report-$s-test.out" 2>&1
  else
    say "report $s: not all three roles have test results; read the phase files by hand"
  fi
done

# ---- retention with each chosen adapter loaded ----------------------------------------------------------------------------------
for s in $SIZES; do
  for role in $ROLES; do
    ck=$($PY -c "import json;print(json.load(open('$W/chosen-S.json')).get('$s',{}).get('$role',''))")
    [ -n "$ck" ] || continue
    no_server
    once "retention-$s-S-$role" $PY scripts/roles/retention.py run --size "$s" --name "$s-S-$role" \
      --lora "$RUNS/$s-S-$role/$ck.gguf" --work "$W"
  done
done

# ---- restore the machine -------------------------------------------------------------------------------------------------------------
touch /c/qwen3-forge-stage/logs/step2.done
(cd /c/Projects/Versutus && node gate/cli.mjs service start) >> "$LOGS/2c.log" 2>&1
say "2c pipeline finished"
touch "$LOGS/2c.done"
