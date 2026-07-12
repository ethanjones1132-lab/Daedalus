# Orchestration Repetition & Performance Re-Audit — Fable 5 Handoff (Jarvis / home-base)

**Created:** 2026-07-12
**Workdir:** `C:\Projects\home-base-recovered`
**Audience:** Fable 5 session with full repo + shell access (this handoff was written by a session that had neither — see "What this session could not verify" at the bottom)
**Trigger:** A live Jarvis chat today spun out repeating itself indefinitely and had to be force-stopped by the operator (Ethan). No transcript was captured before this handoff was written.
**Goal:** **Performance improvement.** Not a re-run of the 2026-07-11 reliability pass — an independent re-audit that treats the existing fix as unproven until you've checked it against real evidence.

---

## Autonomy charter (read this first)

**You are not executing a fixed checklist.** This is context + intent + a working hypothesis space, not a contract.

- Do not assume the 2026-07-11 reliability work (below) actually addresses the repetition incident. Verify against real evidence before building on top of it.
- You may redesign anything in the orchestration/self-tuning layer if you can justify it delivers more performance/reliability value.
- Deliverable bar: the repetition incident is root-caused with **real evidence** (not guesses), a fix + regression test is landed, and you report a **before/after performance number** (latency, token count, or turn count) — not just "should be fixed now."

---

## Step 0 — Get the actual evidence first (do this before touching any code)

The requesting session identified where the evidence lives but could not read it (binary SQLite, no shell available in that session). You have shell access — start here.

**Native session/message history** (`jarvis.db`, SQLite, WAL mode, written by the Rust/Tauri process):

- Path per `memory/windows-hang-root-cause.md`: `C:\Users\ethan\.local\share\com.jarvis.desktop\jarvis.db` (HOME is unset on Windows, so it falls back to a Unix-style path — **not** the usual `%APPDATA%\com.jarvis.desktop\`). Confirm this is still current before trusting it.
- It may be locked by the live app (WAL + a running Rust process). Copy `jarvis.db`, `jarvis.db-wal`, and `jarvis.db-shm` to a scratch dir first and query the copy rather than fighting the lock.
- Schema is in `src-tauri/src/db/migrations.rs`. Relevant tables: `sessions`, `messages` (role/content/created_at per session), `session_runs` (terminal outcome: `success|partial|failed|timed_out|cancelled`, plus `cancelled_reason` and `partial_output` — **this is almost certainly where the force-stop is recorded**).

```sql
-- find the runaway session (most recently updated, or filter by title/model)
SELECT id, agent_id, title, backend, model, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 10;

-- pull every terminal run for it — look for outcome='cancelled' and read cancelled_reason / partial_output
SELECT run_id, outcome, selected_model, token_count, tool_count, cancelled_reason, partial_output, started_at, finished_at
FROM session_runs WHERE session_id = '<id>' ORDER BY finished_at DESC;

-- pull the actual message content — this is what will show you WHAT was repeating (same sentence? same tool call? same stage re-entering?)
SELECT role, content, tokens, tool_calls, created_at FROM messages WHERE session_id = '<id>' ORDER BY created_at ASC;
```

**Bun-side self-tuning data** (stage-level timing/tokens, lives on the **WSL-native filesystem**, per `memory/jarvis-bun-sqlite-cross-boundary-ioerr.md` — do not query it over `/mnt/c`, only read-only spot checks are safe there):

- `~/.openclaw/jarvis/self-tuning.db` inside WSL. Tables per `PRIORITIES.md`: `agent_runs`, `stage_runs`, `model_attributions`, `tuning_proposals`. `stage_runs` has per-turn-number timing and tool-call counts — if one stage (e.g. `reviewer`/`rewriter`, or the persistent conductor) kept re-entering, this table will show it as many rows with the same `agent_run_id` and climbing `turn_number`.

**Also check**, in this order of likely usefulness:

1. `git log --oneline -15` and `git status` in `C:\Projects\home-base-recovered` — **do not trust either of these two conflicting signals blindly**: (a) the Icarus fleet digest from 03:30 this morning (`C:\Projects\.hermes\state\icarus-cycles\2026-07-12-D.json`) reported the 2026-07-11 reliability implementation as **23 uncommitted files on a `codex/*` worktree, still expanding**; (b) `PRIORITIES.md`'s "2026-07-12 overnight" entry claims it was committed as `1d1b8a7` with "working tree clean," followed by a same-day contract-pin commit `f059084`. These can't both be current truth — check the actual repo state yourself first.
2. `%LOCALAPPDATA%\com.jarvis.desktop\logs\Jarvis.log` — app-side log, may have raw stream output if the repetition happened at the token/streaming level rather than the orchestration level.
3. Windows Application event log (`Application Error` / `Application Hang` for `home-base.exe`) — only relevant if this was actually a UI hang rather than a genuine repeating response; `memory/windows-hang-root-cause.md` documents a *different* known hang (boot-time WSL subprocess storm) that's already been hardened, but rule it out.
4. `scripts/benchmark-jarvis-runtime.ps1` and `scripts/smoke-jarvis-runtime.ps1` — already exist, already wired to the "Direct answer / Workspace read / Full execution write-read" scenarios in `docs/reports/2026-07-11-orchestration-performance-evidence.md`. Re-run them yourself rather than trusting that report's numbers — it has a "Verification record" table where every row says "pending live run" directly above a "Live benchmark run (2026-07-12)" section claiming 15/15 passed. Reconcile that contradiction.

---

## Context: what's already been done (don't blindly redo this)

A 2026-07-11 plan (`docs/superpowers/plans/2026-07-11-orchestration-runtime-reliability.md`) diagnosed a live incident: a stalled synthesizer got promoted above every stage default by global feedback, hit a 30s first-token watchdog with no real failover (only empty-response retry existed), the local conductor's routing JSON got truncated and silently fell back to generic routing, and the effect-gate could report success on zero actual writes. The fix (stage-health registry with 5-minute cooldowns, bounded cross-model failover, a compact route-only conductor schema, a terminal no-write failure) is described as landed in `docs/reports/2026-07-11-orchestration-performance-evidence.md` and `PRIORITIES.md`.

**What that work explicitly does NOT cover** (confirmed: zero matches for `loop_detected`, `repetition`, `degenerate` anywhere in `server-jarvis/src/orchestration/`): there is **no detector anywhere in this codebase for a model repeating itself within or across turns**. Everything in the 07-11 pass is about *stage/provider* failure (timeouts, empty completions, malformed routing) — none of it addresses a model that is technically responding, just responding with the same thing over and over. That gap is very likely why the operator had to manually stop the session instead of the system catching it.

---

## Working hypotheses for "repeats indefinitely" — untested, rank/prune against Step 0 evidence

1. **Token-level decoding degeneration** — a classic local/small-model failure mode: low `repetition_penalty` + certain sampling settings cause the model to loop on a phrase or sentence within a *single* generation. None of the 07-11 stage-health/failover logic would ever catch this, because the call is "succeeding" from the transport's point of view. `server-jarvis/src/openrouter.ts` has a `repetition_penalty` field — check whether it's actually set for whichever backend/model produced the runaway session, and whether Ollama-routed local models (persistent conductor, cheap synthesizer defaults) have an equivalent knob wired at all.
2. **Reviewer/rewriter cycle exceeding its stated cap.** `docs/reports/2026-07-11-orchestration-performance-evidence.md`'s "Repair loops" row says full-profile repair "defaults to one round, clamps to 0–2, and exits on no new write effect" — verify this cap is enforced on the *exact* code path the runaway session took, not just described in the doc.
3. **Conductor replan loop escaping its budget.** `SessionReplanCounter` (`orchestration/replan-telemetry.ts`) caps replans at 6/session, 2/turn per `PRIORITIES.md`. Check whether a *new request* (rather than a replan within the same turn) resets that counter in a way that lets the same underlying loop restart indefinitely across turns instead of being capped within one.
4. **Streaming/transport-level duplication** — `VisibleAnswerStreamSanitizer` / `stream-liveness.ts` — could produce visibly "repeating" output in the UI without the model itself looping. Worth ruling out before assuming a model-side bug.
5. **No absolute ceiling that forces a user-visible failure.** `JARVIS_TOTAL_TURN_TIMEOUT_MS` defaults to 480000ms (8 min) per `PRIORITIES.md`'s 2026-07-05 entry — if that's real and enforced, the operator shouldn't have needed to manually intervene at all. Check whether it actually fired, and if not, why not (wrong stage? wrong code path? bypassed by a loop that resets a per-attempt timer instead of the absolute deadline?).

Do not treat this list as the answer — it's a set of places to look, ranked by plausibility given what the code currently does and doesn't guard against. The actual message content from Step 0 will tell you which of these (or something else entirely) is real.

---

## Why this is a performance task, not just a reliability one

Read the operator's brief literally: an unbounded repeating generation is the single worst-case outcome for latency *and* token cost simultaneously — it's not a separate concern from performance, it's the most expensive failure mode possible. Frame the fix that way in your acceptance criteria: closing this is a performance deliverable. Beyond the incident itself, look for:

- Redundant provider calls in the cascade (the 07-11 report's own incident notes an *extra* `stage=coordinator` pool resolution firing after stage completion — confirm that's actually gone, not just described as fixed).
- Whether `LiveConductor.setContext` / `afterConductorStage` (both flagged as buggy in the incident baseline — fake `[stage]` queue, cumulative token double-counting) are verifiably fixed with a test, not just asserted fixed in prose.
- Real p50/p95 numbers from your own benchmark run vs. the numbers already in the 07-11 report — don't just accept the existing table.

---

## Safety rails (same as prior handoffs — not design blockers)

- Keep `bun test` / `cargo test` / both `tsc` jobs green; add tests for new behavior, especially a regression test that reproduces the repetition failure mode and asserts it now terminates/degrades cleanly.
- No credentials in logs or commits.
- If you touch the chat/streaming path, leave a live smoke recipe someone else can run.
- Before calling it done: run `bun test` in `server-jarvis/`, `bunx tsc --noEmit`, `bunx tsc -b` in `src-ui/`, `cargo test --lib` in `src-tauri/` — or explain what you couldn't run.
- Paper trail: append to `PRIORITIES.md` or write `docs/superpowers/plans/2026-07-12-orchestration-repetition-performance-outcome.md` — what the root cause actually was (with evidence), what you changed, and the before/after performance numbers.

---

## Suggested Fable 5 session prompt (paste as first message)

```
You are re-auditing Jarvis's orchestration runtime after a live incident: a chat session repeated
itself indefinitely today and had to be force-stopped by the operator. Goal is performance
improvement, not just reliability.

Read docs/superpowers/plans/2026-07-12-orchestration-repetition-performance-fable5-handoff.md in
full first — it has exact SQLite paths/queries for pulling the runaway session's actual messages
and terminal outcome (Step 0), a list of unverified/possibly-contradictory claims about what's
already fixed (git state, the 07-11 report's own internal contradiction), and five ranked
hypotheses for the root cause. Do Step 0 before writing or changing any code.

Do not assume the 2026-07-11 reliability work (stage-health.ts, bounded conductor routing,
effect-gate truthfulness) already covers this — it explicitly has zero repetition/loop detection
of any kind, confirmed by grep. Find out what actually happened first.

Deliverable: root-caused with real evidence, a landed fix + regression test, and a reported
before/after performance number (latency, tokens, or turn count). Write
docs/superpowers/plans/2026-07-12-orchestration-repetition-performance-outcome.md when done.
```

---

## References

| Resource | Path |
|---|---|
| 2026-07-11 reliability plan (context, not gospel) | `docs/superpowers/plans/2026-07-11-orchestration-runtime-reliability.md` |
| 2026-07-11 performance evidence (has an internal contradiction — verify) | `docs/reports/2026-07-11-orchestration-performance-evidence.md` |
| DB schema | `src-tauri/src/db/migrations.rs` |
| Session/message read paths | `src-tauri/src/commands/sessions.rs` |
| Known Windows hang (different bug, already hardened) | `memory/windows-hang-root-cause.md` |
| Bun/SQLite WSL boundary constraint | `memory/jarvis-bun-sqlite-cross-boundary-ioerr.md` |
| Priority log / commit history narrative | `PRIORITIES.md` |
| Fleet digest showing conflicting commit-state signal | `C:\Projects\.hermes\state\icarus-cycles\2026-07-12-D.json` |
| Benchmark/smoke scripts | `scripts/benchmark-jarvis-runtime.ps1`, `scripts/smoke-jarvis-runtime.ps1` |

---

## What this session could not verify (transparency)

Written by a session with file/search access but no shell and no ability to parse binary SQLite. Could not: open `jarvis.db` to confirm the runaway session's actual content or its `cancelled_reason`; run `git log`/`git status` to resolve the WIP-vs-committed contradiction between the Icarus digest and `PRIORITIES.md`; re-run the benchmark scripts. All three are Step 0 for whoever picks this up.
