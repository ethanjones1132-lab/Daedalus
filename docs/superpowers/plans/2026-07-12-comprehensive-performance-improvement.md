# Jarvis Orchestration — Comprehensive Performance Improvement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 2026-07-12 repetition incident with evidence-grounded fixes, then land executor-accuracy and task-throughput improvements, with before/after performance numbers from the existing benchmark harness.

**Architecture:** Three defense layers around the existing pipeline (`server-jarvis/src/orchestration/pipeline.ts` + `server-jarvis/src/index.ts`): (1) repetition/no-progress guards at the turn and stream level, (2) an evidence-sufficiency gate that replaces the boolean workspace-evidence fence, (3) throughput work (parallel tool dispatch, read-only route slimming, progress-scaled budgets). A fourth workstream resurrects the dark telemetry (`session_runs` empty, `stage_runs` test-only, incident-window log hole) so the next incident is observable.

**Tech Stack:** Bun + TypeScript (server-jarvis), Rust/Tauri (src-tauri), SQLite (jarvis.db, WAL), PowerShell benchmark/smoke scripts.

**Supersedes:** `docs/superpowers/plans/2026-07-12-orchestration-repetition-performance-fable5-handoff.md` — its Step 0 has been executed; results are below. The handoff stays as historical context.

---

## Part A — Step 0 results (evidence gathered 2026-07-12, ~10:20–10:35 local)

### A.1 Repo-state contradiction: RESOLVED

`master` is clean (only the handoff doc untracked). The 2026-07-11 reliability work **plus nine further commits** are landed: `dcd10a2` (provenance), `842a9b4` (truthful telemetry), `d3300c3` (remove redundant live-conductor calls), `8a899dd` + `023c292` (bounded repair loops), `4478757` (turn/stage latency budgets — `turn-budget.ts`), `8c623fd` (admission controller), `73ce56f` (context growth caps), `ee0f22c` (benchmark harness + live run). The Icarus digest's "23 uncommitted files" claim is stale. The 07-11 evidence report's internal contradiction is explained: its "Verification record" table was never populated, but a "Live benchmark run (2026-07-12)" section was appended by `ee0f22c` with real numbers (below).

### A.2 The runaway session: FOUND — and it is NOT token-level degeneration

Session `e21d0533-625d-4f39-92c3-e86487a22f1d` ("Read the contents of this repo and comprehensively diagnose…", target `C:\Projects\Versutus`), 2026-07-12 13:39–13:42 UTC (09:39–09:42 local), 7 messages, backend `openrouter/free`:

| # | Role | Content (condensed) |
|---|------|---------------------|
| 0 | user | "Read the contents of this repo and comprehensively diagnose the gaps in architecture …" |
| 1 | assistant | "I've started exploring… initial inspection **only reached the top-level directory listing**… ask me to read specific files" (3,064 chars) |
| 2 | user | "Complete the thorough and in depth diagnosis" |
| 3 | assistant | "The previous assistant only examined the top-level directory listing… I can't diagnose a system I haven't read… **you can simply ask me to 'read the repo and diagnose the remote-communication gaps' again**" (1,292 chars) |
| 4 | user | *pastes exactly the suggested re-ask* |
| 5 | assistant | A "diagnosis" admittedly "based on the partial repo inspection to date" — still no real file reads (3,058 chars) |
| 6 | user | "Create a comprehensive implementation plan…" — **no assistant reply row exists; this is the force-stop point** |

The repetition is a **cross-turn behavioral loop**: the executor never actually read files; each turn the synthesizer re-narrates that fact and coaches the user to re-ask; the user complies; the loop repeats. Each cycle costs a full pipeline run (~45–60 s, ~1.3–3 k chars of non-answer).

### A.3 Root-cause chain (each link verified in code or data)

1. **Classification**: "Read the contents… diagnose" has no unnegated mutation verb → `workspace_read` (`turn-requirements.ts:199` `classifyTurnRequirements`).
2. **Structural starvation**: `workspace_read` ⇒ `read_only` profile ⇒ executor capped at **2 turns** (`modes.ts:83` `executorTurnLimit`) and a **25,000 ms stage budget** (`turn-budget.ts:20`) — on a provider pool whose measured p50 is **52,731 ms** (07-11 evidence report). The executor structurally cannot read a repo.
3. **Fence too weak**: `hasSuccessfulWorkspaceEvidence` (`pipeline.ts:115`) passes on **one successful `list_directory`** — `WORKSPACE_EVIDENCE_TOOLS` (`pipeline.ts:89`) includes it. One top-level listing counts as "grounded," so the pipeline reports success.
4. **Failure dressed as answer**: the synthesizer converts the evidence shortfall into polite prose, including verbatim re-ask instructions, instead of a typed failure.
5. **No repetition detection**: zero matches for any repetition/degenerate/loop detector in `server-jarvis/src` (re-confirmed post-commits; all grep hits are test padding and comments). Each re-ask replays the loop; nothing compares turn N's answer+evidence to turn N−1's. Note the repeats are **paraphrases, not verbatim**: word-3-shingle overlap between the incident turns is ≈0.00–0.04, while character-trigram Jaccard is 0.315–0.414 (vs 0.092 for a genuinely different answer on the same topic, measured against the live session text). Any detector keyed on exact phrases will miss this failure mode.
6. **Force-stop invisible**: `session_runs` has **zero rows ever** — terminal outcomes (`cancelled`, `timed_out`) are never recorded, so the operator's force-stop left no trace and no signal for tuning.

### A.4 Hypothesis disposition (from the handoff's ranked list)

| # | Hypothesis | Verdict |
|---|-----------|---------|
| 1 | Token-level decoding degeneration | **Not the incident** — recorded messages are coherent, varied prose. Turn 7's uncommitted stream is unobserved, so a cheap intra-stream guard is still worth landing (Task 1.2). |
| 2 | Reviewer/rewriter cycle over cap | **Was real on 07-11** (log shows reviewer↔rewriter ping-pong ≥4 rounds 23:08–23:10 for session `07dc3ece`), but `8a899dd`/`023c292` landed after. Needs a pinned regression test, not a new fix (Task 1.4). |
| 3 | Replan-loop escaping budget | Not the incident — the loop was **user-mediated across turns**; per-turn caps reset by design. Cross-turn no-progress detection (Task 1.1) is the actual missing control. |
| 4 | Streaming/transport duplication | No evidence. Ruled out for this incident. |
| 5 | No absolute ceiling | Partially stale — `turn-budget.ts` now enforces 30–180 s turn deadlines. But the force-stop happened anyway and left no record (A.3 #6). Fix is telemetry (Phase 4), not another timer. |

### A.5 New findings the handoff didn't know

- **Telemetry is dark in production**: `agent_runs`/`stage_runs` in jarvis.db contain only `test-agent-run-id` rows from June; `session_runs` is empty. `PipelineExecutor` calls `this.collector.recordStageRun(...)` on every stage turn — the sink is broken/misrouted in the deployed runtime (Task 4.2).
- **Incident-window log hole**: `server-jarvis.log` jumps from 2026-07-11T23:10 to a **server start at 2026-07-12T14:15:04** — the runtime that served the 13:39–13:42 incident wrote no log lines to the supervised file (Task 4.3).
- **Pool collapse**: on 07-11, *every* stage resolved to `deepseek-v4-pro` (opencode_go) despite claimed coverage of "8 code-strong, 6 reasoning-strong, 6 fast, 9 cheap" (Task 3.4).
- **Conductor JSON still failing**: 07-11 route came from `parse_fallback` and was normalized to `executor→reviewer→synthesizer` — the compact route-only schema did not stop unparseable routing in practice.
- **Credential fragility**: err.log shows OpenRouter free-model HTTP 401 "User not found" episodes and a missing opencode_go key window — each feeds fail-overs and latency.
- **Config spam**: `jarvis_path … is unusable on win32` WARN every 15 s, ~1,400 lines — config re-normalized on every health poll (Task 3.5).
- **Baseline numbers exist** (deployed runtime, 2026-07-12, 15/15 pass): Direct answer p50 2.16 s / p95 2.83 s; Workspace read 9.87 s / 16.76 s; Full execution write-read 48.29 s / 78.56 s. These are the "before" for every task below.

---

## Part B — Success criteria (the deliverable bar)

1. **Incident closure**: a regression test reproduces the cross-turn no-progress loop and asserts it now terminates with a typed failure on the second identical no-progress turn — instead of a third identical non-answer.
2. **Executor accuracy**: a "read the repo and diagnose" request against a fixture repo produces ≥3 successful `read_file`/`grep` evidence calls or a typed `insufficient_workspace_evidence` failure — never a "please ask me again" narration.
3. **Throughput**: benchmark p50s do not regress (Direct ≤ 2.5 s, Workspace read ≤ 10 s), and the new repeated-request scenario shows the second no-progress attempt resolving in **< 5 s** (vs ~50 s baseline).
4. **Observability**: after one live turn, `session_runs` and `stage_runs` contain real (non-test) rows; a force-stopped turn records `outcome='cancelled'`.
5. All gates green: `bun test` (server-jarvis), `bunx tsc --noEmit` (server-jarvis), `bunx tsc -b` (src-ui), `cargo test --lib` (src-tauri), benchmark re-run, live smoke.

Anything in Phase 3 that regresses a benchmark p95 by >15% gets reverted, not tuned in place.

---

## Phase 0 — Pin the evidence (½ hour)

### Task 0.1: Commit the handoff + this plan

**Files:**
- Add: `docs/superpowers/plans/2026-07-12-orchestration-repetition-performance-fable5-handoff.md` (already on disk, untracked)
- Add: `docs/superpowers/plans/2026-07-12-comprehensive-performance-improvement.md` (this file)

- [ ] **Step 1: Commit both docs**

```bash
git add docs/superpowers/plans/2026-07-12-orchestration-repetition-performance-fable5-handoff.md docs/superpowers/plans/2026-07-12-comprehensive-performance-improvement.md
git commit -m "docs: land repetition-incident evidence and comprehensive performance plan"
```

### Task 0.2: Preserve the incident DB snapshot

The scratchpad copy is session-temporary. Keep a durable copy for regression-test fixtures.

- [ ] **Step 1: Copy the checkpointed DB into the repo's gitignored scratch area**

```bash
mkdir -p .hermes/incident-20260712
cp "/c/Users/ethan/AppData/Local/Temp/claude/C--Projects-home-base-recovered/e307eab6-1780-4567-aa65-75aca671535a/scratchpad/db/jarvis.db" .hermes/incident-20260712/jarvis-incident.db
```

(`.hermes/` is already gitignored per PRIORITIES.md — this is operator-local evidence, not a commit.)

---

## Phase 1 — Repetition & no-progress guards (incident closure)

### Task 1.1: Cross-turn no-progress detector

**Files:**
- Create: `server-jarvis/src/orchestration/repetition-guard.ts`
- Test: `server-jarvis/src/orchestration/repetition-guard.test.ts`

The guard compares each finalized orchestrator answer to the previous turn's answer **and** evidence set for the same session. High text similarity + no new evidence = a no-progress repetition. Pure functions first; wiring is Task 1.3.

- [ ] **Step 1: Write the failing tests**

```ts
// server-jarvis/src/orchestration/repetition-guard.test.ts
import { describe, expect, test } from "bun:test";
import {
  trigramsOf,
  jaccard,
  assessRepetition,
  SessionRepetitionStore,
  REPETITION_SIMILARITY_THRESHOLD,
} from "./repetition-guard";

const INCIDENT_TURN_1 =
  "I've started exploring the Versutus repository, but the initial inspection only reached the top-level directory listing. No source files have been read yet, so a comprehensive architectural diagnosis cannot be completed. Ask me to read specific files.";
const INCIDENT_TURN_2 =
  "The previous assistant only examined the top-level directory listing. To provide a thorough and grounded architectural diagnosis I need to inspect the actual source code. I do not have that information — I can't reliably diagnose a system I haven't read. Ask me to read the repo and diagnose again.";

describe("repetition-guard", () => {
  test("jaccard of identical trigram sets is 1", () => {
    const g = trigramsOf("same text here");
    expect(jaccard(g, g)).toBe(1);
  });

  test("incident turns 1 and 2 score above the threshold", () => {
    const sim = jaccard(trigramsOf(INCIDENT_TURN_1), trigramsOf(INCIDENT_TURN_2));
    expect(sim).toBeGreaterThan(REPETITION_SIMILARITY_THRESHOLD);
  });

  test("no-progress repetition is flagged when evidence did not grow", () => {
    const store = new SessionRepetitionStore();
    store.record("s1", INCIDENT_TURN_1, ["list_directory:{\"path\":\"C:\\\\Projects\\\\Versutus\"}"]);
    const verdict = assessRepetition(
      store.lastSignature("s1"),
      INCIDENT_TURN_2,
      ["list_directory:{\"path\":\"C:\\\\Projects\\\\Versutus\"}"],
    );
    expect(verdict.repeated).toBe(true);
    expect(verdict.newEvidence).toBe(false);
  });

  test("similar answer WITH new evidence is not flagged", () => {
    const store = new SessionRepetitionStore();
    store.record("s2", INCIDENT_TURN_1, ["list_directory:{\"path\":\"C:\\\\x\"}"]);
    const verdict = assessRepetition(
      store.lastSignature("s2"),
      INCIDENT_TURN_2,
      ["list_directory:{\"path\":\"C:\\\\x\"}", "read_file:{\"path\":\"C:\\\\x\\\\package.json\"}"],
    );
    expect(verdict.repeated).toBe(false);
    expect(verdict.newEvidence).toBe(true);
  });

  test("dissimilar answers are never flagged", () => {
    const store = new SessionRepetitionStore();
    store.record("s3", INCIDENT_TURN_1, []);
    const verdict = assessRepetition(store.lastSignature("s3"), "Here is the full diagnosis: the gateway lacks a WebSocket transport and message schema.", []);
    expect(verdict.repeated).toBe(false);
  });

  test("store evicts sessions beyond capacity", () => {
    const store = new SessionRepetitionStore(2);
    store.record("a", "one", []);
    store.record("b", "two", []);
    store.record("c", "three", []);
    expect(store.lastSignature("a")).toBeUndefined();
    expect(store.lastSignature("c")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `server-jarvis/`): `bun test src/orchestration/repetition-guard.test.ts`
Expected: FAIL — module `./repetition-guard` not found.

- [ ] **Step 3: Implement**

```ts
// server-jarvis/src/orchestration/repetition-guard.ts
// Cross-turn no-progress detection for the orchestrator (2026-07-12 incident:
// session e21d0533 produced near-identical "I haven't read the files" answers
// across three turns with zero evidence growth). A repetition is only flagged
// when BOTH hold: the finalized answer is textually similar to the previous
// turn's answer AND the successful-evidence set gained nothing new.

// Empirically calibrated against the live incident session (e21d0533):
// real consecutive incident turns score 0.315 and 0.414 trigram Jaccard;
// the condensed test fixtures score 0.346; a genuinely different answer on
// the SAME topic scores 0.092. 0.25 sits between with margin on both sides.
// Never raise above 0.30 without re-measuring against the incident snapshot
// (.hermes/incident-20260712/jarvis-incident.db). The `newEvidence` gate is
// the primary false-positive guard, not this threshold.
export const REPETITION_SIMILARITY_THRESHOLD = 0.25;

export interface TurnSignature {
  trigrams: Set<string>;
  evidenceKeys: Set<string>;
  recordedAt: number;
}

export interface RepetitionVerdict {
  repeated: boolean;
  similarity: number;
  newEvidence: boolean;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_#>\[\]()|:;,.!?"'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function trigramsOf(text: string): Set<string> {
  const n = normalize(text);
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= n.length; i++) grams.add(n.slice(i, i + 3));
  return grams;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function assessRepetition(
  previous: TurnSignature | undefined,
  answer: string,
  evidenceKeys: string[],
): RepetitionVerdict {
  const current = new Set(evidenceKeys);
  if (!previous) return { repeated: false, similarity: 0, newEvidence: current.size > 0 };
  let newEvidence = false;
  for (const key of current) {
    if (!previous.evidenceKeys.has(key)) {
      newEvidence = true;
      break;
    }
  }
  const similarity = jaccard(previous.trigrams, trigramsOf(answer));
  return {
    repeated: similarity >= REPETITION_SIMILARITY_THRESHOLD && !newEvidence,
    similarity,
    newEvidence,
  };
}

/** Bounded per-session store of the last turn's signature (LRU by insertion). */
export class SessionRepetitionStore {
  private signatures = new Map<string, TurnSignature>();
  constructor(private capacity = 200) {}

  lastSignature(sessionId: string): TurnSignature | undefined {
    return this.signatures.get(sessionId);
  }

  record(sessionId: string, answer: string, evidenceKeys: string[]): void {
    if (this.signatures.has(sessionId)) this.signatures.delete(sessionId);
    this.signatures.set(sessionId, {
      trigrams: trigramsOf(answer),
      evidenceKeys: new Set(evidenceKeys),
      recordedAt: Date.now(),
    });
    while (this.signatures.size > this.capacity) {
      const oldest = this.signatures.keys().next().value;
      if (oldest === undefined) break;
      this.signatures.delete(oldest);
    }
  }

  clear(sessionId: string): void {
    this.signatures.delete(sessionId);
  }
}
```

The threshold is **0.25 by measurement, not intuition** — the incident turns are paraphrases (word-shingle overlap ≈0), so only character-trigram similarity discriminates, and it tops out at 0.414 on the real data. The condensed fixtures were verified to score 0.346 (above threshold) and the control 0.090 (below) with exactly this normalizer. If you change the normalizer, re-verify both against the full message texts in the incident snapshot (Task 0.2).

- [ ] **Step 4: Run tests until green**

Run: `bun test src/orchestration/repetition-guard.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/repetition-guard.ts server-jarvis/src/orchestration/repetition-guard.test.ts
git commit -m "feat(orchestration): cross-turn no-progress repetition detector"
```

### Task 1.2: Intra-stream degenerate-output guard

**Files:**
- Create: `server-jarvis/src/stream-degeneration.ts`
- Test: `server-jarvis/src/stream-degeneration.test.ts`

Catches classic token-loop degeneration (a phrase repeating within a single generation) that the recorded incident didn't show but turn 7's uncommitted stream could have. Smallest-period detection over a bounded tail via the KMP failure function — O(window) per check.

- [ ] **Step 1: Write the failing tests**

```ts
// server-jarvis/src/stream-degeneration.test.ts
import { describe, expect, test } from "bun:test";
import { smallestPeriod, detectDegenerateTail } from "./stream-degeneration";

describe("stream-degeneration", () => {
  test("smallestPeriod finds the repeating unit", () => {
    expect(smallestPeriod("abcabcabc")).toBe(3);
    expect(smallestPeriod("aaaa")).toBe(1);
    expect(smallestPeriod("abcdef")).toBe(6);
  });

  test("flags a phrase repeated many times", () => {
    const text = "Here is the diagnosis. " + "The gateway is missing. ".repeat(12);
    expect(detectDegenerateTail(text)).toBe(true);
  });

  test("does not flag normal prose", () => {
    const text =
      "The repository is an Expo application with TypeScript configuration. " +
      "It lacks a WebSocket transport, an authentication handshake, and message routing. " +
      "Each of these gaps has a distinct remediation path described below.";
    expect(detectDegenerateTail(text)).toBe(false);
  });

  test("does not flag legitimately repetitive short structures (markdown table rows)", () => {
    const table = Array.from({ length: 8 }, (_, i) => `| row${i} | value${i} |`).join("\n");
    expect(detectDegenerateTail(table)).toBe(false);
  });

  test("does not fire below the minimum buffer length", () => {
    expect(detectDegenerateTail("ha ha ha ha")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/stream-degeneration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server-jarvis/src/stream-degeneration.ts
// Detects decoding degeneration (a unit of text repeating verbatim) in a
// growing stream buffer. Checks only a bounded tail so it can run on every
// few chunks without cost. Distinct from repetition-guard.ts, which compares
// ACROSS turns; this catches loops WITHIN one generation.

const TAIL_WINDOW = 480;      // chars inspected
const MIN_BUFFER = 240;       // don't judge tiny outputs
const MIN_REPEATS = 5;        // unit must repeat at least this often in the tail
const MIN_UNIT = 8;           // ignore ultra-short periods (whitespace, table pipes)

/** Smallest period of s via KMP failure function; s.length if aperiodic. */
export function smallestPeriod(s: string): number {
  const n = s.length;
  const fail = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    let j = fail[i - 1];
    while (j > 0 && s[i] !== s[j]) j = fail[j - 1];
    if (s[i] === s[j]) j++;
    fail[i] = j;
  }
  const period = n - fail[n - 1];
  return n % period === 0 ? period : n;
}

export function detectDegenerateTail(buffer: string): boolean {
  if (buffer.length < MIN_BUFFER) return false;
  const tail = buffer.slice(-TAIL_WINDOW);
  const period = smallestPeriod(tail);
  if (period >= MIN_UNIT && period <= tail.length / MIN_REPEATS) return true;
  // Fallback for a long unit that repeats but the tail isn't unit-aligned:
  // check whether the last quarter of the tail appears at least MIN_REPEATS
  // times inside the tail.
  const probe = tail.slice(-Math.floor(TAIL_WINDOW / 4));
  if (probe.trim().length < MIN_UNIT) return false;
  let count = 0;
  let idx = tail.indexOf(probe);
  while (idx !== -1) {
    count++;
    idx = tail.indexOf(probe, idx + 1);
  }
  return count >= MIN_REPEATS;
}
```

- [ ] **Step 4: Run tests until green**

Run: `bun test src/stream-degeneration.test.ts`
Expected: PASS (5 tests). If the table-row test fails, raise `MIN_UNIT` — do not special-case markdown.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/stream-degeneration.ts server-jarvis/src/stream-degeneration.test.ts
git commit -m "feat(streaming): intra-stream degenerate-output detector"
```

### Task 1.3: Wire both guards into the runtime

**Files:**
- Modify: `server-jarvis/src/index.ts` (orchestrator finalization in `streamJarvis`, both stream read loops)
- Modify: `server-jarvis/src/orchestration/replan-loop.ts` (new error code)
- Test: extend `server-jarvis/src/orchestration/repetition-guard.test.ts` contract already covers pure logic; add one wiring test below

**Wiring points** (both already exist — find them by the markers named):

1. **Cross-turn guard** — in `streamJarvis`'s orchestrator path in `index.ts`, at the seam where `result.answer` is checked for empty/whitespace (the empty-answer fallback landed 2026-06-25). Immediately before emitting a non-empty answer:

```ts
// module scope, near other singletons:
import { SessionRepetitionStore, assessRepetition } from "./orchestration/repetition-guard";
const repetitionStore = new SessionRepetitionStore();

// inside streamJarvis, before emitting result.answer:
const evidenceKeys = (result.tool_calls ?? [])
  .filter((c: any) => !c.is_error)
  .map((c: any) => `${c.name}:${JSON.stringify(c.arguments)}`);
// Scope to evidence-bearing turns only: conversational/answer_only turns
// legitimately produce similar consecutive answers with zero tool evidence
// (e.g. the user asks the same question twice on purpose).
const evidenceBearing = turnRequirement === "workspace_read" || turnRequirement === "full_execution";
const verdict = evidenceBearing
  ? assessRepetition(repetitionStore.lastSignature(sessionId), result.answer, evidenceKeys)
  : { repeated: false, similarity: 0, newEvidence: false };
if (verdict.repeated) {
  console.warn(`[Jarvis Orchestrator] no-progress repetition detected session=${sessionId} similarity=${verdict.similarity.toFixed(2)} — refusing to re-emit`);
  result.answer =
    "I produced essentially the same answer as last turn without gathering any new evidence, so repeating it would waste your time. " +
    "The underlying problem: the execution stage did not read the files it needed. " +
    "Tell me a specific file or directory to start from, or say 'force deep read' to retry with extended budgets.";
  result.error_code = "no_progress_repetition";
  result.outcome = "failed";
} else {
  repetitionStore.record(sessionId, result.answer, evidenceKeys);
}
```

Adapt field names to the actual `runPipelineWithReplanning` result shape (`answer`, `outcome`, `error_code` exist per `replan-loop.ts:261-267`; confirm how tool calls surface — if the result doesn't carry them, thread `toolCalls` from the final segment's executor state, which `ExecutorStageOutput` already returns). **The store must be cleared when a session is deleted** — hook the session-delete command path if one exists in `index.ts`; otherwise LRU eviction is the backstop.

2. **Intra-stream guard** — in both stream read loops (orchestrator ~line 1828 abort-domain comment, agent loop ~line 3081), where the inter-token watchdog already lives. Accumulate visible text (both loops already do), and every 16 chunks:

```ts
import { detectDegenerateTail } from "./stream-degeneration";
// in the read loop, after appending chunk to accumulated:
if (chunkCount % 16 === 0 && detectDegenerateTail(accumulated)) {
  console.warn(`[Jarvis] degenerate stream detected model=${actualModelUsed} stage=${stageLabel} — cancelling reader`);
  degenerateDetected = true;
  await reader.cancel();
  break;
}
// after the loop, mirror the StreamIdleTimeoutError pattern:
if (degenerateDetected) {
  throw new DegenerateStreamError(actualModelUsed, stageLabel);
}
```

Define `DegenerateStreamError` next to `FirstTokenTimeoutError`/`StreamIdleTimeoutError` (same file, same shape — model, stage). It must be **caught by the same handler that feeds stage-health**, so a degenerating model takes a strike and fail-over picks a different candidate — that is what makes this a performance control, not just an abort.

3. **Error code registration** — `no_progress_repetition` and `degenerate_stream` join the `errorCode` values in `replan-loop.ts` outcome finalization so telemetry can attribute them.

- [ ] **Step 1: Locate both wiring seams and confirm the result shape**

Run: `grep -n "produced no output\|synthesizerEmptyCompletion\|result.answer" server-jarvis/src/index.ts | head -20`
Expected: the empty-answer fallback site in `streamJarvis`.

- [ ] **Step 2: Write a wiring test for the error classes**

```ts
// append to server-jarvis/src/stream-degeneration.test.ts
import { DegenerateStreamError } from "./index"; // adjust: export it from wherever the sibling error classes live
test("DegenerateStreamError carries model and stage", () => {
  const err = new DegenerateStreamError("deepseek-v4-pro", "synthesizer");
  expect(err.message).toContain("deepseek-v4-pro");
  expect(err.message).toContain("synthesizer");
});
```

If the sibling error classes live in a non-exported position in `index.ts`, move `DegenerateStreamError` into `stream-degeneration.ts` instead and import it from `index.ts` — do not export from `index.ts` just for a test.

- [ ] **Step 3: Implement the wiring per the sketches above**

- [ ] **Step 4: Full test + typecheck**

Run (from `server-jarvis/`): `bun test && bunx tsc --noEmit`
Expected: all green (391+ tests).

- [ ] **Step 5: Commit**

```bash
git add -A server-jarvis/src
git commit -m "feat(orchestration): wire repetition and degeneration guards into stream + finalization paths"
```

### Task 1.4: Pin the repair-loop cap with a regression test

The 07-11 log shows reviewer↔rewriter ping-ponging ≥4 rounds before `8a899dd` landed. The cap is now claimed (default 1 round, clamp 0–2, exit on no new write effect). Pin it.

**Files:**
- Test: `server-jarvis/src/orchestration/replan-loop.test.ts` (extend)

- [ ] **Step 1: Read the current repair-round implementation**

Run: `grep -n "repair\|clamp\|addedWriteProgress" server-jarvis/src/orchestration/replan-loop.ts server-jarvis/src/orchestration/pipeline.ts | head -30`

- [ ] **Step 2: Add a test that requests 5 repair rounds and asserts ≤2 execute, and a test that a round with zero new write-effect keys exits immediately**

Model it on the existing tests in `replan-loop.test.ts` (they already stub segments). Assert on the count of rewriter invocations, not on prose.

- [ ] **Step 3: Run, expect PASS immediately** (the cap already exists — this is a pin). If it FAILS, that is a live bug: fix the clamp in place before proceeding.

Run: `bun test src/orchestration/replan-loop.test.ts`

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/orchestration/replan-loop.test.ts
git commit -m "test(orchestration): pin repair-loop round cap and no-progress exit"
```

---

## Phase 2 — Executor accuracy

### Task 2.1: Evidence sufficiency replaces the boolean fence

**Files:**
- Create: `server-jarvis/src/orchestration/evidence-sufficiency.ts`
- Test: `server-jarvis/src/orchestration/evidence-sufficiency.test.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts:115-121` (replace `hasSuccessfulWorkspaceEvidence` call sites at `pipeline.ts:581` and the post-loop fence)

One `list_directory` must never again count as "grounded" for a repo-level request.

- [ ] **Step 1: Write the failing tests**

```ts
// server-jarvis/src/orchestration/evidence-sufficiency.test.ts
import { describe, expect, test } from "bun:test";
import { assessWorkspaceEvidence, isDeepReadRequest } from "./evidence-sufficiency";

const ls = { name: "list_directory", arguments: { path: "C:\\repo" }, output: "src/\npackage.json", is_error: false, duration_ms: 10 };
const read = (p: string) => ({ name: "read_file", arguments: { path: p }, output: "{...contents...}", is_error: false, duration_ms: 12 });
const failedRead = { name: "read_file", arguments: { path: "C:\\repo\\src" }, output: "EISDIR: is a directory", is_error: true, duration_ms: 5 };

describe("evidence-sufficiency", () => {
  test("repo-level diagnosis requests are deep reads", () => {
    expect(isDeepReadRequest("Read the contents of this repo and comprehensively diagnose the gaps in architecture")).toBe(true);
    expect(isDeepReadRequest("what does src/index.ts export?")).toBe(false);
  });

  test("a lone list_directory is insufficient for a deep read", () => {
    const a = assessWorkspaceEvidence([ls], "Read the contents of this repo and comprehensively diagnose it");
    expect(a.sufficient).toBe(false);
    expect(a.reason).toContain("list_directory");
  });

  test("listing plus three file reads is sufficient", () => {
    const a = assessWorkspaceEvidence([ls, read("a.ts"), read("b.ts"), read("c.json")], "comprehensively diagnose this repo");
    expect(a.sufficient).toBe(true);
  });

  test("failed reads do not count", () => {
    const a = assessWorkspaceEvidence([ls, failedRead], "comprehensively diagnose this repo");
    expect(a.sufficient).toBe(false);
  });

  test("a shallow request is satisfied by one successful read", () => {
    const a = assessWorkspaceEvidence([read("package.json")], "what version is in package.json?");
    expect(a.sufficient).toBe(true);
  });

  test("a shallow request is still satisfied by one list_directory (unchanged behavior)", () => {
    const a = assessWorkspaceEvidence([ls], "list the files in C:\\repo");
    expect(a.sufficient).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/orchestration/evidence-sufficiency.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server-jarvis/src/orchestration/evidence-sufficiency.ts
// Replaces the boolean workspace-evidence fence. 2026-07-12 incident: one
// successful top-level list_directory satisfied hasSuccessfulWorkspaceEvidence,
// so a "comprehensively diagnose this repo" turn was treated as grounded with
// zero file contents read. Sufficiency now scales with request depth.

import type { ToolCallRecord } from "./stage-output";

const DEEP_READ_MARKERS =
  /\b(comprehensiv\w*|thorough\w*|entire|whole|all files|full|in[- ]depth|architecture|architectural|audit|diagnos\w*|repo|repository|codebase)\b/i;
const CONTENT_EVIDENCE_TOOLS = new Set(["read_file", "grep", "git_metadata"]);
const LISTING_TOOLS = new Set(["list_directory", "glob"]);
export const DEEP_READ_MIN_CONTENT_READS = 3;

export interface EvidenceAssessment {
  sufficient: boolean;
  contentReads: number;
  listings: number;
  deepRead: boolean;
  reason: string;
}

export function isDeepReadRequest(request: string): boolean {
  return DEEP_READ_MARKERS.test(request);
}

export function assessWorkspaceEvidence(
  toolCalls: ToolCallRecord[] | undefined,
  request: string,
): EvidenceAssessment {
  const calls = (toolCalls ?? []).filter((c) => !c.is_error && c.output.trim().length > 0);
  const contentReads = calls.filter((c) => CONTENT_EVIDENCE_TOOLS.has(c.name)).length;
  const listings = calls.filter((c) => LISTING_TOOLS.has(c.name)).length;
  const deepRead = isDeepReadRequest(request);

  if (deepRead) {
    const sufficient = contentReads >= DEEP_READ_MIN_CONTENT_READS;
    return {
      sufficient, contentReads, listings, deepRead,
      reason: sufficient
        ? `deep read satisfied: ${contentReads} content reads`
        : `deep-read request needs >=${DEEP_READ_MIN_CONTENT_READS} content reads (read_file/grep); got ${contentReads} content reads and ${listings} list_directory/glob calls`,
    };
  }
  const sufficient = contentReads + listings >= 1;
  return {
    sufficient, contentReads, listings, deepRead,
    reason: sufficient ? "shallow read satisfied" : "no successful workspace tool result",
  };
}
```

- [ ] **Step 4: Run tests until green**

Run: `bun test src/orchestration/evidence-sufficiency.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Replace both call sites in pipeline.ts**

At `pipeline.ts:581` (the nudge condition) and the post-loop fence (~line 640), replace `hasSuccessfulWorkspaceEvidence(toolCalls)` with `assessWorkspaceEvidence(toolCalls, request).sufficient`. Include the assessment's `reason` in the nudge message so the executor model is told exactly what is missing:

```ts
const assessment = assessWorkspaceEvidence(toolCalls, request);
// nudge message becomes:
`Workspace evidence is insufficient: ${assessment.reason}. Read actual file contents with read_file (start with package.json, README, and the main source entrypoints), then answer from what you read.`
```

Keep `hasSuccessfulWorkspaceEvidence` exported-deleted (remove it) — update `stage_runs` `missing_workspace_evidence` recording to use `!assessment.sufficient`. Also raise the nudge allowance: `workspaceEvidenceNudgeSent` currently permits exactly one repair round; keep one nudge but let Task 2.4's budget extension give it room to act.

- [ ] **Step 6: Run the full orchestration suite**

Run: `bun test src/orchestration/ && bunx tsc --noEmit`
Expected: green. Existing tests that asserted one `list_directory` passes the fence will fail if their request text matches deep-read markers — fix the tests only where the new behavior is genuinely intended.

- [ ] **Step 7: Commit**

```bash
git add -A server-jarvis/src/orchestration
git commit -m "feat(orchestration): depth-scaled evidence sufficiency replaces boolean workspace fence"
```

### Task 2.2: Deterministic read preflight for deep-read requests

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts` (`runExecutorStage`, next to the existing `git_metadata` preflight at ~line 501)
- Test: `server-jarvis/src/orchestration/pipeline-preflight.test.ts` (create)

The `git_metadata` preflight pattern already exists because "some text-protocol providers decline to emit a tool block even after the runtime advertises one." Extend the same pattern: for deep-read requests, the **runtime** performs `list_directory` on the workspace root plus `read_file` on up to 5 anchor files (`package.json`, `README.md`, `Cargo.toml`, `pyproject.toml`, `tsconfig.json` — whichever the listing shows), and seeds the executor conversation with the results. Weak models start grounded instead of having to choose tools correctly under a 25 s clock.

- [ ] **Step 1: Write the failing test**

Extract the anchor-selection logic as a pure function so it's testable without a runtime:

```ts
// server-jarvis/src/orchestration/pipeline-preflight.test.ts
import { describe, expect, test } from "bun:test";
import { selectAnchorFiles } from "./pipeline";

describe("selectAnchorFiles", () => {
  test("picks known anchors from a directory listing, capped at 5", () => {
    const listing = ["src/", "package.json", "README.md", "tsconfig.json", "eas.json", "app.json", "Cargo.toml"];
    const anchors = selectAnchorFiles(listing);
    expect(anchors).toContain("package.json");
    expect(anchors).toContain("README.md");
    expect(anchors.length).toBeLessThanOrEqual(5);
  });
  test("returns empty for a listing with no anchors", () => {
    expect(selectAnchorFiles(["photos/", "video.mp4"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/orchestration/pipeline-preflight.test.ts`
Expected: FAIL — `selectAnchorFiles` not exported.

- [ ] **Step 3: Implement**

```ts
// in pipeline.ts, module scope:
const ANCHOR_FILES = ["package.json", "README.md", "readme.md", "Cargo.toml", "pyproject.toml", "tsconfig.json", "app.json", "go.mod"];
export function selectAnchorFiles(listingEntries: string[]): string[] {
  const files = new Set(listingEntries.map((e) => e.replace(/[\\/]+$/, "").trim()));
  return ANCHOR_FILES.filter((a) => files.has(a)).slice(0, 5);
}
```

Then in `runExecutorStage`, after the `git_metadata` preflight block, add (same structure — real `runToolCall`, push to `toolCalls`, push a `[Runtime preflight: …]` user message, `onStateChange` per tool):

```ts
if (requiresWorkspaceEvidence && isDeepReadRequest(request)) {
  const workspaceRoot = extractWorkspaceRoot(request); // the quoted/absolute path in the request, if any; else the configured jarvis workspace root
  const listCall: ToolCall = { id: `call_${crypto.randomUUID()}`, name: "list_directory", arguments: { path: workspaceRoot } };
  const listResult = await this.runToolCall(listCall, options);
  // record into toolCalls exactly like the git_metadata preflight does
  if (!listResult.is_error) {
    const anchors = selectAnchorFiles(toolResultModelText(listResult).split(/\r?\n/));
    for (const anchor of anchors) {
      const readCall: ToolCall = { id: `call_${crypto.randomUUID()}`, name: "read_file", arguments: { path: joinPath(workspaceRoot, anchor) } };
      const readResult = await this.runToolCall(readCall, options);
      // record into toolCalls + executorMessages, same pattern
    }
  }
  executorMessages.push({
    role: "user",
    content: "[Runtime preflight] The listing and anchor files above are already read. Continue by reading the specific source files needed to answer; do not re-list the root.",
  });
}
```

`extractWorkspaceRoot`: reuse whatever the tool runtime uses to resolve relative paths (check `workspace-affinity.ts` first — it likely already extracts the workspace path from the request; if so, import it instead of writing a new extractor).

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/orchestration/ && bunx tsc --noEmit`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A server-jarvis/src/orchestration
git commit -m "feat(orchestration): deterministic listing+anchor-file preflight for deep-read requests"
```

### Task 2.3: Auto-substitute read_file-on-directory

**Files:**
- Modify: `server-jarvis/src/tool-heal.ts`
- Test: `server-jarvis/src/tool-heal.test.ts` (extend)

`tool-heal.ts` already classifies `is_directory` errors and returns a healing *hint* — but the hint costs a full model round-trip (~50 s on this pool) to act on. Substitute the correct call at the runtime layer instead: when `read_file` errors with `is_directory`, immediately execute `list_directory` on the same path and return its output annotated as substituted. This directly fixes the known "P2 executor read_file-on-dir" behavioral failure.

- [ ] **Step 1: Write the failing test**

```ts
// append to server-jarvis/src/tool-heal.test.ts
import { substituteToolCall } from "./tool-heal";

test("read_file on a directory substitutes list_directory on the same path", () => {
  const sub = substituteToolCall("read_file", { path: "C:\\repo\\src" }, "EISDIR: illegal operation, path is a directory");
  expect(sub).toEqual({ name: "list_directory", arguments: { path: "C:\\repo\\src" }, note: "read_file targeted a directory; auto-substituted list_directory" });
});

test("other errors return null (no substitution)", () => {
  expect(substituteToolCall("read_file", { path: "C:\\x.ts" }, "ENOENT: no such file")).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure** — `bun test src/tool-heal.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// in tool-heal.ts:
export interface ToolSubstitution {
  name: string;
  arguments: Record<string, unknown>;
  note: string;
}

export function substituteToolCall(
  name: string,
  args: Record<string, unknown>,
  errorOutput: string,
): ToolSubstitution | null {
  if (name === "read_file" && classifyToolError(errorOutput) === "is_directory" && typeof args.path === "string") {
    return {
      name: "list_directory",
      arguments: { path: args.path },
      note: "read_file targeted a directory; auto-substituted list_directory",
    };
  }
  return null;
}
```

Note: `classifyToolError` currently matches `"is a directory"`; the test above uses `"path is a directory"` which contains that substring. If EISDIR raw text on Windows differs (`illegal operation on a directory`), extend the classifier to also match `/\beisdir\b/i` — add a classifier test for it.

Then in the executor's tool-dispatch (the `for (const tc of response.tool_calls)` block in `runExecutorStage`), after a failed `runToolCall`:

```ts
if (toolResult.is_error) {
  const sub = substituteToolCall(call.name, call.arguments, toolResultModelText(toolResult));
  if (sub) {
    const subCall: ToolCall = { id: `call_${crypto.randomUUID()}`, name: sub.name, arguments: sub.arguments };
    const subResult = await this.runToolCall(subCall, options);
    // record BOTH: the original failed call and the substituted call (marked in output with sub.note)
  }
}
```

- [ ] **Step 4: Run** — `bun test src/tool-heal.test.ts && bun test src/orchestration/ && bunx tsc --noEmit` → green.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/tool-heal.ts server-jarvis/src/tool-heal.test.ts server-jarvis/src/orchestration/pipeline.ts
git commit -m "feat(tools): auto-substitute list_directory when read_file targets a directory"
```

### Task 2.4: Progress-scaled executor budget

**Files:**
- Modify: `server-jarvis/src/orchestration/turn-budget.ts`
- Test: `server-jarvis/src/orchestration/turn-budget.test.ts` (extend)
- Modify: `server-jarvis/src/orchestration/pipeline.ts` (executor loop reports progress)
- Modify: `server-jarvis/src/orchestration/modes.ts:83` (`executorTurnLimit`)

The 25 s `workspace_read` executor budget vs 52.7 s provider p50 is the structural starvation. Do **not** blanket-raise budgets (that trades away the latency wins from `4478757`). Instead: each executor turn that adds **new successful evidence** extends the executor stage budget, up to a hard ceiling that still respects the turn deadline and finalization reserve.

- [ ] **Step 1: Write the failing tests**

```ts
// append to server-jarvis/src/orchestration/turn-budget.test.ts
import { createTurnBudget } from "./turn-budget";

test("evidence progress extends the executor stage budget up to the ceiling", () => {
  const b = createTurnBudget("workspace_read", "medium", 0);
  expect(b.stage_ms.executor).toBe(25_000);
  b.extendStageOnProgress("executor", 1);
  expect(b.stage_ms.executor).toBe(45_000);
  b.extendStageOnProgress("executor", 3);
  expect(b.stage_ms.executor).toBe(90_000); // ceiling, not 25k + 4*20k
});

test("extension also relaxes the turn deadline but never past the absolute cap", () => {
  const b = createTurnBudget("workspace_read", "medium", 0);
  const before = b.deadlineAt;
  b.extendStageOnProgress("executor", 1);
  expect(b.deadlineAt).toBeGreaterThan(before);
  for (let i = 0; i < 20; i++) b.extendStageOnProgress("executor", 1);
  expect(b.turn_ms).toBeLessThanOrEqual(180_000);
});

test("stages without a configured budget are unaffected", () => {
  const b = createTurnBudget("conversational", "low", 0);
  b.extendStageOnProgress("executor", 2);
  expect(b.stage_ms.executor).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure** — `bun test src/orchestration/turn-budget.test.ts` → FAIL (`extendStageOnProgress` missing).

- [ ] **Step 3: Implement**

```ts
// turn-budget.ts additions:
const PROGRESS_EXTENSION_MS = 20_000;      // per evidence-producing turn
const STAGE_EXTENSION_CEILING_MS = 90_000; // executor may never exceed this
const ABSOLUTE_TURN_CAP_MS = 180_000;      // matches the existing high-complexity cap

// add to the TurnBudget interface:
//   extendStageOnProgress(stage: string, newEvidenceCount: number): void;

// add to the budget object literal in createTurnBudget:
extendStageOnProgress(stage: string, newEvidenceCount: number) {
  if (newEvidenceCount <= 0) return;
  const current = this.stage_ms[stage];
  if (current === undefined) return;
  const extension = Math.min(newEvidenceCount, 3) * PROGRESS_EXTENSION_MS;
  const next = Math.min(STAGE_EXTENSION_CEILING_MS, current + extension);
  const granted = next - current;
  if (granted <= 0) return;
  this.stage_ms[stage] = next;
  this.turn_ms = Math.min(ABSOLUTE_TURN_CAP_MS, this.turn_ms + granted);
  this.deadlineAt = this.startedAt + this.turn_ms;
},
```

Then in `runExecutorStage`, at the end of each loop iteration, count evidence added this turn and report it (thread the budget in via `PipelineExecuteOptions` — check how `4478757` already passes the budget to the pipeline; reuse that seam):

```ts
const evidenceAddedThisTurn = toolCalls.slice(turnStartIdx).filter((c) => !c.is_error && c.output.trim().length > 0).length;
options.turnBudget?.extendStageOnProgress("executor", evidenceAddedThisTurn);
```

And raise the read-only turn ceiling in `modes.ts` so the budget — not an arbitrary 2 — is the binding constraint:

```ts
export function executorTurnLimit(profile: ExecutionProfile): number {
  return profile === "read_only" ? 4 : BUILTIN_MODES.executor.max_turns;
}
```

- [ ] **Step 4: Run** — `bun test src/orchestration/ && bunx tsc --noEmit` → green. The existing `4478757` stage-health tests must still pass unchanged; if any asserted a frozen 25 s executor budget, update only those.

- [ ] **Step 5: Commit**

```bash
git add -A server-jarvis/src/orchestration
git commit -m "feat(orchestration): evidence-progress-scaled executor budgets; read_only turn limit 2 -> 4"
```

### Task 2.5: Synthesizer honesty gate

**Files:**
- Modify: `server-jarvis/src/prompts/modes/synthesizer.md` (or the synthesizer stage prompt file found in Step 1)
- Modify: `server-jarvis/src/orchestration/pipeline.ts` (synthesis fence)
- Test: `server-jarvis/src/orchestration/synthesizer-grounding.test.ts` (extend)

Two rules: (1) insufficient evidence must yield the typed failure, never a prose apology; (2) the synthesizer must never instruct the user to re-send the request — the incident's turn 3 literally scripted the user's next message, manufacturing the loop.

- [ ] **Step 1: Find the synthesizer prompt + the existing grounding tests**

Run: `ls server-jarvis/src/prompts/modes/ && grep -n "insufficient\|re-ask\|ask me" server-jarvis/src/prompts/modes/synthesizer.md`

- [ ] **Step 2: Add the failing test**

```ts
// append to server-jarvis/src/orchestration/synthesizer-grounding.test.ts
// (mirror the file's existing harness for invoking the synthesis fence)
test("insufficient evidence on a deep read yields insufficient_workspace_evidence, not prose", () => {
  // build a pipeline state where executor.ok === true but
  // assessWorkspaceEvidence(...).sufficient === false for a deep-read request,
  // using the same fixtures the file already uses for the MISSING_WORKSPACE_EVIDENCE fence.
  // Assert: outcome === "failed", error_code === "insufficient_workspace_evidence",
  // and the user-visible answer does NOT contain the phrase "ask me".
});
```

Write it concretely against the file's existing helpers — this file already tests the `MISSING_WORKSPACE_EVIDENCE` fence, so the harness exists; the new case differs only in fixtures (evidence present but insufficient).

- [ ] **Step 3: Implement**

In the pipeline synthesis path, before invoking the synthesizer for a `workspace_read`/deep-read turn:

```ts
const assessment = assessWorkspaceEvidence(executorOutput.toolCalls, request);
if (!assessment.sufficient) {
  return failTurn("insufficient_workspace_evidence",
    `I could not gather enough evidence to answer this (${assessment.reason}). ` +
    `Name a starting file or directory, or say 'force deep read' to retry with extended budgets.`);
}
```

(`failTurn` = whatever the `MISSING_WORKSPACE_EVIDENCE` path already does — reuse it, changing only code + message.) In the synthesizer prompt add one rule:

```
Never tell the user to re-send or re-phrase their request. If the pipeline
could not gather evidence, the runtime fails the turn before you run; your
job is only to synthesize from evidence that exists.
```

- [ ] **Step 4: Run** — `bun test src/orchestration/synthesizer-grounding.test.ts && bun test && bunx tsc --noEmit` → green.

- [ ] **Step 5: Commit**

```bash
git add -A server-jarvis/src
git commit -m "feat(orchestration): typed insufficient-evidence failure; synthesizer barred from re-ask coaching"
```

---

## Phase 3 — Task throughput

### Task 3.1: Parallel read-only tool dispatch in the executor

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts` (`runExecutorStage` tool-dispatch loop; also the rewriter's identical loop)
- Test: `server-jarvis/src/orchestration/pipeline-parallel-tools.test.ts` (create)

The dispatch is currently `for (const tc of response.tool_calls) { await ... }` — strictly serial. When a model emits 5 `read_file` calls in one turn, that's 5× sequential filesystem waits. Run read-only calls concurrently; preserve order for writes.

- [ ] **Step 1: Write the failing test**

```ts
// server-jarvis/src/orchestration/pipeline-parallel-tools.test.ts
import { describe, expect, test } from "bun:test";
import { partitionToolCalls } from "./pipeline";

const call = (name: string) => ({ id: `c_${name}`, name, arguments: {} });

describe("partitionToolCalls", () => {
  test("read-only calls form parallel batches; writes are serial barriers in order", () => {
    const batches = partitionToolCalls([
      call("read_file"), call("grep"), call("write_file"), call("read_file"), call("edit_file"),
    ].map((c, i) => ({ ...c, id: `c${i}` })));
    expect(batches.map((b) => b.map((c) => c.name))).toEqual([
      ["read_file", "grep"],
      ["write_file"],
      ["read_file"],
      ["edit_file"],
    ]);
  });
  test("all-read input is a single batch", () => {
    const batches = partitionToolCalls([call("read_file"), call("glob"), call("list_directory")]);
    expect(batches.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (`partitionToolCalls` not exported).

- [ ] **Step 3: Implement**

```ts
// pipeline.ts, module scope:
const READ_ONLY_TOOLS = new Set(["read_file", "list_directory", "glob", "grep", "git_metadata"]);

export function partitionToolCalls<T extends { name: string }>(calls: T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  for (const c of calls) {
    if (READ_ONLY_TOOLS.has(c.name)) {
      current.push(c);
    } else {
      if (current.length) batches.push(current);
      batches.push([c]);
      current = [];
    }
  }
  if (current.length) batches.push(current);
  return batches;
}
```

Replace the serial loop in `runExecutorStage` (and the rewriter's twin):

```ts
for (const batch of partitionToolCalls(response.tool_calls)) {
  const results = await Promise.all(batch.map((tc) => this.runToolCall(tc, options).then((r) => ({ tc, r }))));
  for (const { tc, r } of results) {
    // existing per-call recording: toolCalls.push(...), executorMessages.push tool message, onStateChange
    // (tool messages must be appended in batch order so tool_call_id pairing stays deterministic)
  }
}
```

Keep the Task 2.3 substitution inside the per-result handling (substitution itself is a read, safe to run inline).

- [ ] **Step 4: Run** — `bun test src/orchestration/ && bunx tsc --noEmit` → green.

- [ ] **Step 5: Commit**

```bash
git add -A server-jarvis/src/orchestration
git commit -m "perf(orchestration): parallel dispatch for read-only tool batches"
```

### Task 3.2: Read-only route slimming

**Files:**
- Modify: `server-jarvis/src/orchestration/route-normalization.ts`
- Test: `server-jarvis/src/orchestration/route-normalization.test.ts` (extend)

The 07-11 log shows `workspace_read`-class requests normalized to `executor→reviewer→synthesizer`. The reviewer (1 turn, read-only tools) adds a full provider round-trip (~50 s on this pool) to a turn that mutates nothing and whose grounding is now enforced by the evidence gate (Task 2.1/2.5) — strictly better placed than a second weak model reviewing prose. Read-only turns route `executor→synthesizer`.

- [ ] **Step 1: Read the current normalization rules**

Run: `grep -n "reviewer\|workspace_read\|full_execution" server-jarvis/src/orchestration/route-normalization.ts | head -20`

- [ ] **Step 2: Add the failing test** — normalization of any route for `requirement === "workspace_read"` drops `reviewer` and `rewriter`; `full_execution` routes are unchanged. Model on the file's existing test style.

- [ ] **Step 3: Implement** — in the normalization function, after existing rules:

```ts
if (requirement === "workspace_read") {
  pipeline = pipeline.filter((stage) => stage !== "reviewer" && stage !== "rewriter");
  if (!pipeline.includes("executor")) pipeline.unshift("executor");
  if (pipeline[pipeline.length - 1] !== "synthesizer") pipeline.push("synthesizer");
}
```

- [ ] **Step 4: Run** — `bun test src/orchestration/route-normalization.test.ts && bun test` → green.

- [ ] **Step 5: Commit**

```bash
git add -A server-jarvis/src/orchestration
git commit -m "perf(orchestration): workspace_read routes drop reviewer/rewriter stages"
```

### Task 3.3: Fail-fast memo for repeated no-progress requests

**Files:**
- Modify: `server-jarvis/src/index.ts` (before pipeline admission, same seam as Task 1.3's guard)
- Test: extend `server-jarvis/src/orchestration/repetition-guard.test.ts`

Task 1.1 stops the *third* identical answer. This task stops the *second identical pipeline run*: if the incoming request is near-identical to the previous request in the same session AND the previous turn ended `no_progress_repetition` / `insufficient_workspace_evidence`, don't run the full pipeline again to rediscover the same failure — reply immediately (<1 s) with the prior failure reason plus what would unblock it. "force deep read" (or any request naming a concrete file) bypasses the memo.

- [ ] **Step 1: Add the failing tests**

```ts
// append to repetition-guard.test.ts
import { shouldShortCircuitRepeat } from "./repetition-guard";

test("re-sending a near-identical request after a no-progress failure short-circuits", () => {
  expect(shouldShortCircuitRepeat(
    { request: "read the repo and diagnose the gaps", errorCode: "no_progress_repetition" },
    "read the repo and diagnose the gaps",
  )).toBe(true);
});

test("naming a concrete file bypasses the short-circuit", () => {
  expect(shouldShortCircuitRepeat(
    { request: "read the repo and diagnose the gaps", errorCode: "no_progress_repetition" },
    "read src/gateway.ts and diagnose the gaps",
  )).toBe(false);
});

test("force deep read bypasses the short-circuit", () => {
  expect(shouldShortCircuitRepeat(
    { request: "read the repo and diagnose", errorCode: "insufficient_workspace_evidence" },
    "force deep read: read the repo and diagnose",
  )).toBe(false);
});

test("a previous SUCCESS never short-circuits", () => {
  expect(shouldShortCircuitRepeat(
    { request: "read the repo and diagnose", errorCode: undefined },
    "read the repo and diagnose",
  )).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement in repetition-guard.ts**

```ts
export interface PreviousTurnOutcome {
  request: string;
  errorCode: string | undefined;
}

const SHORT_CIRCUIT_CODES = new Set(["no_progress_repetition", "insufficient_workspace_evidence"]);
const BYPASS = /\bforce deep read\b/i;
const CONCRETE_PATH = /[\w.-]+\.[a-z0-9]{1,8}\b|[\w-]+[\\/][\w./\\-]+/i;

export function shouldShortCircuitRepeat(previous: PreviousTurnOutcome, request: string): boolean {
  if (!previous.errorCode || !SHORT_CIRCUIT_CODES.has(previous.errorCode)) return false;
  if (BYPASS.test(request)) return false;
  if (CONCRETE_PATH.test(request) && !CONCRETE_PATH.test(previous.request)) return false;
  return jaccard(trigramsOf(previous.request), trigramsOf(request)) >= REPETITION_SIMILARITY_THRESHOLD;
}
```

Extend `SessionRepetitionStore` to also retain `{ request, errorCode }` per session (`recordOutcome(sessionId, request, errorCode)`, `lastOutcome(sessionId)`), then wire in `streamJarvis` before pipeline admission: on short-circuit, stream the canned failure explanation and return without running the pipeline.

- [ ] **Step 4: Run** — `bun test && bunx tsc --noEmit` → green.

- [ ] **Step 5: Commit**

```bash
git add -A server-jarvis/src
git commit -m "perf(orchestration): fail-fast memo for repeated no-progress requests"
```

### Task 3.4: Investigate pool collapse + credential 401s (diagnosis task — fix follows evidence)

**Files:**
- Read: `server-jarvis/src/orchestration/agent-pool.ts` (`pickFor`, availability filtering from `b936f76`)
- Read: live `config.json` at `C:\Users\ethan\.openclaw\jarvis\config.json`

On 07-11 every stage resolved to `deepseek-v4-pro` (opencode_go). If that's "last provider standing" (others disabled by missing/invalid keys — the 401 "User not found" episodes), the fix is credentials + a health surface, **not** code.

- [ ] **Step 1: Determine why each non-opencode_go agent lost eligibility**

Run: `grep -n "enabled\|availab\|api_key\|hasKey" server-jarvis/src/orchestration/agent-pool.ts | head -20` and inspect `config.json`'s provider blocks (do not print key values). Check whether the OpenRouter key is present/valid — err.log's `401 User not found` says it was not on 07-11.

- [ ] **Step 2: Decide by evidence**
  - If OpenRouter key invalid → operator action item (report it; do not commit credentials).
  - If keys fine but `pickFor` still funnels to one agent → add a stage-spread rule: when ≥2 healthy providers cover a stage, `pickFor` avoids assigning the same provider to every stage of one turn. Gate this behind the benchmark (Part D) — revert if p95 regresses >15%.

- [ ] **Step 3: Either way, surface it** — add pool-diversity to `/health/inference`: distinct providers eligible per stage right now. One test in `agent-pool.test.ts` asserting the coverage shape.

- [ ] **Step 4: Commit**

```bash
git add -A server-jarvis/src
git commit -m "fix(pool): surface per-stage provider diversity; address single-provider collapse"
```

### Task 3.5: Stop the 15-second config-warning churn

**Files:**
- Locate: `grep -rn "is unusable on win32" server-jarvis/src/`

~1,400 identical WARNs/day means config is re-parsed and re-normalized on every health poll. Cache the normalized config (or persist the corrected `jarvis_path` once with an explicit save) and log the warning once per process.

- [ ] **Step 1: Find the call path** (who re-reads config every 15 s — likely the health handler).
- [ ] **Step 2: Memoize the normalization result keyed by config-file mtime; WARN only on first normalization.**
- [ ] **Step 3: Test:** call the loader twice, assert one WARN (spy on `console.warn`).
- [ ] **Step 4: Commit**

```bash
git add -A server-jarvis/src
git commit -m "perf(config): memoize config normalization; warn once instead of every health poll"
```

---

## Phase 4 — Telemetry resurrection (make the next incident observable)

### Task 4.1: Record terminal outcomes in session_runs — including force-stop

**Files:**
- Read: `src-tauri/src/db/migrations.rs` (session_runs schema), `src-tauri/src/commands/sessions.rs`
- Locate the writer: `grep -rn "session_runs" src-tauri/src/ server-jarvis/src/`

`session_runs` has zero rows ever. Either the INSERT is never called, or it doesn't exist.

- [ ] **Step 1: Find whether an INSERT exists and which layer owns terminal outcomes** (Rust SseRelay end vs Bun `streamJarvis` finalization).
- [ ] **Step 2: Wire all five outcomes** at the layer that observes them: `success`/`partial`/`failed` at `streamJarvis` finalization (it has `outcome` + `error_code` from `replan-loop.ts`); `cancelled` where the stream abort/stop-generation command lands (Rust side sees the client disconnect — record `cancelled_reason='client_stop'`); `timed_out` from `TurnDeadlineExceededError`.
- [ ] **Step 3: Tests:** one cargo test inserting and reading back a `cancelled` run; one bun test asserting the finalization path invokes the recorder with the right outcome mapping (stub the recorder).
- [ ] **Step 4: Live check:** run the app, send one message, force-stop a second one, then:

```bash
# from a scratch copy of jarvis.db as in Part A
bun -e 'import {Database} from "bun:sqlite"; const db=new Database("db/jarvis.db"); db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); console.log(db.query("SELECT outcome, cancelled_reason, selected_model FROM session_runs ORDER BY rowid DESC LIMIT 5").all())'
```

Expected: one `success` row and one `cancelled` row.

- [ ] **Step 5: Commit**

```bash
git add -A src-tauri server-jarvis
git commit -m "fix(telemetry): record all terminal outcomes in session_runs including cancelled"
```

### Task 4.2: Fix the dark stage_runs/agent_runs collector in production

**Files:**
- Locate: `grep -rn "recordStageRun\|recordAgentRun\|class.*Collector" server-jarvis/src/ | head`

`PipelineExecutor` calls `this.collector.recordStageRun(...)` on every stage turn, yet production jarvis.db has only June test rows. The collector's sink is misrouted (likely a self-tuning DB path that doesn't exist on the Windows-native deploy — `C:\Users\ethan\.openclaw\jarvis\` has no `self-tuning.db`) or silently no-ops on open failure.

- [ ] **Step 1: Trace the collector's DB path resolution in the deployed configuration.** Reproduce locally: instantiate the collector the way `index.ts` does under a Windows profile and observe where (or whether) it writes.
- [ ] **Step 2: Fix:** point it at a Windows-native path that exists (either jarvis.db's own `stage_runs`/`agent_runs` tables — they exist — or `%LOCALAPPDATA%\com.jarvis.desktop\self-tuning.db`), and **log the resolved sink path once at startup**: `[Jarvis Telemetry] stage-run sink: <path>`. An open failure must WARN loudly, never silently no-op.
- [ ] **Step 3: Test:** collector writes a row to a temp DB and reads it back; open-failure path emits the warning (spy) and subsequent record calls don't throw.
- [ ] **Step 4: Live check:** one orchestrator turn, then query `stage_runs` for rows with `agent_run_id != 'test-agent-run-id'` and today's date.
- [ ] **Step 5: Commit**

```bash
git add -A server-jarvis/src
git commit -m "fix(telemetry): stage-run collector resolves a real Windows sink and fails loudly"
```

### Task 4.3: Close the incident-window log hole

**Files:**
- Locate: how the Bun server's stdout reaches `server-jarvis.log` — `grep -rn "server-jarvis.log" src-tauri/src/ scripts/`

The runtime serving 13:39–13:42 UTC wrote nothing to the supervised log; lines resume only at a 14:15:04 restart. Determine which process served the incident (supervisor-spawned vs manually-started vs stale instance — the Two-Desktops trap) and make every serving path log.

- [ ] **Step 1: Identify all spawn paths** (supervisor in `src-tauri`, `scripts/build-and-deploy.ps1`, manual). For each: is stdout/stderr piped to the log?
- [ ] **Step 2: Fix the silent path(s)** so any process that binds :19877 appends to `server-jarvis.log` (pass the log path into the Bun process and have `index.ts` tee its own console output there — self-logging survives any spawn method).
- [ ] **Step 3: Verify:** start via the app, confirm a startup line; kill and start manually via `bun index.js`, confirm a startup line again.
- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix(observability): every server spawn path writes to server-jarvis.log"
```

---

## Phase 5 — Prove it (benchmarks, regression scenario, paper trail)

### Task 5.1: Add the repeated-request scenario to the benchmark

**Files:**
- Modify: `scripts/benchmark-jarvis-runtime.ps1`
- Modify: `scripts/smoke-jarvis-runtime.ps1`

- [ ] **Step 1: Add scenario "Repeated no-progress request":** POST the same un-answerable deep-read request twice to `/chat/stream` (a fixture directory containing only binary files works — evidence can never be sufficient). Measure both durations. Gate: second response arrives in **< 5 s** and carries `no_progress_repetition` or the short-circuit memo text.
- [ ] **Step 2: Run the full benchmark before merging Phase 1–3 to a deployed build (baseline) and after (candidate):**

```powershell
powershell -File scripts/benchmark-jarvis-runtime.ps1 -Iterations 5
```

Baseline (2026-07-12, pre-plan): Direct 2.16/2.83 s; Workspace read 9.87/16.76 s; Full execution 48.29/78.56 s (p50/p95). Targets: Direct ≤2.5 s p50 (no regression); Workspace read p50 may rise moderately (deeper evidence) but p95 ≤60 s SLO holds; repeated-request second attempt <5 s vs ~50 s baseline (**~10× on the incident's failure mode — this is the headline before/after number**).

- [ ] **Step 3: Reconcile the evidence report:** populate the "Verification record" table in `docs/reports/2026-07-11-orchestration-performance-evidence.md` with this run's actual outputs, or mark the table superseded by the new outcome doc.

### Task 5.2: Full verification gate

- [ ] Run all of:

```bash
cd server-jarvis && bun test && bunx tsc --noEmit
cd ../src-ui && bunx tsc -b
cd ../src-tauri && cargo test --lib
```

- [ ] Rebuild + redeploy per `memory/build-optimized-ps1-husk.md` (use `cargo tauri build`, NOT build-optimized.ps1), verify the RUNNING server via `/health` git_sha (Two-Desktops trap), re-run `scripts/smoke-jarvis-runtime.ps1`.

### Task 5.3: Live incident-replay smoke

- [ ] Against the deployed app, replay the incident: "Read the contents of this repo and comprehensively diagnose the gaps in architecture … `C:\Projects\Versutus`", then "Complete the thorough and in depth diagnosis".
- Expected now: turn 1 either produces a diagnosis grounded in ≥3 real file reads (preflight + extended budgets) **or** fails typed with what it needs; turn 2 either progresses with new evidence or short-circuits in <5 s. **No re-ask coaching in any reply.**
- [ ] Force-stop a turn mid-stream; verify a `cancelled` row in `session_runs` (Task 4.1's query).

### Task 5.4: Outcome document + memory

- [ ] Write `docs/superpowers/plans/2026-07-12-orchestration-repetition-performance-outcome.md`: the A.3 root-cause chain (with the session table from A.2), what landed per phase, and the before/after table (benchmark trio + repeated-request scenario + repeated-turn token counts from the now-live `stage_runs`).
- [ ] Append a dated entry to `PRIORITIES.md`.

```bash
git add docs PRIORITIES.md
git commit -m "docs: repetition incident outcome with before/after performance evidence"
```

---

## Execution order & dependencies

```
Phase 0 ──► Task 1.1 ──► Task 1.3 ──► Task 3.3
                │             ▲
Task 1.2 ───────┘             │
Task 1.4 (independent)        │
Task 2.1 ──► Task 2.2, 2.5 ───┘
Task 2.3, 2.4 (after 2.1)
Task 3.1, 3.2 (after Phase 2; benchmark-gated)
Task 3.4, 3.5 (independent, diagnosis-led)
Phase 4 (independent of 1–3; do 4.1/4.2 early if you want repeated-turn token numbers in the outcome doc)
Phase 5 last.
```

Highest value if time-boxed: **1.1 → 1.3 → 2.1 → 2.5 → 3.3 → 4.1 → 5.x** — that alone closes the incident, fixes the accuracy hole that caused it, makes retries cheap, and makes force-stops visible.

## Kill criteria (autonomy charter carried forward)

- Any Phase 3 change regressing benchmark p95 >15% → revert that change, keep the rest.
- If Task 3.4 shows the pool collapse is purely a credentials problem, do not build a diversity mechanism — report the operator action and move on.
- If the repetition-guard threshold produces a false positive on the live smoke (legitimately similar consecutive answers, e.g. user asks the same question twice on purpose with evidence present), remember: `newEvidence` already gates it — investigate before loosening the threshold.

## References

| Resource | Path |
|---|---|
| Superseded handoff (historical) | `docs/superpowers/plans/2026-07-12-orchestration-repetition-performance-fable5-handoff.md` |
| 07-11 reliability plan | `docs/superpowers/plans/2026-07-11-orchestration-runtime-reliability.md` |
| 07-11 perf remediation plan | `docs/superpowers/plans/2026-07-11-orchestration-runtime-performance-remediation.md` |
| Evidence report (baseline numbers) | `docs/reports/2026-07-11-orchestration-performance-evidence.md` |
| Incident DB snapshot | `.hermes/incident-20260712/jarvis-incident.db` (after Task 0.2) |
| Runaway session id | `e21d0533-625d-4f39-92c3-e86487a22f1d` |
| Executor stage | `server-jarvis/src/orchestration/pipeline.ts:473` (`runExecutorStage`) |
| Evidence fence (to replace) | `server-jarvis/src/orchestration/pipeline.ts:89,115` |
| Turn budgets | `server-jarvis/src/orchestration/turn-budget.ts` |
| Turn classification | `server-jarvis/src/orchestration/turn-requirements.ts:199` |
| Executor turn limit | `server-jarvis/src/orchestration/modes.ts:83` |
| Tool healing | `server-jarvis/src/tool-heal.ts` |
| Benchmark / smoke | `scripts/benchmark-jarvis-runtime.ps1`, `scripts/smoke-jarvis-runtime.ps1` |
| Live DB (copy before querying) | `C:\Users\ethan\.local\share\com.jarvis.desktop\jarvis.db` (+ `-wal`, `-shm`) |
| Server logs | `%LOCALAPPDATA%\com.jarvis.desktop\logs\server-jarvis.log`, `server-jarvis.err.log` |
