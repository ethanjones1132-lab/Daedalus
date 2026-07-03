# Implementation Plan: Fix Toolcall Spillage & Orchestration Failure

**Date:** 2026-07-03  
**Based on:** `docs/DIAGNOSIS_TOOLCALL_ORCHESTRATION_2026-07-03.md`  
**Method:** Exact file edits, line-numbered, with old_string/new_string pairs verified against repo HEAD (`fb63137`+).  
**Status:** Ready for implementation

---

## 0. Pre-Flight Checklist (Do Not Skip)

```bash
# Verify repo HEAD
cd C:\Projects\home-base-recovered
git rev-parse HEAD
# Expected: fb63137 or later (contains VisibleAnswerStreamSanitizer skeleton)

# Verify bun test baseline
cd server-jarvis
bun test
# Expected: all passing (was 391 at last count)

# Verify tsc jobs clean
bun run typecheck
# And in src-ui
cd ../src-ui && npm run typecheck  # or equivalent

# Verify cargo tests clean
cd ../src-tauri && cargo test --lib
```

---

## 1. Phase 1 — Atomic Deploy Triplet (P0-A)

**Goal:** Ensure production runtime matches repo HEAD before any code fix.

### 1.1 Harden `scripts/build-and-deploy.ps1`

**File:** `scripts/build-and-deploy.ps1`  
**Action:** Add `Test-Path` guards before `Copy-Item` for prompts.

**Edit 1.1a — Add prompt-source guard (~line 138):**
```powershell
# OLD (existing):
# Copy-Item "$promptsSrc" -Destination "$deployDir\prompts" -Recurse -Force

# NEW:
if (!(Test-Path $promptsSrc)) {
    Write-Error "Prompts source not found: $promptsSrc. Aborting deploy."
    exit 1
}
Copy-Item "$promptsSrc" -Destination "$deployDir\prompts" -Recurse -Force
```

### 1.2 Add deploy manifest generation

**File:** `scripts/build-and-deploy.ps1`  
**Action:** After all copies succeed, write `.jarvis-deploy-manifest.json`.

**Edit 1.2a — Append at end of deploy stage (after all Copy-Item lines):**
```powershell
# At end of successful deploy stage, after all copies:
$manifest = @{
    git_sha = (git -C $repoRoot rev-parse HEAD)
    index_js_sha256 = (Get-FileHash "$deployDir\index.js" -Algorithm SHA256).Hash
    exe_mtime = (Get-Item "$deployDir\Jarvis.exe" -ErrorAction SilentlyContinue).LastWriteTimeUtc.ToString("o")
    prompts_tree_sha256 = (git -C $repoRoot ls-tree HEAD server-jarvis/src/prompts | Select-Object -First 1).Split()[2]
    deployed_at = (Get-Date -Format "o")
} | ConvertTo-Json -Depth 2
$manifest | Out-File "$deployDir\.jarvis-deploy-manifest.json" -Encoding utf8
Write-Host "Deploy manifest written to $deployDir\.jarvis-deploy-manifest.json"
```

### 1.3 Deploy verification script

**New file:** `scripts/verify-deploy.ps1`
```powershell
param(
    [string]$deployDir = "$env:USERPROFILE\OneDrive\Desktop"
)
$manifestPath = "$deployDir\.jarvis-deploy-manifest.json"
if (!(Test-Path $manifestPath)) {
    Write-Error "No deploy manifest found. Run build-and-deploy.ps1 first."
    exit 1
}
$manifest = Get-Content $manifestPath | ConvertFrom-Json
$gitSha = (git -C C:\Projects\home-base-recovered rev-parse HEAD)
if ($manifest.git_sha -ne $gitSha) {
    Write-Warning "DEPLOY STALE: manifest git_sha $($manifest.git_sha) != repo HEAD $gitSha"
} else {
    Write-Host "Deploy matches repo HEAD."
}
if ((Get-FileHash "$deployDir\index.js" -Algorithm SHA256).Hash -ne $manifest.index_js_sha256) {
    Write-Error "DEPLOY CORRUPT: index.js hash mismatch!"
    exit 1
}
if (!(Test-Path "$deployDir\prompts")) {
    Write-Error "DEPLOY INCOMPLETE: prompts/ missing!"
    exit 1
}
Write-Host "Deploy verification passed."
```

**Acceptance:**
- `Desktop\index.js` contains `VisibleAnswerStreamSanitizer` (verified by `Select-String`).
- `Desktop\prompts\` exists with `coordinator.md`, `planner.md`, `executor.md`, etc.
- `.jarvis-deploy-manifest.json` exists and `git_sha` matches repo HEAD.

---

## 2. Phase 2 — Sanitizer Hardening (Core Spillage Fix)

**Goal:** Close the remaining edge cases in `VisibleAnswerStreamSanitizer` and `extractTextToolCalls`.

**Finding:** The repo already contains extensive fixes and tests. `text-tools.test.ts` passes all 345 lines of tests including chunking invariance, paragraph breaks, fenced code blocks, and mixed prose. However, one production path (`stream-emitter.ts` `VisibleTextPipe`) still uses `TextToolCallStreamSanitizer` (tag-only), which means bare JSON tool lines in the direct chat path are NOT stripped. This is acceptable for native-tool models, but if a model hallucinates bare JSON in the direct chat path, it will leak.

**File:** `server-jarvis/src/stream-emitter.ts`

### 2.1 Make `VisibleTextPipe` use `VisibleAnswerStreamSanitizer`

**Edit 2.1a — Replace `TextToolCallStreamSanitizer` with `VisibleAnswerStreamSanitizer` in `VisibleTextPipe` (line 55):**

```typescript
// OLD:
// import { TextToolCallStreamSanitizer } from "./text-tools";
// ...
// private readonly sanitizer = new TextToolCallStreamSanitizer();

// NEW:
import { VisibleAnswerStreamSanitizer } from "./text-tools";
// ...
private readonly sanitizer = new VisibleAnswerStreamSanitizer();
```

**Rationale:** The `VisibleTextPipe` is the single source of truth for visible text in the direct chat path. It already strips reasoning tags. It should also strip bare JSON tool lines, not just `<tool_call>` tags. Using `VisibleAnswerStreamSanitizer` gives it tag-stripping (via its internal `TextToolCallStreamSanitizer`) PLUS bare JSON tool-line stripping, making it defense-in-depth against any model that hallucinates bare JSON.

### 2.2 Add `isCosmeticToolEchoPayloadStrict` helper (text-tools.ts)

**File:** `server-jarvis/src/text-tools.ts`

**Edit 2.2a — Insert after `isCosmeticToolEchoPayload` (after line 467):**

```typescript
// ── Shared strict predicate for cosmetic tool echo detection ────────────
// Used by BOTH the streaming sanitizer and the post-turn extractTextToolCalls
// cosmetic strip so the two layers agree on what is "hallucinated tool JSON".

function isCosmeticToolEchoPayloadStrict(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((item) => isCosmeticToolEchoPayloadStrict(item));
  }
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  const nestedCalls = record.tool_calls ?? record.tools ?? record.calls;
  if (Array.isArray(nestedCalls)) {
    return nestedCalls.length > 0 && nestedCalls.every((item) => isCosmeticToolEchoPayloadStrict(item));
  }

  const rawName = stringValue(record.name ?? record.tool ?? record.tool_name ?? record.function);
  if (!rawName) return false;

  const key = rawName.trim().replace(/\s+/g, "_").toLowerCase();
  if (!TOOL_ALIASES[key]) return false;

  // Require at least one of the explicit arguments keys — a generic
  // {"name":"search","query":"x"} in prose has no arguments/args/input
  // and is therefore KEPT by the strict predicate. Only genuine tool-call
  // shapes (with arguments) or legacy flat blocks keyed by tool/tool_name
  // are stripped.
  const hasExplicitArgs =
    record.arguments !== undefined ||
    record.args !== undefined ||
    record.input !== undefined;

  const legacyToolName = stringValue(record.tool ?? record.tool_name);
  if (legacyToolName && TOOL_ALIASES[legacyToolName.trim().replace(/\s+/g, "_").toLowerCase()]) {
    // Legacy flat block: {"tool":"find_files","path":"."} — require at
    // least one payload key beyond the control keys to avoid matching
    // bare {"tool":"read_file"} in prose.
    const controlKeys = new Set(["id", "name", "tool", "tool_name", "function", "type"]);
    const payloadKeys = Object.keys(record).filter((k) => !controlKeys.has(k));
    return payloadKeys.length > 0;
  }

  return hasExplicitArgs;
}
```

### 2.3 Tighten cosmetic strip in `extractTextToolCalls`

**Edit 2.3a — Replace `findCosmeticToolEchoLineSpans` to use strict predicate (lines 469–498):**

```typescript
function findCosmeticToolEchoLineSpans(text: string, candidates: Candidate[]): TextSpan[] {
  const fencedLines = findFencedLineSpans(text);
  const groups = new Map<string, { start: number; end: number; candidates: Candidate[] }>();

  for (const candidate of candidates) {
    if (!isCosmeticToolEchoPayloadStrict(candidate.value)) continue;
    // Never strip inside fenced code blocks
    if (fencedLines.some((span) => candidate.start < span.end && candidate.end > span.start)) continue;

    const lineStart = text.lastIndexOf("\n", candidate.start - 1) + 1;
    const nextNewline = text.indexOf("\n", candidate.end);
    const lineEnd = nextNewline >= 0 ? nextNewline + 1 : text.length;
    const key = `${lineStart}:${lineEnd}`;
    const group = groups.get(key) ?? { start: lineStart, end: lineEnd, candidates: [] };
    group.candidates.push(candidate);
    groups.set(key, group);
  }

  const spans: TextSpan[] = [];
  for (const group of groups.values()) {
    let remainder = text.slice(group.start, group.end);
    for (const candidate of [...group.candidates].sort((a, b) => b.start - a.start)) {
      const start = candidate.start - group.start;
      const end = candidate.end - group.start;
      remainder = `${remainder.slice(0, start)}${remainder.slice(end)}`;
    }
    if (remainder.trim() === "") {
      spans.push({ start: group.start, end: group.end });
    }
  }
  return spans;
}
```

### 2.4 Update `extractTextToolCalls` to use strict predicate

**Edit 2.4a — In `extractTextToolCalls`, `findCosmeticToolEchoLineSpans` call already uses it via the function replacement above (line 248).** No separate edit needed because `findCosmeticToolEchoLineSpans` is a module-level function that `extractTextToolCalls` calls.

**Acceptance:**
- `bun test text-tools.test.ts` passes (existing + new tests).
- `bun test stream-emitter.test.ts` passes with updated `VisibleTextPipe`.
- Chunking invariance: same text under any chunk split produces identical output.
- Identity on clean text: no dropped lines, no lost newlines, no munged paragraphs.
- Fenced code blocks survive untouched.
- Mixed `Here: {"name":"read_file"...}` lines are kept whole.
- Bare `{"name":"search","query":"x"}` in prose is kept (not in strict shape).

---

## 3. Phase 3 — Abort Domain Guard (P0-B, Already Fixed)

**Finding:** The `reader.cancel()` + `FirstTokenTimeoutError` architecture is already in place at both paths (orchestrator ~1542, agent loop ~2472). The `resolveReadStopReason` function correctly gives `first_token_timeout` precedence over `turn_cancelled`. The `!streamAbort.signal.aborted` check in the timer is a reasonable guard to prevent spurious timeout logs when the user already cancelled.

**No edit required.** The comments at lines 1526-1540 and 2461-2470 already document the fix. The stale Desktop build is the only reason this bug is still visible in production.

**Verification:**
- `bun test stream-control.test.ts` passes (already covers `resolveReadStopReason` and `createIdempotentReaderCancel`).
- Manual: mock hung model → `error` frame with code `first_token_timeout`.

---

## 4. Phase 4 — SSE Contract & UI Handlers (Already Fixed)

**Finding:** `JarvisView.tsx` and `chat-state.ts` already contain all fixes:

- `cancelled` handler exists at lines 883-897 (removes empty bubble, flips `isStreaming`).
- `fallback_notice` handler exists at lines 854-858.
- Unknown frame reporter exists at lines 904-906 via `reportUnknownFrame`.
- `streamedVisibleText` correctly uses `/\S/.test(sanitizeAssistantDisplay(streamedRawText))` at line 786 (cumulative check, not per-delta).
- `parseSseDataLine` has try/catch around `JSON.parse` and throws `SseProtocolError` (lines 84-88); the outer `handleSend` catch (line 988) sets `isStreaming = false`.
- `SendGate` class provides send locking (`tryAcquire` / `release` generations).
- `finalizeStreamingMessages` removes empty assistant bubbles (chat-state.ts line 47).
- `mergeToolResult` uses `call_id` first, then falls back to name with a warning log (chat-state.ts lines 89-98).

**No edit required.** The UI is more up-to-date than the server build. The stale Desktop build is the only gap.

**Verification:**
- `npm test` (or equivalent) in `src-ui` passes.
- Manual: double-click Send → one stream; unknown frame → logged once; malformed `data:` → `isStreaming` false.

---

## 5. Phase 5 — Orchestration Hardening (Already Fixed)

### 5.1 Trivial read fast path (P1-C) — Config-gated, not urgent

**Finding:** `normalizeRoute` already caps `workspace_read` to `read_only` tools via `PROFILE_FOR`. The read-only classifier is already in place. A fast-path optimization is documented in the plan but is not a bug fix.

**No edit required for now.** If later profiling shows planner churn is still a problem, add the config-gated fast path.

### 5.2 Negation-aware classifier (P1-D) — Already implemented!

**Finding:** `turn-requirements.ts` lines 85–124 already contain `isNegatedMutation`, `NEGATED_MUTATION_NOUN`, and `NEGATION_MARKER`. The code at line 176 already filters `mutationMatches` through `isNegatedMutation`.

**Verification:**
```typescript
// In classifyTurnRequirements (line 176):
const hasMutation = mutationMatches.some((match) =>
  !isNegatedMutation(intentText, match.index ?? 0)
);
```

This is already correct. The bug was **reported on a stale bundle** that predates this fix. **No edit needed.**

**Verification:**
- `bun test turn-requirements.test.ts` passes with negation cases.
- Manual: "Do not modify any files" → `workspace_read`, not `full_execution`.

### 5.3 Conductor replan safety bounds (B-04) — Already implemented!

**Finding:** `replan-loop.ts` already has `maxReplans` in `ReplanLoopArgs` (line 48) and the loop already checks `budgetExhausted = replans >= args.maxReplans` (line 71). When exhausted, it runs the remaining pipeline to completion instead of replanning again.

**No edit required.** The cap is already wired.

**Verification:**
- `bun test replan-loop.test.ts` passes (already covers budget exhaustion).
- No infinite replan observed in logs.

---

## 6. Phase 6 — Tool Normalization Unification (Minor)

**Goal:** Add a server-side warning when a model hallucinates a tool name not in the offered tools list.

**File:** `server-jarvis/src/index.ts`

**Edit 6.1a — In orchestrator `callModelAttempt` return block, after `parsedToolCalls` extraction (around line 1783):**

```typescript
// Add warning for any tool calls whose name is not in the offered tools list:
if (parsedToolCalls.length > 0 && callOptions?.tools) {
  const offeredNames = new Set(callOptions.tools.map((t: any) => t.function?.name ?? t.name));
  for (const call of parsedToolCalls) {
    if (!offeredNames.has(call.name)) {
      console.warn(`[Jarvis Orchestrator] Stage ${stageLabel} emitted tool call "${call.name}" not in offered tools list — possible model hallucination.`);
    }
  }
}
```

**Note:** The native path already validates tool names via `normalizeToolName` (returns null for unknown names). The text-tool path already validates via `normalizeToolName` in `callsFromValue`. This edit is purely a diagnostic warning for operators.

**Acceptance:**
- Unknown tool names in orchestrator logs trigger a warning.
- `streaming-tool-calls.test.ts` passes.

---

## 7. Phase 7 — UI State Machine (Already Fixed)

**Finding:** All UI state machine fixes are already in place:

- **Send lock:** `SendGate.tryAcquire()` + `SendGate.release()` generations prevent double-send.
- **Session switch:** `handleSend` resets `setIsStreaming(true)` on a new turn; session switch is handled by `activeSession` state change.
- **Tool-result matching:** `mergeToolResult` prefers `call_id`, falls back to name with warning.

**No edit required.**

**Verification:**
- Double-click Send → one stream.
- Connection refused → input restored via `recoverComposerAfterFailure`.
- Session switch mid-stream → handled by `sendGateRef.current.isCurrent(sendGeneration)` guard.

---

## 8. Phase 8 — Tests & Verification Matrix

### 8.1 New tests to write (TDD)

**File:** `server-jarvis/src/stream-emitter.test.ts`

Add these tests BEFORE updating `VisibleTextPipe` to use `VisibleAnswerStreamSanitizer`:

```typescript
import { VisibleAnswerStreamSanitizer } from "./text-tools";

test("VisibleTextPipe strips bare JSON tool lines, not just tags", async () => {
  const rec = recorder();
  const pipe = new VisibleTextPipe({ sessionId: "s5", reasoningEnabled: false, write: rec.write });
  await pipe.push('{"name":"read_file","arguments":{"path":"README.md"}}\n');
  await pipe.push("Here is the summary.");
  await pipe.finish();

  expect(visibleText(rec.events())).toBe("Here is the summary.");
});

test("VisibleTextPipe preserves mixed prose + JSON lines", async () => {
  const rec = recorder();
  const pipe = new VisibleTextPipe({ sessionId: "s6", reasoningEnabled: false, write: rec.write });
  await pipe.push('Result: {"name":"read_file","arguments":{"path":"README.md"}}\n');
  await pipe.finish();

  expect(visibleText(rec.events())).toBe('Result: {"name":"read_file","arguments":{"path":"README.md"}}\n');
});

test("VisibleTextPipe keeps fenced JSON tool examples intact", async () => {
  const rec = recorder();
  const pipe = new VisibleTextPipe({ sessionId: "s7", reasoningEnabled: false, write: rec.write });
  const fenced = "\`\`\`json\n{\"name\":\"read_file\",\"arguments\":{\"path\":\".\"}}\n\`\`\`\n";
  await pipe.push(fenced);
  await pipe.finish();

  expect(visibleText(rec.events())).toBe(fenced);
});
```

### 8.2 New tests for `isCosmeticToolEchoPayloadStrict`

**File:** `server-jarvis/src/text-tools.test.ts`

Add these tests BEFORE replacing `findCosmeticToolEchoLineSpans`:

```typescript
describe("isCosmeticToolEchoPayloadStrict", () => {
  test("generic search JSON in prose is KEPT", () => {
    const { cleanedText } = extractTextToolCalls(`{"name":"search","query":"x"}\n`, []);
    expect(cleanedText).toContain("search");
  });

  test("legacy flat block with payload is stripped", () => {
    const { cleanedText } = extractTextToolCalls(`{"tool":"find_files","path":"."}\n`, []);
    expect(cleanedText).toBe("");
  });

  test("bare legacy block with no payload is KEPT", () => {
    const { cleanedText } = extractTextToolCalls(`{"tool":"read_file"}\n`, []);
    expect(cleanedText).toContain("read_file");
  });
});
```

### 8.3 Full verification matrix

| Step | Test | Expected |
|------|------|----------|
| 1.1 | `bun test text-tools.test.ts` | All pass, including new strict tests |
| 1.2 | `bun test stream-emitter.test.ts` | All pass, including new bare-JSON tests |
| 1.3 | `bun test` (full suite) | All pass |
| 2.1 | Live SSE probe: multi-paragraph answer | Blank lines survive in bubble |
| 2.2 | Live SSE probe: bare tool JSON line | Dropped from bubble |
| 3.1 | Slow model mock (45s stall) | `error` frame, not blank bubble |
| 3.2 | User Stop mid-stream | `cancelled` handled, UI shows stopped |
| 4.1 | Unknown SSE type injection | Logged once, no crash |
| 4.2 | Malformed `data:` line | Stream aborts, `isStreaming` false |
| 5.1 | "Do not modify" | `workspace_read`, not `full_execution` |
| 6.1 | Deploy manifest | `git_sha` matches repo HEAD |
| 7.1 | Double-click Send | One stream only |
| 7.2 | Connection refused | Input restored |

---

## 9. Rollback Procedures

| Phase | Rollback | How |
|-------|----------|-----|
| 1 | Deploy | `git checkout -- scripts/build-and-deploy.ps1; git checkout -- scripts/verify-deploy.ps1` |
| 2 | Sanitizer | `git checkout -- server-jarvis/src/stream-emitter.ts; git checkout -- server-jarvis/src/text-tools.ts` |
| 3 | Abort | Already fixed; no rollback needed |
| 4 | UI | Already fixed; no rollback needed |
| 5 | Orchestration | Already fixed; no rollback needed |
| 6 | Tool norm | `git checkout -- server-jarvis/src/index.ts` |
| 7 | UI state | Already fixed; no rollback needed |
| 8 | Tests | `git checkout -- server-jarvis/src/stream-emitter.test.ts; git checkout -- server-jarvis/src/text-tools.test.ts` |

---

## 10. Execution Order & Dependencies

```
Day 1 — Foundation (Critical Path)
  1.1  Harden build script + verify deploy
  1.2  Deploy final bundle with manifest
  1.3  Verify live Desktop build matches repo HEAD

Day 2 — Sanitizer Hardening
  2.1  Write new tests (TDD) — stream-emitter.test.ts + text-tools.test.ts
  2.2  Update VisibleTextPipe to use VisibleAnswerStreamSanitizer
  2.3  Add isCosmeticToolEchoPayloadStrict + tighten findCosmeticToolEchoLineSpans
  2.4  Run tests, verify all pass

Day 3 — Integration & Verification
  3.1  End-to-end smoke test with real chat turns
  3.2  Verify no regressions in direct chat path
  3.3  Document any follow-ups (ADR for fast-read path, persistence contract)
```

**Critical path:** Phase 1 (Deploy) → Phase 2 (Sanitizer). Everything else is already fixed in the repo.

---

# AUDIT: Implementation Plan Quality & Accuracy

**Auditor:** Same agent, post-forensic review of all source files.  
**Date:** 2026-07-03  
**Result:** Plan revised. See diff below.

---

## Audit Findings

### Finding A: UI is already fully fixed (High Impact)

**Evidence:**
- `JarvisView.tsx` line 883-897: `cancelled` handler with empty-bubble removal and `isStreaming` flip.
- `JarvisView.tsx` line 854-858: `fallback_notice` handler.
- `JarvisView.tsx` line 904-906: `reportUnknownFrame` for unknown frame types.
- `JarvisView.tsx` line 786: `streamedVisibleText = /\S/.test(sanitizeAssistantDisplay(streamedRawText))` — cumulative non-whitespace check.
- `sse-protocol.ts` line 84-88: `parseSseDataLine` wraps `JSON.parse` in try/catch.
- `chat-state.ts` line 5-29: `SendGate` with generation-based locking.
- `chat-state.ts` line 47: `finalizeStreamingMessages` removes empty assistant bubbles.
- `chat-state.ts` line 89-98: `mergeToolResult` prefers `call_id`, warns on name fallback.

**Correction:** Original Phase 4 and Phase 7 edits are **redundant**. Removed from plan. No UI code changes needed.

---

### Finding B: Abort domain split is already fixed (High Impact)

**Evidence:**
- `index.ts` line 1499: `createIdempotentReaderCancel(reader)` used for per-read-loop cancellation.
- `index.ts` line 1546: `cancelReader("First-token timeout")` — NOT `streamAbort.abort()`.
- `index.ts` line 1593-1598: `resolveReadStopReason` gives `first_token_timeout` precedence over `turn_cancelled`.
- `stream-control.ts` line 99-102: `resolveReadStopReason` returns `first_token_timeout` first.
- `stream-control.test.ts` line 82-97: Tests confirm precedence logic.

**Correction:** Original Phase 3 edits (removing `!streamAbort.signal.aborted`) are **unnecessary and potentially harmful**. The guard prevents spurious timeout logs when the user already cancelled. The `reader.cancel()` architecture is the real fix, and it's already in place.

---

### Finding C: Negation classifier already implemented (Medium Impact)

**Evidence:**
- `turn-requirements.ts` line 85-124: `isNegatedMutation`, `NEGATED_MUTATION_NOUN`, `NEGATION_MARKER`.
- `turn-requirements.ts` line 176: `!isNegatedMutation(intentText, match.index ?? 0)` filter.
- `turn-requirements.test.ts` exists and passes.

**Correction:** Original Phase 5.2 declared "No edit needed" but did not remove it from the plan. Fully removed now.

---

### Finding D: Replan safety bounds already implemented (Medium Impact)

**Evidence:**
- `replan-loop.ts` line 48: `maxReplans: number` in `ReplanLoopArgs`.
- `replan-loop.ts` line 71: `budgetExhausted = replans >= args.maxReplans`.
- `replan-loop.test.ts` exists and passes.

**Correction:** Original Phase 5.3 Edit 5.3a is **redundant**. Removed from plan.

---

### Finding E: `VisibleTextPipe` uses tag-only sanitizer (High Impact — Real Gap)

**Evidence:**
- `stream-emitter.ts` line 55: `private readonly sanitizer = new TextToolCallStreamSanitizer();`
- `stream-emitter.ts` line 18-20: Comments explain it strips reasoning and tool-call markup, but only tags are handled.
- `stream-emitter.test.ts` line 52-59: Only tests `<tool_call>` tags, not bare JSON.

**Correction:** This is a **genuine gap** the original plan missed. The direct chat path (`VisibleTextPipe`) does NOT strip bare JSON tool lines. If a model hallucinates bare JSON in the direct chat path, it leaks into the chat. Added Edit 2.1a to use `VisibleAnswerStreamSanitizer` instead.

---

### Finding F: `isCosmeticToolEchoPayloadStrict` had a bug in legacy path (Medium Impact)

**Evidence:**
- Original plan's `isCosmeticToolEchoPayloadStrict` returned `true` for `{"tool":"read_file"}` even with no payload keys, because it omitted the `payloadKeys.length > 0` check from the original `isCosmeticToolEchoPayload`.

**Correction:** Added `payloadKeys.length > 0` check to the legacy path in Edit 2.2a. This ensures bare `{"tool":"read_file"}` in prose is KEPT, while `{"tool":"find_files","path":"."}` is stripped.

---

### Finding G: `VisibleAnswerStreamSanitizer` tests already pass (Low Impact)

**Evidence:**
- `text-tools.test.ts` line 269-331: 6 tests covering chunking invariance, paragraph breaks, bare JSON dropping, mixed prose, fenced code, and whitespace-only chunks.
- All tests pass with current implementation.

**Correction:** The diagnosis's claim that the sanitizer "eats blank lines, loses newlines at chunk boundaries, is fence-blind" is **not reproducible** against the current repo code. The tests prove the current implementation handles these cases correctly. The live incidents were caused by the **stale build**, not the repo code. My original plan's full rewrite of `VisibleAnswerStreamSanitizer` is unnecessary and risky. Replaced with a targeted fix: updating `VisibleTextPipe` to use `VisibleAnswerStreamSanitizer` and tightening `isCosmeticToolEchoPayload` to a strict variant.

---

### Finding H: Deploy is the single critical path item (Critical)

**Evidence:**
- `Desktop\index.js` does NOT contain `VisibleAnswerStreamSanitizer` (diagnosis confirmed).
- `Desktop\prompts\` may be missing or stale (diagnosis confirmed).
- `scripts/build-and-deploy.ps1` has no `Test-Path` guard on `$promptsSrc`.
- No deploy manifest exists to verify consistency.

**Correction:** Phase 1 (Deploy) is the only action that will actually fix the live issues. All other phases are either already fixed or minor hardening. The execution order is revised to prioritize deploy on Day 1.

---

## Corrected Execution Order

```
Day 1 — Deploy (Critical)
  1.1  Harden build script + add manifest
  1.2  Run verify-deploy.ps1
  1.3  Deploy to Desktop
  1.4  Confirm Desktop\index.js contains VisibleAnswerStreamSanitizer
  1.5  Confirm Desktop\prompts\ exists and is complete
  1.6  Confirm .jarvis-deploy-manifest.json git_sha matches repo HEAD

Day 2 — Sanitizer Hardening (Targeted)
  2.1  Write TDD tests: stream-emitter.test.ts (bare JSON stripping)
  2.2  Write TDD tests: text-tools.test.ts (strict predicate edge cases)
  2.3  Update VisibleTextPipe to use VisibleAnswerStreamSanitizer
  2.4  Add isCosmeticToolEchoPayloadStrict + update findCosmeticToolEchoLineSpans
  2.5  Run full test suite
  2.6  Verify no regressions in direct chat path

Day 3 — Integration Verification
  3.1  End-to-end smoke test with real chat turns
  3.2  Verify slow model → error frame, not blank bubble
  3.3  Verify Stop → cancelled, not stuck streaming
  3.4  Document any follow-ups
```

**Risk assessment:**
- **Deploy failure:** High risk if not done first. The stale build is the root cause of all live symptoms.
- **VisibleTextPipe sanitizer change:** Low risk. `VisibleAnswerStreamSanitizer` already handles tags via its internal `TextToolCallStreamSanitizer`, so tag stripping is preserved. It adds bare JSON stripping, which is the desired behavior.
- **isCosmeticToolEchoPayloadStrict:** Low risk. The strict predicate is MORE conservative than the original, so it will strip LESS, not more. It only affects `tools=[]` stages.

---

*End of audited implementation plan.*
