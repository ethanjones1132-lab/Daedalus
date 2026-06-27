# Orchestrator Quality Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the three diagnosed orchestrator defects (synthesizer narrating the pipeline, executor choosing the wrong filesystem tool, coordinator over-routing trivial turns) and add MiniMax M3 to the model pool — for a measurable lift in instruction-following, tool selection, and answer thoroughness.

**Architecture:** The Jarvis orchestrator (`server-jarvis`, Bun/TypeScript) runs a multi-stage pipeline (coordinator → planner → executor → reviewer/rewriter → synthesizer) over a multi-provider model pool (OpenRouter + OpenCode Zen/Go). This plan makes targeted, test-covered changes to four seams: the synthesizer's input assembly, the `read_file` tool + tool-healing, the coordinator's pre-routing triage, and the agent pool definition. No structural rewrite — each change is isolated and independently revertible.

**Tech Stack:** Bun, TypeScript, `bun:test`, the existing `ToolRuntime`/`ExecutionContext` test harness, prompt `.md` files loaded at runtime via `loadPrompt`.

**Source of the diagnosis:** `~/.openclaw/jarvis/self-tuning.db` (live), captured in memory `orchestrator-behavioral-diagnosis`. File logs at `~/.openclaw/jarvis/logs/` are STALE (May 28) — do not use them.

---

## File Structure

**New files:**
- `server-jarvis/src/orchestration/synth-context.ts` — pure helper that assembles the synthesizer's user message, omitting empty/skipped-stage sentinels and stripping `<think>` from stage outputs. One responsibility: "what context does the synthesizer see."
- `server-jarvis/src/orchestration/synth-context.test.ts` — unit tests for the above.
- `server-jarvis/src/orchestration/turn-triage.ts` — pure helper classifying a turn as a trivial conversational turn (greeting/chitchat/ack). One responsibility: "is this turn worth routing through the full coordinator."
- `server-jarvis/src/orchestration/turn-triage.test.ts` — unit tests for the above.

**Modified files:**
- `server-jarvis/src/orchestration/pipeline.ts` — wire the synthesizer call sites through `buildSynthesizerContext`.
- `server-jarvis/src/prompts/modes/synthesizer.md` — add the direct-answer fallback rule.
- `server-jarvis/src/filesystem-bundle.ts` — `read_file` directory guard; sharpen `read_file`/`list_directory` descriptions.
- `server-jarvis/src/tool-heal.ts` — add `is_directory` error category + hint.
- `server-jarvis/src/tool-heal.test.ts` — cover the new category.
- `server-jarvis/src/filesystem-bundle.test.ts` — cover the directory guard.
- `server-jarvis/src/prompts/modes/executor.md` — disambiguate file vs directory tools.
- `server-jarvis/src/orchestration/coordinator.ts` — short-circuit trivial turns before the model call.
- `server-jarvis/src/orchestration/coordinator.test.ts` — cover the short-circuit.
- `server-jarvis/src/orchestration/agent-pool.ts` — add `minimax-m3` pool entry; update the exclusion comment.
- `server-jarvis/src/orchestration/agent-pool.test.ts` — flip the `minimax-m3` exclusion assertion.

**Test command (run from `server-jarvis/`):** `bun test <path>` for one file, `bun test` for all, `bun run typecheck` for types.

---

## PHASE 1 — P1: Synthesizer never narrates an empty pipeline

**Why:** Captured output: *"The pipeline has not yet been executed for this request… 'Executor Activity'… confirm no stages have run."* The synthesizer receives sentinel strings like `"No execution stage executed."` ([pipeline.ts:104-106](../../server-jarvis/src/orchestration/pipeline.ts)) and narrates them to the user. Synthesizer averages 10 output tokens over 539 runs. Fix: omit non-meaningful stage sections from the synthesizer's input, strip `<think>` leakage from stage outputs, and add a prompt rule forbidding pipeline-narration.

### Task 1: `buildSynthesizerContext` helper

**Files:**
- Create: `server-jarvis/src/orchestration/synth-context.ts`
- Test: `server-jarvis/src/orchestration/synth-context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server-jarvis/src/orchestration/synth-context.test.ts
import { describe, test, expect } from "bun:test";
import { buildSynthesizerContext } from "./synth-context";

describe("buildSynthesizerContext", () => {
  test("synthesizer-only turn passes just the user request (no empty scaffolding)", () => {
    const out = buildSynthesizerContext("Hey buddy, how are you?", {
      plan: "",
      executorSummary: "No execution stage executed.",
      reviewerFeedback: "No review stage executed.",
      rewriterSummary: "No rewriting stage executed.",
    });
    expect(out).toBe("User Request: Hey buddy, how are you?");
    expect(out).not.toContain("Executor Activity");
    expect(out).not.toContain("No execution stage executed");
  });

  test("includes only sections for stages that actually produced output", () => {
    const out = buildSynthesizerContext("Summarize the repo", {
      plan: "1. Read README. 2. Summarize.",
      executorSummary: "Read README.md (240 lines).",
      reviewerFeedback: "No review stage executed.",
      rewriterSummary: "No rewriting stage executed.",
    });
    expect(out).toContain("Original Plan:\n1. Read README. 2. Summarize.");
    expect(out).toContain("Executor Activity:\nRead README.md (240 lines).");
    expect(out).not.toContain("Reviewer Feedback");
    expect(out).not.toContain("Rewriter Activity");
  });

  test("keeps stage FAILURES (disclosure) but drops 'not executed' sentinels", () => {
    const out = buildSynthesizerContext("Do the thing", {
      executorSummary: "Executor failed: API 503",
      reviewerFeedback: "No review stage executed.",
    });
    expect(out).toContain("Executor Activity:\nExecutor failed: API 503");
    expect(out).not.toContain("Reviewer Feedback");
  });

  test("strips <think> reasoning blocks leaked into stage output", () => {
    const out = buildSynthesizerContext("Q", {
      executorSummary: "<think>internal planning</think>Ran the build successfully.",
    });
    expect(out).toContain("Ran the build successfully.");
    expect(out).not.toContain("<think>");
    expect(out).not.toContain("internal planning");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/orchestration/synth-context.test.ts`
Expected: FAIL with "Cannot find module './synth-context'" or "buildSynthesizerContext is not a function".

- [ ] **Step 3: Write minimal implementation**

```ts
// server-jarvis/src/orchestration/synth-context.ts
// ─── Synthesizer input assembly ──────────────────────────────────────────────
// Builds the user-message context handed to the synthesizer. ONLY includes
// sections for stages that actually produced output — "not executed" sentinels
// and empty strings are dropped so the synthesizer never narrates an empty
// pipeline back to the user. Stage FAILURES are kept (disclosure rule); only the
// "No X stage executed." sentinels are skipped. <think> reasoning blocks that a
// reasoning model (nemotron/mimo/minimax) leaked into its output are stripped.

import { stripReasoningFromText } from "../reasoning";

export interface SynthesizerParts {
  plan?: string;
  executorSummary?: string;
  reviewerFeedback?: string;
  rewriterSummary?: string;
}

// Sentinels assigned by pipeline.ts when a stage is skipped. These must be
// dropped — they are scaffolding, not content for the user.
const SKIP_SENTINELS = new Set<string>([
  "",
  "No execution stage executed.",
  "No review stage executed.",
  "No rewriting stage executed.",
  "No execution stage executed. Planner and reviewer ran speculatively without tool execution.",
]);

function clean(value: string | undefined): string {
  if (!value) return "";
  return stripReasoningFromText(value).trim();
}

function isMeaningful(value: string): boolean {
  return value.length > 0 && !SKIP_SENTINELS.has(value);
}

export function buildSynthesizerContext(request: string, parts: SynthesizerParts): string {
  const sections: string[] = [`User Request: ${request}`];

  const plan = clean(parts.plan);
  const exec = clean(parts.executorSummary);
  const review = clean(parts.reviewerFeedback);
  const rewrite = clean(parts.rewriterSummary);

  if (isMeaningful(plan)) sections.push(`Original Plan:\n${plan}`);
  if (isMeaningful(exec)) sections.push(`Executor Activity:\n${exec}`);
  if (isMeaningful(review)) sections.push(`Reviewer Feedback:\n${review}`);
  if (isMeaningful(rewrite)) sections.push(`Rewriter Activity:\n${rewrite}`);

  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/orchestration/synth-context.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/synth-context.ts server-jarvis/src/orchestration/synth-context.test.ts
git commit -m "feat(orchestrator): synth-context helper omits empty stage sections + strips think"
```

### Task 2: Wire the helper into every synthesizer call site in pipeline.ts

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts` (import + the 3 synthesizer call sites at ~445, ~568, ~726)

**Note:** Find every synthesizer call site by grepping `stageLabel: "synthesizer"` in `pipeline.ts`. Each builds the same inline `User Request: …` template. Replace the `content:` expression with `buildSynthesizerContext(...)`. Do NOT touch the reviewer (line ~285) or rewriter (line ~320) call sites — those keep their full templates.

- [ ] **Step 1: Add the import**

At the top of `pipeline.ts`, alongside the other `./` imports, add:

```ts
import { buildSynthesizerContext } from "./synth-context";
```

- [ ] **Step 2: Replace the linear synthesizer template (~line 445)**

Find:

```ts
            content: `User Request: ${request}\n\nOriginal Plan:\n${plan}\n\nExecutor Activity:\n${executorSummary}\n\nReviewer Feedback:\n${reviewerFeedback}\n\nRewriter Activity:\n${rewriterSummary}`
```

Replace with:

```ts
            content: buildSynthesizerContext(request, { plan, executorSummary, reviewerFeedback, rewriterSummary })
```

- [ ] **Step 3: Replace the second synthesizer template (~line 568)**

This site has the identical template string as Step 2. Apply the exact same replacement (`buildSynthesizerContext(request, { plan, executorSummary, reviewerFeedback, rewriterSummary })`).

- [ ] **Step 4: Replace the speculative-cascade synthesizer template (~line 726)**

Find:

```ts
          content: `User Request: ${request}\n\nOriginal Plan:\nSpeculative cascade: cheap executor first, strong executor only on uncertainty.\n\nExecutor Activity:\n${executorSummary}\n\nReviewer Feedback:\nNo review stage executed.\n\nRewriter Activity:\nNo rewriting stage executed.`
```

Replace with:

```ts
          content: buildSynthesizerContext(request, {
            plan: "Speculative cascade: cheap executor first, strong executor only on uncertainty.",
            executorSummary,
          })
```

- [ ] **Step 5: Verify the existing orchestration tests still pass**

Run: `bun test src/orchestration.test.ts`
Expected: PASS. (These tests assert the synthesizer input contains real stage outputs like `"planner outline"` / `"cheap draft"` — those are meaningful and still included.)

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server-jarvis/src/orchestration/pipeline.ts
git commit -m "fix(orchestrator): route synthesizer input through buildSynthesizerContext (no empty-pipeline narration)"
```

### Task 3: Strengthen the synthesizer prompt

**Files:**
- Modify: `server-jarvis/src/prompts/modes/synthesizer.md`

- [ ] **Step 1: Add the direct-answer fallback rule**

In `synthesizer.md`, find the `## Synthesis Protocol` heading line:

```markdown
## Synthesis Protocol
```

Insert this block immediately ABOVE it:

```markdown
## Absolute Rule — Never Describe the Pipeline

You are the only stage the user sees. The user must NEVER see internal scaffolding.

- **Never** mention "the pipeline", "stages", "Executor Activity", "Planner", "Reviewer", or that any stage "did not run" / "has not executed".
- If you were given little or no upstream stage output, that means this is a direct-answer turn. **Answer the user's actual request yourself**, using your own knowledge and whatever context is present. Do NOT explain what *would* happen if stages ran.
- A greeting gets a warm one-line reply. A question gets a direct answer. Never narrate process.

---

```

- [ ] **Step 2: Verify the prompt file loads (smoke check)**

Run: `bun test src/orchestration.test.ts`
Expected: PASS (the prompt is loaded via `loadPrompt`; no test should break from prose changes).

- [ ] **Step 3: Commit**

```bash
git add server-jarvis/src/prompts/modes/synthesizer.md
git commit -m "fix(prompts): synthesizer must answer directly, never narrate the pipeline"
```

---

## PHASE 2 — P2: Executor picks the right filesystem tool

**Why:** Captured `tool_calls_json`: `read_file` called with `{"path":"."}` and `{"path":"C:\\Users\\ethan\\Versutus"}` (directories), repeatedly. `read_file` on a directory throws `EISDIR`, and [filesystem-bundle.ts:198](../../server-jarvis/src/filesystem-bundle.ts) returns a misleading `"File not found"`, which tool-heal classifies as `not_found` → hints "use glob" — never steering to `list_directory`. The model loops.

### Task 4: `read_file` directory guard

**Files:**
- Modify: `server-jarvis/src/filesystem-bundle.ts` (`handleReadFile`, ~line 182)
- Test: `server-jarvis/src/filesystem-bundle.test.ts` (add to the `read_file` describe block)

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("FilesystemBundle > read_file", …)` block in `filesystem-bundle.test.ts` (the helpers `makeTempWorkspace`, `makeRuntime`, `makeCtx`, `call` already exist at the top of the file):

```ts
  test("read_file on a directory returns an actionable list_directory hint, not 'File not found'", async () => {
    const ws = makeTempWorkspace();
    mkdirSync(join(ws, "subdir"));
    const result = await makeRuntime().execute(call("read_file", { path: "subdir" }), makeCtx(ws));
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("is a directory");
    expect(result.output).toContain("list_directory");
    expect(result.output).not.toContain("File not found");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/filesystem-bundle.test.ts`
Expected: FAIL — current output is `"File not found: …"` so `toContain("is a directory")` fails.

- [ ] **Step 3: Add the guard to `handleReadFile`**

In `filesystem-bundle.ts`, find the start of `handleReadFile`:

```ts
  const offset = (args.offset as number) || 1;
  const limit = (args.limit as number) || 500;

  try {
    const content = await fs.readFile(path, "utf-8");
```

Replace with (insert the directory guard between the var setup and the read):

```ts
  const offset = (args.offset as number) || 1;
  const limit = (args.limit as number) || 500;

  // Guard: read_file on a directory is a common wrong-tool error. Detect it and
  // return an actionable message pointing at list_directory, rather than the
  // misleading "File not found" that the readFile EISDIR path would produce.
  try {
    const stat = await fs.stat(path);
    if (stat.isDirectory()) {
      return `Error: "${args.path}" is a directory, not a file. Use list_directory to see its contents, then read_file on a specific file inside it.`;
    }
  } catch {
    // stat failed (path missing) — fall through to readFile's not-found message.
  }

  try {
    const content = await fs.readFile(path, "utf-8");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/filesystem-bundle.test.ts`
Expected: PASS (existing read_file tests + the new directory test).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/filesystem-bundle.ts server-jarvis/src/filesystem-bundle.test.ts
git commit -m "fix(tools): read_file detects directories and points to list_directory"
```

### Task 5: tool-heal `is_directory` category

**Files:**
- Modify: `server-jarvis/src/tool-heal.ts`
- Test: `server-jarvis/src/tool-heal.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tool-heal.test.ts` (follow the existing import/describe style in that file):

```ts
  test("classifies a directory misuse and hints list_directory", () => {
    const output = `Error: "src" is a directory, not a file. Use list_directory to see its contents.`;
    expect(classifyToolError(output)).toBe("is_directory");
    const hint = healingHint("is_directory", 1);
    expect(hint).toContain("list_directory");
  });
```

Ensure `classifyToolError` and `healingHint` are imported at the top of the test file (add them to the existing import from `./tool-heal` if not already present).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tool-heal.test.ts`
Expected: FAIL — `classifyToolError` returns `unknown` (the "is a directory" string falls through), and `"is_directory"` is not a valid category.

- [ ] **Step 3: Add the category, classifier branch, and hint**

In `tool-heal.ts`:

(a) Add to the `ToolErrorCategory` union:

```ts
export type ToolErrorCategory =
  | "not_found"
  | "not_read"
  | "permission"
  | "timeout"
  | "parse"
  | "is_directory"
  | "unknown";
```

(b) In `classifyToolError`, add the branch BEFORE the `not_found` check (so "is a directory" wins over a generic "not found" elsewhere in the message):

```ts
  if (o.includes("is a directory")) return "is_directory";
  if (o.includes("has not been read yet")) return "not_read";
```

(c) Add to `BASE_HINTS`:

```ts
  is_directory: "That path is a directory. Use list_directory to list it, or read_file on a specific file inside it.",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tool-heal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/tool-heal.ts server-jarvis/src/tool-heal.test.ts
git commit -m "feat(tool-heal): is_directory category steers read_file misuse to list_directory"
```

### Task 6: Disambiguate file vs directory tools in descriptions + executor prompt

**Files:**
- Modify: `server-jarvis/src/filesystem-bundle.ts` (`READ_FILE_DEF`, `LIST_DIR_DEF` descriptions)
- Modify: `server-jarvis/src/prompts/modes/executor.md`

- [ ] **Step 1: Sharpen the tool descriptions**

In `filesystem-bundle.ts`, change `READ_FILE_DEF`'s description from:

```ts
    description: "Read the contents of a file. Returns the full file content with line numbers. Use this before editing any file.",
```

to:

```ts
    description: "Read the contents of a single FILE (not a directory). Returns full file content with line numbers. Use this before editing any file. To list a folder's contents, use list_directory instead.",
```

And change `LIST_DIR_DEF`'s description from:

```ts
    description: "List the contents of a directory with file sizes and types.",
```

to:

```ts
    description: "List the contents of a DIRECTORY (folder) with file sizes and types. Use this for any path that is a folder — including '.', the workspace root, or a project directory. Do NOT use read_file on a directory.",
```

- [ ] **Step 2: Add a tool-selection rule to executor.md**

In `executor.md`, find the `### Filesystem Bundle` line and the `read_file` bullet:

```markdown
- `read_file` — Prefer for reading existing files. Use offset/limit for large files.
```

Replace that bullet with:

```markdown
- `read_file` — Read a single FILE. Never call this on a directory (e.g. `.`, a project root, or any folder) — it will fail. If you are unsure whether a path is a file or folder, call `list_directory` first.
- `list_directory` — List a FOLDER's contents. Use this for `.`, the workspace root, or any directory before reading individual files.
```

- [ ] **Step 3: Verify tool definitions still register**

Run: `bun test src/filesystem-bundle.test.ts`
Expected: PASS (the registration test asserts all 8 tools by name; descriptions are free-text).

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/filesystem-bundle.ts server-jarvis/src/prompts/modes/executor.md
git commit -m "fix(tools): disambiguate read_file (file) vs list_directory (folder) in defs + executor prompt"
```

---

## PHASE 3 — P3: Coordinator stops over-routing trivial turns

**Why:** The greeting *"Hey buddy, how are you today?"* was routed three different ways across near-identical turns — including a full `["planner","executor","reviewer"]` with a spurious tool call. Fix: deterministically short-circuit trivial conversational turns to a synthesizer-only route BEFORE the coordinator model call (saves a model round-trip and removes the instability).

### Task 7: `isTrivialConversationalTurn` helper

**Files:**
- Create: `server-jarvis/src/orchestration/turn-triage.ts`
- Test: `server-jarvis/src/orchestration/turn-triage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server-jarvis/src/orchestration/turn-triage.test.ts
import { describe, test, expect } from "bun:test";
import { isTrivialConversationalTurn } from "./turn-triage";

describe("isTrivialConversationalTurn", () => {
  test("greetings and small talk are trivial", () => {
    for (const s of ["Hey buddy, how are you today?", "hello", "thanks!", "good morning", "yo", "ok cool"]) {
      expect(isTrivialConversationalTurn(s)).toBe(true);
    }
  });

  test("task requests are NOT trivial", () => {
    for (const s of [
      "Summarize this repo and name one improvement",
      "read the config file and fix the bug",
      "what does resolveProviderTarget do?",
      "list the files in src",
    ]) {
      expect(isTrivialConversationalTurn(s)).toBe(false);
    }
  });

  test("long input is never trivial even if it starts with a greeting", () => {
    const s = "Hi! " + "Please refactor the orchestrator pipeline so that ".repeat(5);
    expect(isTrivialConversationalTurn(s)).toBe(false);
  });

  test("empty / whitespace is treated as trivial (synthesizer can handle it)", () => {
    expect(isTrivialConversationalTurn("   ")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/orchestration/turn-triage.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// server-jarvis/src/orchestration/turn-triage.ts
// ─── Turn triage ─────────────────────────────────────────────────────────────
// Deterministically detects trivial conversational turns (greetings, thanks,
// acknowledgements, short small-talk) so the coordinator can route them straight
// to a synthesizer-only answer instead of escalating them into a full
// planner/executor pipeline. Conservative by design: anything that looks like a
// task (verbs, length, question about the codebase) is NOT trivial.

// Words that signal real work — their presence forces full routing.
const TASK_SIGNAL = /\b(read|write|edit|create|delete|run|build|fix|refactor|implement|add|remove|search|find|list|summari[sz]e|review|debug|test|deploy|install|configure|analyze|explain|generate|update|change|file|repo|code|function|class|directory|folder|commit|branch)\b/i;

// Pure greeting / acknowledgement phrases.
const TRIVIAL_PATTERNS: RegExp[] = [
  /^(hi|hey|hello|yo|sup|howdy|hiya)\b/i,
  /\b(how are you|how's it going|how are things|what's up|whats up)\b/i,
  /^(thanks|thank you|ty|cheers|nice|cool|great|awesome|ok|okay|got it|sounds good)\b/i,
  /^(good (morning|afternoon|evening|night))\b/i,
];

export function isTrivialConversationalTurn(request: string): boolean {
  const text = (request || "").trim();
  if (text.length === 0) return true;
  // Anything substantial is a real turn regardless of opener.
  if (text.length > 80) return false;
  // A task verb/noun anywhere means route fully.
  if (TASK_SIGNAL.test(text)) return false;
  // A trailing "?" with task content was already excluded; a bare greeting
  // question ("how are you?") still matches the patterns below.
  return TRIVIAL_PATTERNS.some((re) => re.test(text));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/orchestration/turn-triage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/turn-triage.ts server-jarvis/src/orchestration/turn-triage.test.ts
git commit -m "feat(orchestrator): turn-triage helper detects trivial conversational turns"
```

### Task 8: Short-circuit trivial turns in `Coordinator.route`

**Files:**
- Modify: `server-jarvis/src/orchestration/coordinator.ts`
- Test: `server-jarvis/src/orchestration/coordinator.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `coordinator.test.ts` inside the existing `describe("Coordinator", …)` block:

```ts
  test("trivial conversational turns skip the model call and route synthesizer-only", async () => {
    let modelCalls = 0;
    const coordinator = new Coordinator(async () => {
      modelCalls++;
      return { content: "{}" };
    });

    const decision = await coordinator.route("Hey buddy, how are you today?", { sessionId: "triage-1" });

    expect(modelCalls).toBe(0); // no coordinator model round-trip
    expect(decision.pipeline).toEqual(["synthesizer"]);
    expect(decision.task_type).toBe("general");
    expect(decision.topology).toBe("linear");
  });

  test("task requests still call the coordinator model", async () => {
    let modelCalls = 0;
    const coordinator = new Coordinator(async () => {
      modelCalls++;
      return {
        content: JSON.stringify({
          task_type: "general",
          pipeline: ["planner", "executor", "synthesizer"],
          topology: "linear",
          context: { needs_workspace_inspection: true, needs_memory: true, estimated_complexity: "medium" },
          coordinator_rationale: "real task",
        }),
      };
    });

    await coordinator.route("Summarize this repo and name one improvement", { sessionId: "triage-2" });
    expect(modelCalls).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/orchestration/coordinator.test.ts`
Expected: FAIL — the trivial turn currently calls the model (`modelCalls` becomes 1).

- [ ] **Step 3: Add the short-circuit and a helper route**

In `coordinator.ts`, add the import at the top:

```ts
import { loadPrompt } from "./prompt-loader";
import { isTrivialConversationalTurn } from "./turn-triage";
```

Then, at the very start of the `route` method body (before `const state = this.getState(...)`), add:

```ts
  async route(request: string, options: CoordinatorRouteOptions): Promise<CoordinatorResult> {
    // Trivial conversational turns (greetings, acks) never need the planner or
    // executor — route them straight to a streamed synthesizer answer without
    // spending a coordinator model round-trip. This removes the routing
    // instability observed in the 2026-06-26 diagnosis where identical greetings
    // were sometimes escalated into a full pipeline with spurious tool calls.
    if (isTrivialConversationalTurn(request)) {
      const state = this.getState(options.sessionId);
      const decision = this.conversationalRoute();
      state.turns += 1;
      state.lastDecision = decision;
      return decision;
    }

    const state = this.getState(options.sessionId);
```

(Remove the now-duplicated original `const state = this.getState(options.sessionId);` line that followed — there must be exactly one after the guard.)

- [ ] **Step 4: Add the `conversationalRoute` helper**

In `coordinator.ts`, directly below the existing `private defaultRoute(): CoordinatorResult { … }` method, add:

```ts
  /**
   * Route for trivial conversational turns (greetings, thanks, small talk).
   * Synthesizer-only, low complexity — the synthesizer's prompt handles a warm
   * direct reply. Distinct from defaultRoute (which is the *error* fallback).
   */
  private conversationalRoute(): CoordinatorResult {
    return {
      task_type: "general",
      pipeline: ["synthesizer"],
      topology: "linear",
      context: {
        needs_workspace_inspection: false,
        needs_memory: false,
        estimated_complexity: "low",
      },
      coordinator_rationale: "Trivial conversational turn — direct synthesizer reply.",
    };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/orchestration/coordinator.test.ts`
Expected: PASS (existing tests + 2 new). The existing `"falls back to a safe default route"` test uses `"hello"` — note `"hello"` IS trivial, so it now short-circuits to `["synthesizer"]` BEFORE the model returns `"not json"`. The asserted result (`pipeline === ["synthesizer"]`, `task_type === "general"`) still holds, but `coordinator_rationale` now contains `"Trivial conversational"` instead of `"unparseable"`.

- [ ] **Step 6: Fix the pre-existing test's rationale assertion if needed**

If the `"falls back to a safe default route"` test fails only on `expect(decision.coordinator_rationale).toContain("unparseable")`, change that test's `request` from `"hello"` to `"refactor the failing chat stream module"` (a non-trivial input that still returns unparseable `"not json"`), so it continues to exercise the error-fallback path it was written for. Re-run `bun test src/orchestration/coordinator.test.ts` → PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
bun run typecheck
git add server-jarvis/src/orchestration/coordinator.ts server-jarvis/src/orchestration/coordinator.test.ts
git commit -m "fix(orchestrator): short-circuit trivial turns to synthesizer-only before coordinator model call"
```

---

## PHASE 4 — Ceiling: add MiniMax M3 to the pool

**Why:** Probe (2026-06-26) confirmed `minimax-m3` works on OpenCode Go `/chat/completions` (HTTP 200). It's a strong reasoning model. It emits `<think>` blocks inline in `content`, which Phase 1's `clean()` (and the chat path's `ReasoningParser`) already strip — so it is safe as a non-coordinator fallback member. See memory `minimax-m3-plan`.

### Task 9: Add the `minimax-m3` pool entry

**Files:**
- Modify: `server-jarvis/src/orchestration/agent-pool.ts`
- Test: `server-jarvis/src/orchestration/agent-pool.test.ts`

- [ ] **Step 1: Update the failing test first (flip the exclusion assertion)**

In `agent-pool.test.ts`, find:

```ts
    // OpenCode Go (bare ids, OpenAI-compatible; minimax-m3 omitted — Anthropic format)
```

and the assertion:

```ts
    expect(byModel).not.toContain("minimax-m3");
```

Replace the comment with `// OpenCode Go (bare ids, OpenAI-compatible; minimax-m3 included via /chat/completions)` and replace the assertion with:

```ts
    expect(byModel).toContain("minimax-m3");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/orchestration/agent-pool.test.ts`
Expected: FAIL — `minimax-m3` is not yet in `DEFAULT_ORCHESTRATOR_AGENTS`.

- [ ] **Step 3: Add the pool entry and update the comment**

In `agent-pool.ts`, update the comment block (lines ~60-62) — remove the "minimax-m3 is omitted on purpose" sentence and replace with:

```ts
// limit or outage never kills a turn. OpenCode Go `minimax-m3` IS included (it
// serves OpenAI-compatible /chat/completions) as a non-default reasoning
// fallback member; its `<think>` blocks are stripped by buildSynthesizerContext
// and the chat ReasoningParser. It is never a stage default (would burn budget
// on reasoning for short JSON like the coordinator needs).
```

Then, directly after the `go-deepseek-v4-pro` entry (the one ending `default_for: ["executor"], enabled: true, },` at ~line 126), insert:

```ts
  {
    // MiniMax M3 — strong reasoning, OpenCode Go via /chat/completions. Pure
    // fallback tail member (default_for: []) — never coordinator (emits <think>).
    id: "go-minimax-m3",
    provider: "opencode_go",
    model_id: "minimax-m3",
    capabilities: { code: 0.85, reasoning: 0.9, speed: 0.6, cost: 0.7, json_reliability: 0.78 },
    default_for: [],
    enabled: true,
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/orchestration/agent-pool.test.ts`
Expected: PASS. (If a separate test asserts the pool count or a coordinator-is-non-reasoning invariant, confirm `minimax-m3` has `default_for: []` so it is never selected as the coordinator — the invariant holds.)

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/agent-pool.ts server-jarvis/src/orchestration/agent-pool.test.ts
git commit -m "feat(orchestrator): add minimax-m3 (OpenCode Go) as a non-default reasoning fallback"
```

---

## PHASE 5 — Verify, build, redeploy, measure

### Task 10: Full verification and live measurement

**Files:** none (verification only)

- [ ] **Step 1: Run the full server-jarvis test suite**

Run (from `server-jarvis/`): `bun test`
Expected: all suites PASS. Fix any regression before proceeding.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the eval harness for a behavioral baseline**

Run: `bun run eval`
Expected: completes; note the pass/score output. (This exercises `src/eval/cases.ts` through the real pipeline.)

- [ ] **Step 4: Rebuild + redeploy (per memory build-optimized-ps1-husk / jarvis-prompts-not-bundled)**

From the repo root:

```bash
cargo tauri build --target x86_64-pc-windows-msvc
```

Then copy artifacts to the Desktop (exe, server bundle, AND prompts/ — the prompt `.md` changes in Phases 1-2 MUST ship):

```bash
cp "src-tauri/target/x86_64-pc-windows-msvc/release/home-base.exe" "$USERPROFILE/Desktop/Jarvis.exe"
cp "server-jarvis/dist/index.js" "$USERPROFILE/Desktop/index.js"
rm -rf "$USERPROFILE/Desktop/prompts" && cp -r "server-jarvis/src/prompts" "$USERPROFILE/Desktop/prompts"
```

Kill any stale `bun.exe Desktop\index.js` on :19877 so the app spawns the fresh bundle (per memory jarvis-prompts-not-bundled).

- [ ] **Step 5: Live measurement against the diagnosed symptoms**

Launch `Jarvis.exe`, run these three turns, and confirm:
1. *"Hey buddy, how are you today?"* → warm one-line reply, **no** mention of "pipeline"/"stages"; `self-tuning.db` shows pipeline `["synthesizer"]`.
2. *"Give me a two-sentence summary of this repo, then name one improvement."* → a real summary (not a pipeline description); executor's `tool_calls_json` shows `list_directory` (not `read_file`) for directory paths.
3. A follow-up that forces a file read of a folder path → the executor recovers to `list_directory` within one step (no repeated `read_file` on the directory).

Then query the DB to confirm the lift:

```bash
python -c "import sqlite3;c=sqlite3.connect(r'C:/Users/ethan/.openclaw/jarvis/self-tuning.db');print('synth avg out tokens (last 20):', c.execute('select avg(output_tokens) from (select output_tokens from stage_runs where mode_id=\'synthesizer\' order by created_at desc limit 20)').fetchone()[0])"
```

Expected: synthesizer average output tokens materially above the diagnosed baseline of ~10, and no new `read_file`-on-directory tool calls.

- [ ] **Step 6: Final commit (if any deploy scripts/docs changed)**

```bash
git add -A
git commit -m "chore(orchestrator): verify + redeploy quality refinements"
```

---

## Success Metrics (definition of "noticeable enhancement")

| Symptom (diagnosed) | Before | Target after |
|---|---|---|
| Synthesizer narrates the pipeline to the user | Recurring (captured verbatim) | Zero occurrences in live turns |
| Synthesizer avg output tokens | ~10 over 539 runs | Materially higher; real answers, not sentinels |
| Executor `read_file` on a directory | Repeated across many turns | Self-corrects to `list_directory` in ≤1 step |
| Greeting routed into full pipeline w/ tool call | Intermittent | Always `["synthesizer"]`, no model round-trip |
| Strong reasoning model available as fallback | minimax-m3 excluded | In pool as non-default fallback |

## Risks & Rollback

- **Each task is its own commit** — revert any single change without unwinding the others.
- **`turn-triage` false positives** (a real task misread as trivial): mitigated by the conservative `TASK_SIGNAL` regex + 80-char ceiling. If a real task is ever short-circuited, widen `TASK_SIGNAL`; the synthesizer-only route still produces an answer (degraded, not broken).
- **`buildSynthesizerContext` over-omission**: stage FAILURES are explicitly retained; only "not executed" sentinels are dropped. The unit tests lock this in.
- **MiniMax `<think>` leakage**: stripped in two independent places (`buildSynthesizerContext` + chat `ReasoningParser`); entry is `default_for: []` so it never becomes the coordinator.

## Self-Review Notes

- Spec coverage: P1 → Tasks 1-3; P2 → Tasks 4-6; P3 → Tasks 7-8; MiniMax → Task 9; verification/measurement → Task 10. All four diagnosed items + the ceiling item are covered.
- Type consistency: `buildSynthesizerContext(request, SynthesizerParts)`, `isTrivialConversationalTurn(string): boolean`, `conversationalRoute()`/`defaultRoute()` return `CoordinatorResult`, `ToolErrorCategory` includes `is_directory` — names are consistent across the tasks that reference them.
- No placeholders: every code/edit step contains the literal code or exact find/replace text and a runnable test command.
