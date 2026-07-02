# Organism Loop v1 — Outcome (2026-07-02)

**Planned by:** Fable 5 (this session) — see `2026-07-02-tier1-moonshots-fable5-handoff.md` (Layer A) and `2026-07-02-organism-loop-implementation-spec.md` (Layer B).
**Implemented by:** the same session, continued as Sonnet 5 per the handoff's "plan → implement split." One continuous session did both, which is why this doc and the spec share a timestamp.

**Status: full Layer B spec closed out**, not just the Minimum Shippable Slice — D4 (conductor injection), D6 (`skill_grounding` eval case kind), and the golden demos doc were completed in a follow-up pass within the same session (see "D4/D6/demos closeout" below).

## What shipped (Minimum Shippable Slice, D1/D2/D5/D5a/D6)

1. **Config** (`server-jarvis/src/config.ts`): `SkillDistillationConfig` gains `min_judge_score` (default 0.75) and `auto_promote` (default **false**). `distill_on` already existed (shipped by a separate maintenance pass mid-session — see "What diverged" below).
2. **Types** (`skill-types.ts`): `SkillCandidate` gains `promoted_at`, `tool_sequence_digest`, `eval_missed`; `SkillRejectionReason` gains `eval_failed` and `manual`.
3. **Judge-gated promotion** (`skill-promotion.ts`): new `buildGroundingRubric`, `runGroundingJudge` (shared grounding step), `promoteSkillCandidate` (heuristic gates → semantic judge gate → promote/reject), and `computeCandidatePerformance` (before/after-promotion success-rate comparison). All heuristic gates from the original `evaluateSkillPromotion` are unchanged and still run first as a cheap pre-screen.
4. **Store helpers** (`skill-store.ts`): `updateSkillCandidateStatus` now also manages `promoted_at` (set on promote, cleared otherwise) and accepts `eval_missed`; new `updateSkillCandidateEval` persists a judge score without transitioning status.
5. **`makeCallModel` extraction** (`eval/call-model.ts`, new file): pulled out of `eval/semantic-harness.ts` with zero behavior change, so both the live semantic-eval runner and the skill judge can share the exact same production model-calling path (fallback cascade, native-vs-text-tool-protocol resolution).
6. **The safety fix** (`index.ts`, post-distill hook): previously, every successful orchestrator turn ran `runSkillPromotionPass()` unconditionally — any candidate clearing 6 heuristic gates was **already live in production prompts with zero semantic review**. Now: `auto_promote` defaults to `false`, so the hook runs only the heuristic screen (rejects junk, leaves passers in `"candidate"` status) and waits for an explicit operator action. Setting `auto_promote: true` restores full automatic judge-gated promotion for a single candidate — not the whole backlog (bulk judge calls on every turn would be a real latency/cost problem).
7. **5 new HTTP endpoints** (`index.ts`): `POST /skills/candidates/:id/{eval,promote,reject,demote}`, `GET /skills/candidates/:id/performance` — exact request/response shapes per the spec's D5a contract. The existing bulk `POST /skills/promote` and `GET /skills/candidates` routes are unchanged.
8. **SkillsView UI** (`src-ui/src/components/jarvis/SkillsView.tsx`): distilled-skill rows (identified by `metadata.source === "trajectory_distillation"`) now show Promote/Reject/Demote actions instead of the native enable/disable toggle — because that toggle writes the native SQLite `enabled` column, which the Bun-side resolver never reads for distilled skills (a real no-op bug, confirmed during planning). The detail panel gained a candidate-metadata card: confidence, eval score, eval-missed items, rejection reason/detail, `promoted_at`, source session/run ids, and a performance-since-promotion summary once a candidate is promoted. Bundled skills are unaffected — they keep the native toggle.

## Tests added

- `server-jarvis/src/eval/call-model.test.ts` (new, 4 tests) — `resolveModelSupportsNativeTools` branching.
- `server-jarvis/src/intelligence/skill-distillation.test.ts` (+22 tests): `buildGroundingRubric`, `promoteSkillCandidate` (all branches: not-found, wrong-status, heuristic-fail, no-grounding-source, judge-pass, judge-fail, judge-unavailable), `runGroundingJudge`, `updateSkillCandidateEval`, `computeCandidatePerformance`, a demote-clears-`promoted_at` case, and `resolveSkillsForConductor` (task-type-agnostic matching, requirement exclusion, promoted-only, 3-skill cap, hint format).
- `server-jarvis/src/orchestration/persistent-conductor.test.ts` (+3 tests, "D4: KV-safe conductor skill hint" block) — unmatched-turn byte-for-byte regression pin, matched-turn hint presence in the user delta (never the system message), cross-turn system-prompt identity with a hint present.
- `server-jarvis/src/eval/cases.ts` + `harness.ts` (+3 deterministic cases, `skill_grounding` kind) — clean grounding, invented-path-fails-via-mocked-judge, no-snapshot-cannot-ground. `baseline.json` refreshed to 38/38.
- `server-jarvis/src/self-tuning/self-tuning.test.ts` (+1 test) — `getAgentRunsForTaskTypesInWindow` filtering.
- `server-jarvis/src/config.test.ts` (+1 test) — `auto_promote`/`min_judge_score` defaults.
- `src-ui/src/components/jarvis/SkillsView.test.tsx` (new, 4 tests, vitest + `@testing-library/react`) — distilled vs. bundled row actions, Promote → HTTP call → refresh, detail panel candidate fields. Mirrors the existing `useTheme.test.ts` pattern for mocking `@tauri-apps/api/core`.

All new tests were written and watched RED before implementation (TDD), per `superpowers:test-driven-development`.

## D4/D6/demos closeout (follow-up pass, same session)

After the MSS shipped, the remaining Layer B items were closed out:

- **D4 (conductor injection, C-03):** new `resolveSkillsForConductor(message)` in `skill-resolver.ts` matches promoted candidates on requirement + signals only (never `task_type` — routing hasn't happened yet), returns a hint capped at 3 skills / ~400 chars. Wired into `persistent-conductor.ts`'s `buildTurnUserContent` as an appended, filtered-when-empty section — the system prompt (`loadPrompt("coordinator.md")`) is never touched, preserving A-02's KV-cache prefix reuse. 4 new tests in `skill-distillation.test.ts` (matching, exclusion, promoted-only, cap, format) + 3 new tests in `persistent-conductor.test.ts`'s new "D4: KV-safe conductor skill hint" block: an **exact byte-for-byte regression pin** proving an unmatched turn's user-message content is unchanged from the pre-D4 shape, a matched-turn presence check, and a cross-turn system-prompt-identity check. C-03 in the Track C backlog is now fully done (was previously "partial — planner/executor only").
- **D6 (`skill_grounding` eval case kind, C-04):** new `SkillGroundingCase` type + 3 fixtures in `eval/cases.ts` (clean grounding passes, invented-path fixture fails via a canned "judge reports it missed" mock, no-snapshot-available correctly can't ground) and a `runSkillGroundingCase` runner in `harness.ts` using a rubric-agnostic mocked `CallModelFn` (echoes back whatever rubric items `buildGroundingRubric` produced — no live model call, no hardcoded rubric wording to keep in sync). `baseline.json` refreshed via `--write-baseline`: 38/38 passing (was 35).
- **Golden demos doc:** `docs/superpowers/demos/organism-loop-v1.md`. D1 and D2 have a deterministic, model-free proof actually captured this session (`bun run src/eval/harness.ts` output pasted into the doc) — no live server needed to reproduce. D3 (distill → promote → repeat → measure improvement) is written as an accurate copy-paste recipe, explicitly marked as **not yet captured** — no Bun server was running in this session (`curl 127.0.0.1:19877/health` failed), so no live numbers exist to report; the doc says so rather than fabricating a result.

## What diverged from the Layer B spec

- **D3 (trajectory-backed distillation, C-01) was already shipped** by an independent maintenance session (commit `d0cea3c`) that landed on `master` *while this planning session was still writing the spec* — `distillFromTrajectorySnapshot`, the `distill_on` policy config, and the `redistill.ts` CLI all already existed by the time implementation started. The implementation spec was corrected in place to mark D3 done rather than re-implementing it (see the spec's D3 section for the note). No code from this session touches distillation-from-snapshot logic.
- **The bulk `POST /skills/promote` route was deliberately left heuristic-only**, not judge-gated. The spec's D5a section noted this as a possible future refinement; scope was kept to the per-candidate judge-gated path (`POST /skills/candidates/:id/promote`) since that's what the safety fix (item 6 above) actually needs, and running a live judge call over an entire backlog on a single bulk request has real cost/latency implications worth a separate design pass.
- **`src-tauri/src/commands/skills.rs` was not touched.** `sync_distilled_skill_candidates` already existed and correctly projects `status`/`confidence`/`candidate_id` into the native `metadata` JSON; the UI reads the *rest* of the candidate detail (eval score, rejection reason, `promoted_at`, etc.) directly from Bun's `GET /skills/candidates` rather than round-tripping it through Rust — this was flagged as optional in the spec's Files & Hooks table and turned out to be unnecessary given D1's "Bun owns distilled-skill lifecycle" design. No `cargo` changes; 59 cargo tests pass unchanged.
- **`src-ui` had test packages installed (`vitest`, `@testing-library/react`) but genuinely zero component tests when this session started** — one exception was found late (`toast-stability.test.tsx`), which corrected an initial (wrong) assumption that no frontend test infra existed. `@testing-library/user-event` is *not* installed; the new `SkillsView.test.tsx` uses `fireEvent` instead rather than adding a dependency for this pass.

## Verification (all green at time of writing, after the D4/D6/demos closeout)

```
cd server-jarvis && bun test                 # 475 pass, 0 fail
cd server-jarvis && bunx tsc --noEmit         # clean
cd server-jarvis && bun run src/eval/harness.ts  # 38/38 eval cases pass
cd src-ui        && npx tsc -b                # clean
cd src-ui        && npx vitest run            # 20 pass, 0 fail (5 files)
cd src-tauri     && cargo test --lib          # 59 pass, 0 fail (unchanged — no Rust touched)
```

## Live smoke recipe (once the Bun server is running on :19877)

```bash
# 1. Trigger a successful orchestrator turn (any workspace-read or full-execution
#    request) so the post-run hook distills a candidate.

# 2. Confirm it landed as a candidate, not auto-promoted:
curl -s http://127.0.0.1:19877/skills/candidates?status=candidate | jq

# 3. Preview the grounding judge without committing to a status change:
curl -s -X POST http://127.0.0.1:19877/skills/candidates/<id>/eval | jq

# 4. Promote (heuristic gates + judge gate):
curl -s -X POST http://127.0.0.1:19877/skills/candidates/<id>/promote | jq
#    -> {"id":"...", "status":"promoted", "eval_score":0.8, "promoted_at":"..."}
#    or {"id":"...", "status":"rejected", "rejection_reason":"eval_failed", ...}

# 5. Repeat step 1 with a similar request; the next turn's executor/planner
#    prompt should now include the promoted skill's body (resolveSkillsForTurn).

# 6. Once you have enough post-promotion runs, check the performance panel:
curl -s http://127.0.0.1:19877/skills/candidates/<id>/performance | jq

# 7. In the desktop app, open Skills -> Distilled candidates filter -> the
#    candidate row now shows Promote/Reject (or Demote if already promoted)
#    instead of the enable/disable toggle; the detail panel shows confidence,
#    eval score, and (once promoted) the performance-since-promotion summary.
```

## Next highest-leverage gap

With D1–D6 all closed, the largest remaining piece isn't in this spec at all — it's **actually running D3 live** and recording real before/after numbers (the demos doc explicitly flags this as not yet captured; no Bun server was running this session). After that, the next candidates from the handoff's lower-priority list: a scheduled/batch promotion pass (so candidates don't pile up waiting for a manual click through SkillsView), and Phase 2 (Fleet stage) or Phase 3 (Shadow tournament) from the original Tier 1 moonshots handoff — both untouched, forward-pointers only.
