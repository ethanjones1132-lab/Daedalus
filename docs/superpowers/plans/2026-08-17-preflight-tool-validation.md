# Pre-flight Tool Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block tool calls that cannot succeed *before* they execute, and return a message that tells the model exactly how to fix the call.

**Architecture:** A new pure-ish check module runs inside `ToolRuntime.execute()` after the existing required-argument check and before permission policy. It returns either "proceed" or a blocking `ToolResult` carrying a repair hint. Filesystem existence checks are the only I/O, and they are the cheap `existsSync` kind — orders of magnitude cheaper than the failed tool call plus model round trip they replace.

**Tech Stack:** Bun, TypeScript, `bun:test`. No new dependencies.

**Placement rationale:** `tool-runtime.ts:270` already validates required arguments and returns a structured error. That is the established seam for "reject before the handler runs," so this extends the existing pattern rather than inventing a parallel one.

---

## File Structure

| File | Responsibility |
|---|---|
| `server-jarvis/src/preflight-checks.ts` | Pure check registry: given a call + context, return ok or a blocking reason with repair text. |
| `server-jarvis/src/preflight-checks.test.ts` | Per-check tests. |
| `server-jarvis/src/tool-types.ts` | Add the `preflight_blocked` error code. |
| `server-jarvis/src/tool-runtime.ts` | Invoke checks in `execute()`. |
| `server-jarvis/src/config.ts` | `tools.preflight_checks` toggle. |

---

### Task 1: Error code

**Files:**
- Modify: `server-jarvis/src/tool-types.ts`
- Test: `server-jarvis/src/preflight-checks.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server-jarvis/src/preflight-checks.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { ToolErrorCode } from "./tool-types";

describe("preflight error code", () => {
  test("preflight_blocked is a valid tool error code", () => {
    const code: ToolErrorCode = "preflight_blocked";
    expect(code).toBe("preflight_blocked");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/preflight-checks.test.ts`
Expected: FAIL — TypeScript error, `"preflight_blocked"` is not assignable to `ToolErrorCode`.

- [ ] **Step 3: Add the code**

In `server-jarvis/src/tool-types.ts`, find the `ToolErrorCode` union and add the member:

```typescript
  | "preflight_blocked"
```

Add this comment directly above the union member:

```typescript
  /** Rejected by a pre-flight check before execution; carries repair guidance. */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/preflight-checks.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/tool-types.ts server-jarvis/src/preflight-checks.test.ts
git commit -m "feat(tools): add preflight_blocked error code"
```

---

### Task 2: The check registry

**Files:**
- Create: `server-jarvis/src/preflight-checks.ts`
- Test: `server-jarvis/src/preflight-checks.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the contents of `server-jarvis/src/preflight-checks.test.ts` with:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ToolErrorCode } from "./tool-types";
import { preflightCheck } from "./preflight-checks";

describe("preflight error code", () => {
  test("preflight_blocked is a valid tool error code", () => {
    const code: ToolErrorCode = "preflight_blocked";
    expect(code).toBe("preflight_blocked");
  });
});

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-preflight-"));
}

describe("placeholder arguments", () => {
  test("blocks a placeholder path", () => {
    const r = preflightCheck(
      { id: "1", name: "read_file", arguments: { path: "path/to/your/file.ts" } },
      { workspacePath: workspace() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.repair).toContain("actual path");
  });

  test("blocks a placeholder URL", () => {
    const r = preflightCheck(
      { id: "1", name: "web_fetch", arguments: { url: "https://example.com/<your-page>" } },
      { workspacePath: workspace() },
    );
    expect(r.ok).toBe(false);
  });

  test("allows a real-looking url", () => {
    const r = preflightCheck(
      { id: "1", name: "web_fetch", arguments: { url: "https://docs.vllm.ai/en/latest/" } },
      { workspacePath: workspace() },
    );
    expect(r.ok).toBe(true);
  });
});

describe("read of a nonexistent file", () => {
  test("blocks and names the missing path", () => {
    const root = workspace();
    try {
      const r = preflightCheck(
        { id: "1", name: "read_file", arguments: { path: "nope.ts" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain("nope.ts");
        expect(r.repair).toContain("list_dir");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows a file that exists", () => {
    const root = workspace();
    try {
      writeFileSync(join(root, "real.ts"), "export const a = 1;\n");
      const r = preflightCheck(
        { id: "1", name: "read_file", arguments: { path: "real.ts" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not block writes to files that do not exist yet", () => {
    const root = workspace();
    try {
      const r = preflightCheck(
        { id: "1", name: "write_file", arguments: { path: "brand-new.ts", content: "x" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("no-op edits", () => {
  test("blocks an edit whose old and new strings are identical", () => {
    const root = workspace();
    try {
      writeFileSync(join(root, "f.ts"), "const a = 1;\n");
      const r = preflightCheck(
        { id: "1", name: "edit_file", arguments: { path: "f.ts", old_string: "const a = 1;", new_string: "const a = 1;" } },
        { workspacePath: root },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("identical");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("vague searches", () => {
  test("blocks an empty query", () => {
    const r = preflightCheck(
      { id: "1", name: "web_search", arguments: { query: "   " } },
      { workspacePath: workspace() },
    );
    expect(r.ok).toBe(false);
  });

  test("allows a specific query", () => {
    const r = preflightCheck(
      { id: "1", name: "web_search", arguments: { query: "vllm openai compatible server tool calling" } },
      { workspacePath: workspace() },
    );
    expect(r.ok).toBe(true);
  });
});

describe("unknown tools are not this layer's problem", () => {
  test("passes through tools with no registered checks", () => {
    const r = preflightCheck(
      { id: "1", name: "some_future_tool", arguments: { anything: 1 } },
      { workspacePath: workspace() },
    );
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/preflight-checks.test.ts`
Expected: FAIL — cannot resolve module `./preflight-checks`.

- [ ] **Step 3: Write the implementation**

Create `server-jarvis/src/preflight-checks.ts`:

```typescript
// ═══════════════════════════════════════════════════════════════
// Pre-flight tool checks — reject doomed calls before they run
// ═══════════════════════════════════════════════════════════════
// Runs inside ToolRuntime.execute(), after required-argument validation and
// before permission policy. Catches the failure modes that are obvious from
// the arguments alone: invented paths, placeholder URLs, reads of files that
// do not exist, edits that change nothing.
//
// Every block returns repair text addressed to the model. A block that only
// says "no" costs the same round trip it was meant to save.
//
// Conservative by design: when a check cannot decide, it allows. A false
// block is worse than a false allow, because the tool would have reported
// the real error anyway.

import { existsSync } from "fs";
import { isAbsolute, resolve } from "path";
import type { ToolCall } from "./tool-types";

export interface PreflightContext {
  /** Workspace root used to resolve relative paths. */
  workspacePath?: string;
}

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: string; repair: string };

const PLACEHOLDER_PATTERNS = [
  /path\/to\//i,
  /your[-_/]?(?:file|project|path|page|repo)/i,
  /<[^>]+>/,
  /\{\{.+\}\}/,
  /\bTODO\b/,
];

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(value));
}

function resolveInWorkspace(path: string, workspacePath?: string): string {
  if (isAbsolute(path)) return path;
  return workspacePath ? resolve(workspacePath, path) : path;
}

/** Tools whose `path` argument must already exist for the call to succeed. */
const MUST_EXIST = new Set(["read_file", "edit_file", "multi_edit", "apply_patch"]);

/** Arguments that carry a filesystem path, in priority order. */
const PATH_KEYS = ["path", "file_path", "relative_workspace_path"];

function firstStringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function preflightCheck(call: ToolCall, ctx: PreflightContext): PreflightResult {
  const args = call.arguments ?? {};

  // ── Placeholder path ──────────────────────────────────────────────────
  const path = firstStringArg(args, PATH_KEYS);
  if (path && looksLikePlaceholder(path)) {
    return {
      ok: false,
      reason: `The path "${path}" looks like a placeholder, not a real file.`,
      repair: `Replace it with an actual path from this workspace. Use list_dir or grep to find the real one, then call ${call.name} again.`,
    };
  }

  // ── Placeholder URL ───────────────────────────────────────────────────
  const url = firstStringArg(args, ["url"]);
  if (url && looksLikePlaceholder(url)) {
    return {
      ok: false,
      reason: `The URL "${url}" contains a placeholder.`,
      repair: `Supply a complete, real URL. If you do not have one, search for the page first instead of guessing.`,
    };
  }

  // ── Read/edit of a file that is not there ─────────────────────────────
  if (path && MUST_EXIST.has(call.name)) {
    const resolved = resolveInWorkspace(path, ctx.workspacePath);
    if (!existsSync(resolved)) {
      return {
        ok: false,
        reason: `${call.name} target does not exist: ${path}`,
        repair: `Confirm the path before acting on it — list_dir on the parent directory, or grep for the filename. If you meant to create this file, use write_file instead.`,
      };
    }
  }

  // ── Edit that changes nothing ─────────────────────────────────────────
  if (call.name === "edit_file") {
    const oldStr = args.old_string;
    const newStr = args.new_string;
    if (typeof oldStr === "string" && typeof newStr === "string" && oldStr === newStr) {
      return {
        ok: false,
        reason: `edit_file was called with identical old_string and new_string — this edit would change nothing.`,
        repair: `Set new_string to the text you actually want in the file. If no change is needed here, skip the edit and move on.`,
      };
    }
  }

  // ── Empty search ──────────────────────────────────────────────────────
  if (call.name === "web_search" || call.name === "grep") {
    const query = firstStringArg(args, ["query", "pattern"]);
    if (!query) {
      return {
        ok: false,
        reason: `${call.name} was called with an empty query.`,
        repair: `Provide specific search terms describing what you are looking for.`,
      };
    }
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/preflight-checks.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/preflight-checks.ts server-jarvis/src/preflight-checks.test.ts
git commit -m "feat(tools): pre-flight checks for placeholder args, missing files, no-op edits"
```

---

### Task 3: Config toggle

**Files:**
- Modify: `server-jarvis/src/config.ts` (tools config interface + defaults)
- Test: `server-jarvis/src/preflight-checks.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server-jarvis/src/preflight-checks.test.ts`:

```typescript
import { loadConfig } from "./config";

describe("preflight config", () => {
  test("enabled by default", () => {
    expect(loadConfig().tools.preflight_checks).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/preflight-checks.test.ts`
Expected: FAIL — received `undefined`.

- [ ] **Step 3: Add the toggle**

In `server-jarvis/src/config.ts`, add to the tools config interface:

```typescript
  /**
   * Reject tool calls that cannot succeed before running them. On by default:
   * every block replaces a guaranteed-failed call plus a model round trip.
   * Turn off to diagnose a suspected false block.
   */
  preflight_checks: boolean;
```

And to the tools defaults:

```typescript
      preflight_checks: true,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/preflight-checks.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/config.ts server-jarvis/src/preflight-checks.test.ts
git commit -m "feat(config): preflight_checks toggle, on by default"
```

---

### Task 4: Wire into the tool runtime

**Files:**
- Modify: `server-jarvis/src/tool-runtime.ts` (in `execute`, after the `missingArgs` block, before `evaluatePolicy`)
- Test: `server-jarvis/src/tool-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server-jarvis/src/tool-runtime.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("preflight blocking in execute", () => {
  test("blocks a read of a nonexistent file without invoking the handler", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-rt-preflight-"));
    try {
      const runtime = createToolRuntime();
      let handlerRan = false;
      runtime.register(
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        },
        async () => { handlerRan = true; return "should not happen"; },
      );

      const ctx = makeExecutionContext({ surface: "agent", workspace_path: root });
      const result = await runtime.execute(
        { id: "1", name: "read_file", arguments: { path: "missing.ts" } },
        ctx,
      );

      expect(handlerRan).toBe(false);
      expect(result.is_error).toBe(true);
      expect(result.error_code).toBe("preflight_blocked");
      expect(result.output).toContain("list_dir");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a valid call still reaches the handler", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-rt-preflight-ok-"));
    try {
      const runtime = createToolRuntime();
      runtime.register(
        {
          type: "function",
          function: {
            name: "echo",
            description: "Echo",
            parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        },
        async (args) => `echoed: ${args.text}`,
      );

      const ctx = makeExecutionContext({ surface: "agent", workspace_path: root });
      const result = await runtime.execute({ id: "1", name: "echo", arguments: { text: "hi" } }, ctx);

      expect(result.is_error).toBe(false);
      expect(result.output).toBe("echoed: hi");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/tool-runtime.test.ts`
Expected: FAIL — the handler ran and returned "should not happen".

- [ ] **Step 3: Add the check to execute()**

In `server-jarvis/src/tool-runtime.ts`, add the import:

```typescript
import { preflightCheck } from "./preflight-checks";
```

Then in `execute`, insert this block immediately after the `missingArgs` early return and before `const policy = evaluatePolicy(...)`:

```typescript
    // Pre-flight — reject calls that cannot succeed, with repair guidance.
    // Placed after required-argument validation (so checks can assume the
    // required args exist) and before policy (so a doomed call never prompts
    // the user for approval it does not need).
    if (ctx.config.tools.preflight_checks !== false) {
      const preflight = preflightCheck({ ...call, arguments: callArguments }, {
        // ExecutionContext uses snake_case (tool-runtime.ts:63); PreflightContext
        // uses camelCase. Map explicitly rather than renaming either one.
        workspacePath: ctx.workspace_path,
      });
      if (!preflight.ok) {
        const msg = `${preflight.reason}\n\n${preflight.repair}`;
        return {
          call_id: call.id,
          name: call.name,
          output: msg,
          is_error: true,
          error: preflight.reason,
          error_code: "preflight_blocked" satisfies ToolErrorCode,
          duration_ms: Date.now() - start,
        };
      }
    }
```

`ExecutionContext` already carries `config: JarvisConfig` (`tool-runtime.ts:48`) and `workspace_path?: string` (`tool-runtime.ts:63`), so no plumbing is needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/tool-runtime.test.ts`
Expected: PASS, including the whole existing runtime suite.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/tool-runtime.ts server-jarvis/src/tool-runtime.test.ts
git commit -m "feat(tools): block doomed tool calls in the runtime with repair guidance"
```

---

### Task 5: Full suite and false-block sweep

- [ ] **Step 1: Run the whole suite**

Run: `cd server-jarvis && bun test`
Expected: PASS. Failures here are the important signal: any existing test that now gets `preflight_blocked` is a real false block. Fix the check, not the test.

- [ ] **Step 2: Run the benchmark to catch false blocks under real traffic**

Run: `cd server-jarvis && bun run src/self-tuning/cma-es/campaign-cli.ts --smoke --model deepseek-v4-pro-9b`
Expected: reward comparable to the pre-change baseline of 1.0 on `merge_intervals`. A drop means a check is firing on legitimate calls — read `notes` in the printed breakdown to find which.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: full suite and smoke green with preflight checks enabled"
```

---

## Self-Review

**Spec coverage:** error code (T1), the four check families — placeholder args, missing read/edit targets, no-op edits, empty searches (T2), config toggle (T3), runtime integration (T4), false-block sweep (T5).

**Types:** `PreflightResult` and `PreflightContext` are defined in T2 and consumed unchanged in T4. `preflight_blocked` is added to `ToolErrorCode` in T1 and used in T4.

**Known risk — read this before executing:** the cost of this feature is false blocks. A check that rejects a legitimate call is strictly worse than no check, because the model now has to argue its way past a gate instead of getting a real error. Every check here is written to allow when uncertain, and T5 step 2 exists specifically to catch cases the unit tests do not. If a false block appears in live use, the fix is to narrow the check — not to add an escape hatch to the prompt.
