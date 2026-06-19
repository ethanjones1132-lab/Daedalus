# Jarvis Frontier-Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Inline execution chosen; backend-first ordering.

**Goal:** Close the 7 genuinely-open gaps in Jarvis (memory auto-recall, Top-K sampling, accurate token counting, diff preview, message actions + auto-resize, @-mention file context, virtual scrolling + tool-error self-healing).

**Architecture:** The chat runtime is a zero-dependency Bun server (`server-jarvis`) streaming SSE that a Tauri/Rust bridge re-emits as `jarvis://*` events to a React UI (`src-ui`). Memory lives in the same SQLite `jarvis.db` with an existing `memory_fts` FTS5 table + sync triggers. Backend tasks add a small `tokens.ts` + `memory-recall.ts` module and extend request bodies; frontend tasks extend `JarvisView.tsx` / `MarkdownRenderer.tsx` and `ToolCallCard.tsx`.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `gpt-tokenizer` (new dep), `diff` (new dep), React 19, framer-motion, Tailwind v4, Tauri v2.

**Path note:** Writable repo view is `\\wsl.localhost\ubuntu\home\ethan\.openclaw\agents\coderclaw\workspace\home-base` (the `/mnt/wslg/distro` mirror is read-only). Run `bun test` and `bun build` from the writable view.

**Decisions locked:** Add `gpt-tokenizer` + `diff` deps (user-approved). Inline execution, backend-first. Task #4 scope = generate + display unified diff in the tool card (the existing `ToolApprovalModal` is a client-only no-op, so a full blocking approve/reject round-trip is out of scope and noted as follow-up).

**Slight reorder from the offered list:** Top-K → Tokens → Memory recall → Diff, so memory budgeting can use the accurate tokenizer. Then Message actions → @-mention → Virtual scroll + self-healing.

**Verification reality:** `server-jarvis` has `bun test` with existing `*.test.ts` (TDD applies). `src-ui` has **no** test runner — frontend tasks are verified by `tsc -b` typecheck + `vite build` + manual app check.

---

## File Structure

**New files**
- `server-jarvis/src/tokens.ts` — single `countTokens(text)` / `estimateTokens` wrapper around `gpt-tokenizer` with a cached encoder + code safety multiplier. Replaces all `length/4` sites.
- `server-jarvis/src/tokens.test.ts` — unit tests.
- `server-jarvis/src/memory-recall.ts` — `recallMemories(message, opts)` opens `jarvis.db` readonly, FTS5-MATCHes the user message, ranks (bm25 + relevance_score + recency), returns formatted system block + raw rows.
- `server-jarvis/src/memory-recall.test.ts` — unit tests against an in-memory DB seeded with the real schema.
- `server-jarvis/src/diff.ts` — `buildUnifiedDiff(oldText, newText, path)` wrapper around `diff` returning a compact hunk structure for the UI.
- `server-jarvis/src/diff.test.ts` — unit tests.

**Modified files**
- `server-jarvis/src/config.ts` — add `top_k` config field (default 40); per-surface stays via `surfaceTemperature`.
- `server-jarvis/src/index.ts` — apply `top_k` to Ollama `options` + OpenRouter body; swap `length/4` → `countTokens`; inject memory recall into `effectiveSystemPrompt`; emit `diff` in the `tool_call` event for Write/Edit/MultiEdit; tool-error self-healing hint loop.
- `server-jarvis/src/filesystem-bundle.ts` — compute pre-write old/new content for Write/Edit/MultiEdit so a diff can be produced.
- `src-ui/src/components/jarvis/ToolCallCard.tsx` (and/or `ToolCallBlock.tsx`) — render the unified diff when present.
- `src-ui/src/components/jarvis/JarvisView.tsx` — message hover actions (copy/edit/regenerate), auto-resize textarea, @-mention dropdown, virtual scrolling for the message list.
- `src-ui/src/components/jarvis/MarkdownRenderer.tsx` — (already done) no change unless diff styling shared.

---

## Task 1: Top-K sampling (gap #2)

**Files:**
- Modify: `server-jarvis/src/config.ts` (add `top_k` to config type + defaults)
- Modify: `server-jarvis/src/index.ts:1125-1131`, `:1480-1486` (Ollama options + OpenRouter body), and the secondary request sites `:3138`, `:3349`
- Test: `server-jarvis/src/config.test.ts`

- [ ] **Step 1: Failing test** — assert `normalizeConfig({})` yields `top_k === 40` and that an explicit `top_k` survives normalization.
- [ ] **Step 2: Run** `bun test src/config.test.ts` → FAIL (top_k undefined).
- [ ] **Step 3: Implement** — add `top_k: number` to `JarvisConfig` (and the profile type if profiles carry sampling), default `40` in `normalizeConfig`/defaults near the existing `top_p: 0.95`.
- [ ] **Step 4:** In `index.ts`, wherever `requestBody.options` is built for Ollama, add `top_k: cfg.top_k ?? 40`; for OpenRouter add `requestBody.top_k = cfg.top_k` when defined. Apply to all 4 sites.
- [ ] **Step 5: Run** `bun test src/config.test.ts` → PASS; `bun build ./src/index.ts --outdir ./dist --target bun` → succeeds.
- [ ] **Step 6: Commit** `feat(inference): add Top-K sampling (default 40) to Ollama + OpenRouter requests`

---

## Task 2: Accurate token counting (gap #3)

**Files:**
- Create: `server-jarvis/src/tokens.ts`, `server-jarvis/src/tokens.test.ts`
- Modify: `server-jarvis/src/index.ts:829` (local `estimateTokens`), `:1394` (compaction estimate), `server-jarvis/src/orchestration/pipeline.ts` (6 `length/4` sites)
- Dep: add `gpt-tokenizer`

- [ ] **Step 1:** `bun add gpt-tokenizer` (from the writable view).
- [ ] **Step 2: Failing test** (`tokens.test.ts`): `countTokens("hello world")` is > 0 and within ±20% of `gpt-tokenizer` `encode().length`; `countTokens("")` === 0; a 1k-char code string counts higher than `len/4` would (sanity that we're not under-counting code).
- [ ] **Step 3: Run** `bun test src/tokens.test.ts` → FAIL (module missing).
- [ ] **Step 4: Implement** `tokens.ts`:
  ```ts
  import { encode } from "gpt-tokenizer";
  // cl100k proxy; bump 10% for non-OpenAI/code-heavy safety margin.
  const SAFETY = 1.1;
  export function countTokens(text: string | null | undefined): number {
    if (!text) return 0;
    try { return Math.ceil(encode(text).length * SAFETY); }
    catch { return Math.ceil(text.length / 4); } // fallback never throws
  }
  ```
- [ ] **Step 5:** Replace `Math.ceil((text||"").length/4)` in `index.ts` `optimizeContextWindow` and the compaction estimate, and the 6 sites in `pipeline.ts`, with `countTokens(...)`. Import at top.
- [ ] **Step 6: Run** `bun test` (full) → green; `bun build` → succeeds.
- [ ] **Step 7: Commit** `feat(context): real BPE token counting via gpt-tokenizer, replacing len/4 heuristic`

---

## Task 3: Memory auto-recall in chat path (gap #1)

**Files:**
- Create: `server-jarvis/src/memory-recall.ts`, `server-jarvis/src/memory-recall.test.ts`
- Modify: `server-jarvis/src/index.ts` — call recall in `streamJarvis` native path before building `effectiveSystemPrompt` (around `:1373`), and the claude_cli path (around `:1020`). Reuse `locateJarvisDb()`.
- Test: `server-jarvis/src/memory-recall.test.ts`

- [ ] **Step 1: Failing test** — seed an in-memory `Database` with the `memory` + `memory_fts` schema (copied from `migrations.rs`), insert 3 memories, assert `recallMemories(db, "deploy the tauri app", {limit:2})` returns the 2 most relevant ordered, and that a query with no matches returns `[]` and an empty block string.
- [ ] **Step 2: Run** `bun test src/memory-recall.test.ts` → FAIL.
- [ ] **Step 3: Implement** `memory-recall.ts`:
  - `sanitizeFtsQuery(msg)` → tokenize to words, drop tokens < 3 chars and FTS operators, join with ` OR `, cap to ~12 terms.
  - `recallMemories(db, message, {limit=3, agentId="jarvis"})`:
    ```sql
    SELECT m.id, m.title, m.content, m.relevance_score,
           bm25(memory_fts) AS rank
    FROM memory_fts JOIN memory m ON m.id = memory_fts.id
    WHERE memory_fts MATCH ? AND m.status='active' AND m.agent_id=?
    ORDER BY (rank * -1) + m.relevance_score
             + (CASE WHEN m.updated_at_ms > ? THEN 0.5 ELSE 0 END) DESC
    LIMIT ?
    ```
    (recency boost: `updated_at_ms` within last 7 days.)
  - `formatMemoryBlock(rows)` → `"[Relevant memories]\n- {title}: {content}\n..."` or `""` if none.
  - Public `recallForMessage(message, opts)` that resolves `locateJarvisDb()`, opens readonly, queries, closes, and never throws (returns `""` on any error).
- [ ] **Step 4: Run** `bun test src/memory-recall.test.ts` → PASS.
- [ ] **Step 5: Wire into `index.ts`** — in `streamJarvis`, compute `const memoryBlock = await recallForMessage(message, {config: cfg})` once near stream start; prepend to `effectiveSystemPrompt` (`[memoryBlock, systemPrompt, textToolInstructions].filter(Boolean).join("\n\n")`). Same for claude_cli `--append-system-prompt`. Log `[Jarvis] recalled N memories`.
- [ ] **Step 6:** Emit a lightweight `jarvis://memory_recall` debug event (optional) OR just log. Keep UI unchanged for now.
- [ ] **Step 7: Run** `bun test` full + `bun build` → green.
- [ ] **Step 8: Commit** `feat(memory): auto-recall top-N relevant memories into the chat system prompt via FTS5`

---

## Task 4: Diff generation + display for Write/Edit/MultiEdit (gap #4)

**Files:**
- Create: `server-jarvis/src/diff.ts`, `server-jarvis/src/diff.test.ts`
- Modify: `server-jarvis/src/filesystem-bundle.ts:182-255` (capture old/new content), `server-jarvis/src/index.ts:1034` (include `diff` in tool_call event for fs-mutating tools)
- Modify: `src-ui/src/components/jarvis/ToolCallCard.tsx` (render diff)
- Dep: add `diff`
- Test: `server-jarvis/src/diff.test.ts`

- [ ] **Step 1:** `bun add diff` + `bun add -d @types/diff` (from writable view).
- [ ] **Step 2: Failing test** — `buildUnifiedDiff("a\nb\nc\n","a\nB\nc\n","f.txt")` returns hunks with one removed `b` and one added `B`; identical input returns `{ changed:false }`.
- [ ] **Step 3: Run** `bun test src/diff.test.ts` → FAIL.
- [ ] **Step 4: Implement** `diff.ts` using `createTwoFilesPatch`/`structuredPatch` from `diff`; return `{ changed, path, additions, deletions, patch }`.
- [ ] **Step 5:** In `filesystem-bundle.ts`, for Write/Edit/MultiEdit read the existing file (if any) BEFORE writing, compute new content, and attach a `__diff` to the returned result OR (cleaner) compute the diff at the index.ts tool-dispatch layer where the event is emitted. Decide at impl time; prefer index.ts layer to keep handlers pure. The event at `:1034` gains `diff: <structuredPatch>` when `name ∈ {Write,Edit,MultiEdit}`.
- [ ] **Step 6:** In `ToolCallCard.tsx`, when `tool_call.diff` is present render a compact green/red line view with `+N/-M` summary, collapsed by default with expand.
- [ ] **Step 7: Run** `bun test` full + `tsc -b` (src-ui) + `vite build` → green.
- [ ] **Step 8: Commit** `feat(tools): unified diff preview for Write/Edit/MultiEdit in the tool card`

> Follow-up (out of scope): real blocking approve/reject requires a server↔client decision round-trip; the current `ToolApprovalModal` only dismisses. Tracked separately.

---

## Task 5: Message actions + auto-resize textarea (gap #5)

**Files:**
- Modify: `src-ui/src/components/jarvis/JarvisView.tsx` (message hover toolbar at the render site ~`:800-820`; textarea at `:846`)
- Verify: `tsc -b` + `vite build` + manual

- [ ] **Step 1:** Add a `MessageActions` hover toolbar component in `JarvisView.tsx` (or a small new file): Copy (all roles, `navigator.clipboard.writeText(msg.content)`), Edit (user msgs → loads content back into input + truncates history to that point), Regenerate (assistant msgs → re-send prior user turn).
- [ ] **Step 2:** Wire Copy first (pure, no state risk). Then Edit: set `input`, drop messages after the edited user msg, focus input. Then Regenerate: re-invoke send with the preceding user message and drop the stale assistant msg.
- [ ] **Step 3:** Auto-resize textarea — replace fixed `rows={2}`/`resize-none` behavior with an `onInput` handler that sets `el.style.height='auto'; el.style.height=Math.min(el.scrollHeight, 0.4*window.innerHeight)+'px'`. Keep Enter-to-send / Shift+Enter newline.
- [ ] **Step 4:** Respect reduced motion — guard any new framer-motion on the toolbar with `useReducedMotion()`.
- [ ] **Step 5: Verify** `tsc -b && vite build`; manual: hover a message → actions appear; type multi-line → grows then caps.
- [ ] **Step 6: Commit** `feat(chat): per-message copy/edit/regenerate actions + auto-resizing input`

---

## Task 6: @-mention file context (gap #6)

**Files:**
- Modify: `src-ui/src/components/jarvis/JarvisView.tsx` (input handler + dropdown)
- Possibly add: a Tauri command or reuse an existing fs-list command to fuzzy-list workspace files; check `src-tauri/src/commands` for an existing file lister before adding one.

- [ ] **Step 1:** On `@` in the input, open a fuzzy-search dropdown of workspace files. Source the file list from an existing Tauri command if present (search `src-tauri/src/commands/*.rs` for a list/glob command); else add `list_workspace_files`.
- [ ] **Step 2:** On selection, insert `@path` token and stage the file to be read + injected. At send time, read selected files (existing Read tool path / Tauri fs) and prepend a `[Referenced files]` block to the message or system context.
- [ ] **Step 3:** Keyboard nav (↑/↓/Enter/Esc) in the dropdown; debounce filter.
- [ ] **Step 4: Verify** `tsc -b && vite build`; manual: `@` shows files, selection injects context.
- [ ] **Step 5: Commit** `feat(chat): @-mention workspace files to inject context`

---

## Task 7: Virtual scrolling + tool-error self-healing (gap #7)

**Files:**
- Modify: `src-ui/src/components/jarvis/JarvisView.tsx` (message list)
- Modify: `server-jarvis/src/index.ts` (tool-result error path ~`:1777`)
- Dep: `@tanstack/react-virtual` (frontend)

- [ ] **Step 1 (self-healing, backend):** `bun add` not needed. In the native tool loop, when a tool result is an error, classify it (not-found / permission / timeout / parse) by message substring and append a targeted hint to the `currentPrompt` continuation ("File not found — verify the path with glob before retrying"). Cap to 2 self-heal retries per tool call via a per-call counter.
- [ ] **Step 2:** Add a `tool-heal.ts` pure classifier + `bun test` for it (input error string → category + hint). TDD.
- [ ] **Step 3 (virtual scroll, frontend):** `bun add @tanstack/react-virtual` in `src-ui`. Replace the mapped message list with a `useVirtualizer` windowed list; preserve auto-scroll-to-bottom on new tokens (the existing pinned-scroll logic at `:492`).
- [ ] **Step 4:** Gate the per-message framer-motion entrance animation behind `useReducedMotion()` and only animate the last message to keep the virtualizer cheap.
- [ ] **Step 5: Verify** `bun test` (heal) + `tsc -b && vite build`; manual: 100+ msg session scrolls smoothly; a forced tool error retries with a hint.
- [ ] **Step 6: Commit** `feat: virtualized message list + tool-error self-healing retry loop`

---

## Self-Review

- **Coverage:** Tasks 1–7 map 1:1 to gaps #2,#3,#1,#4,#5,#6,#7. All 7 covered.
- **Type consistency:** `countTokens` name used identically in tokens.ts + call sites; `recallForMessage`/`recallMemories` split is consistent; `buildUnifiedDiff` returns the same shape consumed by the event + UI.
- **Placeholders:** none — each backend task has concrete SQL/TS; frontend tasks are verified by typecheck+build since `src-ui` has no test runner.
- **Risk notes:** (a) `gpt-tokenizer` default encoding is a proxy for Qwen — the 1.1 multiplier covers it. (b) Diff capture must read the file before write — handled in filesystem layer. (c) Memory recall must never throw into the hot chat path — wrapped in try/catch returning `""`.