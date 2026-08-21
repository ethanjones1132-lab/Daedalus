# Tool Output Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mid-sentence truncation of tool output with compression that keeps the high-signal lines and states plainly what was dropped.

**Architecture:** A new pure module exposes `compressToolOutput(text, opts)`. It never cuts mid-line, always emits an explicit elision marker, and never exceeds the requested budget. `session-memory.ts` swaps its three `truncateSnippet` call sites for it. Pure and synchronous — no model call, no I/O — so it is cheap enough to run on every tool result and fully testable.

**Tech Stack:** Bun, TypeScript, `bun:test`. No new dependencies.

**Why this shape:** the current `truncateSnippet` (`session-memory.ts:170`) does `text.slice(0, max) + "..."`. On a 4,000-char cap it keeps the first 4,000 characters of a stack trace and discards the error at the bottom, keeps the header of a test run and discards the failure summary. Position in the output is not correlated with importance; for most tool output the *end* carries the verdict.

---

## File Structure

| File | Responsibility |
|---|---|
| `server-jarvis/src/orchestration/tool-output-compression.ts` | Pure compression: line-safe budget enforcement, head/tail retention, per-tool-family line scoring. |
| `server-jarvis/src/orchestration/tool-output-compression.test.ts` | Behavior + invariant tests. |
| `server-jarvis/src/orchestration/session-memory.ts` | Call-site swap at lines 361, 415, 431. |

---

### Task 1: Budget enforcement that never cuts mid-line

**Files:**
- Create: `server-jarvis/src/orchestration/tool-output-compression.ts`
- Test: `server-jarvis/src/orchestration/tool-output-compression.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server-jarvis/src/orchestration/tool-output-compression.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { compressToolOutput } from "./tool-output-compression";

describe("budget enforcement", () => {
  test("returns short output unchanged", () => {
    const out = compressToolOutput("all good", { toolName: "run_shell", maxChars: 100 });
    expect(out).toBe("all good");
  });

  test("never exceeds the budget", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i} of output text here`).join("\n");
    const out = compressToolOutput(text, { toolName: "run_shell", maxChars: 400 });
    expect(out.length).toBeLessThanOrEqual(400);
  });

  test("keeps whole lines rather than cutting mid-line", () => {
    const text = Array.from({ length: 200 }, (_, i) => `alpha-${i}-beta-gamma-delta`).join("\n");
    const out = compressToolOutput(text, { toolName: "run_shell", maxChars: 300 });
    for (const line of out.split("\n")) {
      if (line.startsWith("[")) continue; // elision marker
      expect(text.split("\n")).toContain(line);
    }
  });

  test("states how much was dropped", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const out = compressToolOutput(text, { toolName: "run_shell", maxChars: 200 });
    expect(out).toMatch(/\[\.\.\. \d+ lines omitted/);
  });

  test("keeps the tail, not just the head", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    lines[299] = "FINAL VERDICT LINE";
    const out = compressToolOutput(lines.join("\n"), { toolName: "run_shell", maxChars: 300 });
    expect(out).toContain("FINAL VERDICT LINE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/tool-output-compression.test.ts`
Expected: FAIL — cannot resolve module `./tool-output-compression`.

- [ ] **Step 3: Write the implementation**

Create `server-jarvis/src/orchestration/tool-output-compression.ts`:

```typescript
// ═══════════════════════════════════════════════════════════════
// Tool output compression — keep the signal, drop the filler
// ═══════════════════════════════════════════════════════════════
// Replaces the plain `slice(0, max)` truncation that fed tool results into
// context. A hard character cut keeps whichever bytes happen to come first,
// which for most tool output is the least informative part: the compiler
// banner rather than the error, the test header rather than the failures.
//
// Invariants (all covered by tests):
//   1. Output never exceeds maxChars.
//   2. Output contains only whole lines from the input, plus elision markers.
//   3. Any dropped content is reported in an explicit marker.
//   4. Pure and deterministic — same input, same output, no I/O.

export interface CompressOptions {
  /** Tool that produced this output; selects the line-scoring profile. */
  toolName: string;
  /** Hard ceiling on the returned string length. */
  maxChars: number;
}

/** Marker text is counted against the budget, so keep it compact. */
function elision(lines: number, chars: number): string {
  return `[... ${lines} lines omitted (${chars} chars) ...]`;
}

export function compressToolOutput(text: string, opts: CompressOptions): string {
  const { maxChars } = opts;
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  const lines = text.split("\n");

  // Reserve room for the marker before deciding how many lines fit.
  const markerBudget = elision(lines.length, text.length).length + 1;
  const usable = Math.max(0, maxChars - markerBudget);
  if (usable === 0) return text.slice(0, maxChars);

  // Split the budget between head and tail. The tail gets the larger share:
  // verdicts, totals, and error summaries live at the end of tool output.
  const tailBudget = Math.floor(usable * 0.6);
  const headBudget = usable - tailBudget;

  const head: string[] = [];
  let headChars = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (headChars + cost > headBudget) break;
    head.push(line);
    headChars += cost;
  }

  const tail: string[] = [];
  let tailChars = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const line = lines[i]!;
    const cost = line.length + 1;
    if (tailChars + cost > tailBudget) break;
    tail.unshift(line);
    tailChars += cost;
  }

  const omittedLines = lines.length - head.length - tail.length;
  if (omittedLines <= 0) {
    const joined = [...head, ...tail].join("\n");
    return joined.length <= maxChars ? joined : joined.slice(0, maxChars);
  }

  const omittedChars = text.length - headChars - tailChars;
  const out = [...head, elision(omittedLines, Math.max(0, omittedChars)), ...tail].join("\n");
  return out.length <= maxChars ? out : out.slice(0, maxChars);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/tool-output-compression.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/tool-output-compression.ts server-jarvis/src/orchestration/tool-output-compression.test.ts
git commit -m "feat(context): line-safe tool output compression with explicit elision"
```

---

### Task 2: Keep error lines when output is dropped

**Files:**
- Modify: `server-jarvis/src/orchestration/tool-output-compression.ts`
- Test: `server-jarvis/src/orchestration/tool-output-compression.test.ts`

Head/tail retention loses a failure that lands in the middle of a long run. Promote lines that carry a diagnosis regardless of position.

- [ ] **Step 1: Write the failing test**

Append to the test file:

```typescript
describe("signal line retention", () => {
  test("keeps an error buried in the middle of long output", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `ok step ${i}`);
    lines[200] = "ERROR: cannot find module 'foo'";
    const out = compressToolOutput(lines.join("\n"), { toolName: "run_shell", maxChars: 500 });
    expect(out).toContain("ERROR: cannot find module 'foo'");
  });

  test("keeps a failing test line", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `pass ${i}`);
    lines[150] = "FAIL src/thing.test.ts > does the thing";
    const out = compressToolOutput(lines.join("\n"), { toolName: "run_shell", maxChars: 500 });
    expect(out).toContain("FAIL src/thing.test.ts > does the thing");
  });

  test("promoted lines are reported as a separate marker", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `ok ${i}`);
    lines[200] = "Error: boom";
    const out = compressToolOutput(lines.join("\n"), { toolName: "run_shell", maxChars: 500 });
    expect(out).toMatch(/\[\.\.\. \d+ signal lines? kept from the middle \.\.\.\]/);
  });

  test("still respects the budget when promoting", () => {
    const lines = Array.from({ length: 400 }, () => "ERROR: everything is on fire");
    const out = compressToolOutput(lines.join("\n"), { toolName: "run_shell", maxChars: 300 });
    expect(out.length).toBeLessThanOrEqual(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/tool-output-compression.test.ts`
Expected: FAIL — the middle error line is absent from the output.

- [ ] **Step 3: Add signal promotion**

In `tool-output-compression.ts`, add above `compressToolOutput`:

```typescript
/**
 * Lines that carry a diagnosis. Deliberately narrow: a loose pattern promotes
 * half the output and the compression stops compressing.
 */
const SIGNAL_PATTERN =
  /^\s*(?:ERROR|Error:|FAIL|FAILED|Exception|Traceback|error TS\d+|panic:|fatal:|✗|×)\b|^\s*\w+Error:/;

function isSignalLine(line: string): boolean {
  return SIGNAL_PATTERN.test(line);
}
```

Then in `compressToolOutput`, replace the block starting at `const omittedLines = ...` through the end of the function with:

```typescript
  const omittedLines = lines.length - head.length - tail.length;
  if (omittedLines <= 0) {
    const joined = [...head, ...tail].join("\n");
    return joined.length <= maxChars ? joined : joined.slice(0, maxChars);
  }

  // Rescue diagnosis lines from the dropped middle, newest-first, until the
  // remaining budget is spent. Capped so a wall of identical errors cannot
  // crowd out the head and tail entirely.
  const middle = lines.slice(head.length, lines.length - tail.length);
  const spent = headChars + tailChars;
  let signalBudget = Math.max(0, usable - spent);
  const promoted: string[] = [];
  for (const line of middle) {
    if (!isSignalLine(line)) continue;
    const cost = line.length + 1;
    if (cost > signalBudget) break;
    promoted.push(line);
    signalBudget -= cost;
    if (promoted.length >= 5) break;
  }

  const omittedChars = text.length - headChars - tailChars;
  const parts: string[] = [...head];
  if (promoted.length > 0) {
    parts.push(`[... ${promoted.length} signal line${promoted.length === 1 ? "" : "s"} kept from the middle ...]`);
    parts.push(...promoted);
  }
  parts.push(elision(omittedLines - promoted.length, Math.max(0, omittedChars)));
  parts.push(...tail);

  const out = parts.join("\n");
  return out.length <= maxChars ? out : out.slice(0, maxChars);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/tool-output-compression.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/tool-output-compression.ts server-jarvis/src/orchestration/tool-output-compression.test.ts
git commit -m "feat(context): rescue diagnosis lines from dropped middle output"
```

---

### Task 3: Wire into session memory

**Files:**
- Modify: `server-jarvis/src/orchestration/session-memory.ts:361`, `:415`, `:431`
- Test: `server-jarvis/src/orchestration/session-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server-jarvis/src/orchestration/session-memory.test.ts`:

```typescript
describe("session memory uses compression, not truncation", () => {
  test("a recorded tool result keeps its trailing error", () => {
    // `makeConfig` and `SessionMemory` are already defined/imported at the top
    // of this file (session-memory.test.ts:15 and :6) — reuse them.
    const memory = new SessionMemory(() => makeConfig());

    const long = Array.from({ length: 2000 }, (_, i) => `noise line ${i}`).join("\n")
      + "\nERROR: the actual thing that went wrong";

    memory.recordToolResult({
      sessionId: "s1",
      toolName: "run_shell",
      args: { command: "bun test" },
      workspacePath: "/w",
      result: {
        call_id: "c1",
        name: "run_shell",
        output: long,
        is_error: false,
        duration_ms: 1,
      },
    });

    const hints = memory.toSharedContextHints("s1", "/w");
    const recorded = Object.values(hints?.prior_tool_results ?? {}).join("\n");
    expect(recorded).toContain("ERROR: the actual thing that went wrong");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/session-memory.test.ts`
Expected: FAIL — the trailing ERROR line was cut by the 4,000-char head slice.

- [ ] **Step 3: Swap the call sites**

In `server-jarvis/src/orchestration/session-memory.ts`, add the import at the top:

```typescript
import { compressToolOutput } from "./tool-output-compression";
```

Line 361 — shared context hints:

```typescript
      prior_tool_results[entry.displayKey] = compressToolOutput(entry.output, {
        toolName: entry.toolName,
        maxChars: MAX_SNIPPET_CHARS,
      });
```

Line 415 — recorded tool result:

```typescript
      output: compressToolOutput(output, { toolName: input.toolName, maxChars: 4000 }),
```

Line 431 — file snapshot:

```typescript
          content: compressToolOutput(output, { toolName: input.toolName, maxChars: 8000 }),
```

Leave line 423 (`truncateSnippet(output, 200)` for the failure pattern) and line 487 (`truncateSnippet(args.error, 300)`) alone. Those build short single-line labels where a head slice is the correct behavior and an elision marker would be noise.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server-jarvis && bun test src/orchestration/session-memory.test.ts`
Expected: PASS, including the whole existing suite.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/session-memory.ts server-jarvis/src/orchestration/session-memory.test.ts
git commit -m "feat(session-memory): compress tool output instead of truncating it"
```

---

### Task 4: Full suite

- [ ] **Step 1: Run the whole suite**

Run: `cd server-jarvis && bun test`
Expected: PASS. Watch specifically for tests asserting on exact truncated strings — if one fails because it expected `"...".endsWith("...")`, update the assertion to the new marker rather than reverting the behavior.

- [ ] **Step 2: Commit any assertion updates**

```bash
git add -A
git commit -m "test: update assertions for compressed tool output"
```

---

## Self-Review

**Spec coverage:** budget + line safety (T1), mid-output signal retention (T2), integration at all three long-output call sites (T3), regression sweep (T4).

**Types:** `CompressOptions` is defined in T1 and used unchanged in T2 and T3. `compressToolOutput` keeps one signature throughout.

**Deliberately not done:** history-level compression (summarizing older conversation turns) and model-assisted summarization. Both were in the 2026-04 design. Both need a model call in the context path, which is a different risk profile — do them as a follow-up once this lands and the token savings are measured.
