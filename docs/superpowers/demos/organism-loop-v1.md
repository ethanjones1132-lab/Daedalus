# Organism Loop v1 — Golden Demos

Per the handoff's Task 1.6 (`docs/superpowers/plans/2026-07-02-tier1-moonshots-fable5-handoff.md`)
and the implementation spec's "Acceptance demos" section
(`docs/superpowers/plans/2026-07-02-organism-loop-implementation-spec.md`).

**What's verified in this doc vs. what's a recipe:** D1 and D2 have a deterministic, model-free
proxy in the eval harness that was actually run to produce the output pasted below — no live model
calls, no server required, fully reproducible. D3 requires a live orchestrator turn against a real
model and a running Bun server; no server was running in this session (`curl 127.0.0.1:19877/health`
failed), so D3 is written as an accurate, copy-paste-ready recipe, not a captured result. Don't
mistake the D3 section for something already measured — run it and record real numbers before
claiming the flywheel closed end-to-end.

---

## D1 — A promoted skill changes routing (deterministic proxy: verified)

**Setup:** a skill candidate is `status: "promoted"`, its trigger matches the turn's `task_type` +
requirement + signals.

**Expected:** the turn's resolved skills include the promoted candidate; the prompt block injected
into planner/executor contains the skill body.

**Deterministic proof** (`server-jarvis/src/eval/cases.ts`, case `skill/trigger-debug-promoted`):
message `"fix the auth bug in src/auth.ts"`, `task_type: "debug"`, fixture candidate `status:
"promoted"` with matching trigger. Actually run this session:

```
$ cd server-jarvis && bun run src/eval/harness.ts
PASS  skill/trigger-debug-promoted
...
38/38 passed, 0 failed
```

`resolveSkillsForTurn` (`server-jarvis/src/intelligence/skill-resolver.ts`) returns `matched.length
>= 1` and `promptBlock` contains the candidate's name — this is exactly what `index.ts:1803` injects
into `pipelineOptions.distilledSkillsBlock`, which `pipeline.ts`'s `stageSystemPrompt` (173–187) adds
to the planner/executor prompts.

**Live equivalent** (requires a running server on `:19877` and a promoted candidate on disk):
```bash
# Seed a promoted candidate directly (or promote a real distilled one — see D3):
cat > ~/.openclaw/jarvis/skills/candidates/demo_debug_promoted.json <<'EOF'
{
  "id": "demo_debug_promoted",
  "name": "distilled-demo-debug",
  "description": "Demo: read the file before editing it",
  "trigger": { "task_types": ["debug"], "requirements": ["workspace_read"], "signals": [] },
  "body": "## Conductor worker guidance\nAlways read the target file in full before proposing an edit.",
  "source_run_ids": ["demo_run"],
  "confidence": 0.9,
  "status": "promoted",
  "created_at": "2026-07-02T00:00:00.000Z",
  "updated_at": "2026-07-02T00:00:00.000Z"
}
EOF

curl -s -X POST http://127.0.0.1:19877/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "look at src/foo.ts and tell me what it does", "session_id": "demo-d1"}'
# Server console should log the resolved skill; the executor stage's prompt
# (visible with debug logging, or by inspecting self-tuning.db's stage_runs)
# includes the "Promoted distilled skills for executor:" block.
```

---

## D2 — No matching skill: baseline behavior (deterministic proxy: verified)

**Setup:** same shape of request, but the candidate is `status: "candidate"` (not promoted) — proves
an un-promoted candidate never leaks into prompts, which is the exact safety property this session's
`auto_promote: false` default depends on.

**Expected:** the turn's resolved skills are empty; the prompt lacks the skill appendix.

**Deterministic proof** (case `skill/regression-candidate-not-injected`): message `"refactor the
login handler"`, `task_type: "refactor"`, fixture candidate `status: "candidate"`. Same harness run
above: `PASS skill/regression-candidate-not-injected` — `resolveSkillsForTurn` returns `matched.length
=== 0` for a non-promoted candidate even when the trigger would otherwise match.

**Live equivalent:**
```bash
curl -s http://127.0.0.1:19877/skills/candidates?status=candidate | jq
# Confirm your demo candidate is NOT status=promoted, then:
curl -s -X POST http://127.0.0.1:19877/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "refactor the login handler", "session_id": "demo-d2"}'
# Executor/planner prompts contain no "Promoted distilled skills" block.
```

---

## D3 — Distill → promote → repeat improves the second turn (live recipe — not yet captured)

**Setup:** trigger a real orchestrator turn that produces a `success` outcome with non-trivial
`worker_instructions`, let it distill, promote the resulting candidate through the judge gate, then
repeat a similar request and compare.

**Expected:** the second turn either completes in fewer stages, completes faster, or scores higher
on a judge rubric than the first — record the *actual* measured numbers, this is not a given.

```bash
# 1. First turn — no promoted skill exists yet for this pattern.
curl -s -X POST http://127.0.0.1:19877/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "fix the failing import in src/auth.ts", "session_id": "demo-d3"}'

# 2. Confirm a candidate was distilled (auto_promote defaults to false, so it
#    stays in "candidate" status pending review — this is the safety fix):
curl -s http://127.0.0.1:19877/skills/candidates?status=candidate | jq

# 3. Preview the grounding judge without committing:
curl -s -X POST http://127.0.0.1:19877/skills/candidates/<id>/eval | jq

# 4. Promote (heuristic gates + judge gate):
curl -s -X POST http://127.0.0.1:19877/skills/candidates/<id>/promote | jq
#    -> {"id":"...", "status":"promoted", "eval_score":0.8, "promoted_at":"..."}

# 5. Repeat a similar request:
curl -s -X POST http://127.0.0.1:19877/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "fix the failing import in src/payments.ts", "session_id": "demo-d3-repeat"}'

# 6. Compare the two runs via self-tuning.db (stage count, duration_ms) or the
#    performance panel once enough post-promotion runs have accumulated:
curl -s http://127.0.0.1:19877/skills/candidates/<id>/performance | jq
#    -> {"before": {...}, "after": {...}, "delta": <number or null>}

# 7. In the desktop app: Skills -> Distilled candidates filter -> the promoted
#    row shows the performance-since-promotion summary once "after" has runs.
```

**Note on D4 (conductor injection):** as of this session, a promoted skill also rides the
conductor's per-turn user delta (`persistent-conductor.ts`'s `buildTurnUserContent`) — so step 5's
*routing* decision itself, not just the executor/planner prompts, can now be influenced by a
promoted skill. This is pinned by 3 deterministic tests in `persistent-conductor.test.ts`'s "D4:
KV-safe conductor skill hint" block (unmatched-turn byte-identical regression, matched-turn hint
presence, system-prompt KV-cache stability across turns) — no live server needed to verify that
specific wiring; the D3 recipe above is about the higher-level "does the whole loop improve
outcomes" question, which does need live runs.

---

## Reproducing the deterministic proof yourself

```bash
cd server-jarvis
bun run src/eval/harness.ts   # prints PASS/FAIL per case, 38/38 expected
bun test                       # full suite, 475 tests expected
```
