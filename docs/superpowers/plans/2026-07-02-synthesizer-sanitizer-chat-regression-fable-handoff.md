# Fix: synthesizer visible-answer sanitizer chat regression (Layer A plan)

> Execution note: at execution start, copy this plan verbatim to
> `docs/superpowers/plans/2026-07-02-synthesizer-sanitizer-chat-regression-fable-handoff.md`
> (the Layer A record path named in the handoff — plan mode prevented writing it directly).

## Context

The previous session added visible-answer sanitization for orchestrator stages that are
offered no tools (synthesizer/planner/reviewer), to stop free-tier models' echoed tool-call
JSON (`{"name":"read_file","arguments":{...}}`) from leaking into the chat bubble:

- `VisibleAnswerStreamSanitizer` (text-tools.ts:269) — wired into the orchestrator's
  `callModelAttempt` stream path at index.ts:1468 when `!useTextTools && surfaceAsAnswer`.
- A cosmetic strip in `extractTextToolCalls` when `tools=[]` (text-tools.ts:242-248),
  which cleans the post-turn `cleanContent` at index.ts:1651.

Unit tests pass (15/15) and typecheck is green, but the user reports major chat UI
behavioral issues after the change: garbled/format-mangled answers, empty bubbles, and
"The orchestrator completed but produced no output" fallbacks. All three files are still
uncommitted. This plan is the integration-level root-cause analysis and the fix.

## Root cause — confirmed empirically

Probed the real module with `bun -e` (chunked pushes through `VisibleAnswerStreamSanitizer`,
then `flush()`). Results:

| # | Input | Output | Defect |
|---|-------|--------|--------|
| 1 | `"Hello\n\nWorld\n"` | `"Hello\nWorld\n"` | Blank lines (paragraph breaks) eaten |
| 2 | `["Hello", "\nWorld"]` | `"HelloWorld"` | **Newline at a chunk boundary eaten — lines glue together** |
| 3 | `Here: {tool-json}\n` | kept verbatim | Mixed prose+JSON line leaks raw JSON to bubble |
| 4 | two JSON objects, one line | `""` | dropped (OK), but post-turn extract also empties → cascade |
| 5 | `["Result: ", "{tool-json}"]` | `"Result: "` | Mid-line JSON swallowed after early-emit of the prefix |
| 6 | fenced ```` ```json ```` block | fence kept, JSON line removed | Legit code examples destroyed |
| 10 | same, via `extractTextToolCalls(…, [])` | JSON stripped inside fence | Persisted answer also mangles legit examples |

Mechanism for #1/#2 (the dominant, every-turn regression): `emitCompleteLines`
(text-tools.ts:283) skips blank lines (`if (!trimmed) continue`) and early-emits a partial
line when it doesn't start with `{`, clearing `partialLine`. When the line's terminating
`\n` arrives in the next chunk it becomes an empty split element and is skipped — the
newline is lost. Streaming chunk boundaries fall mid-line constantly, so **every streamed
orchestrator answer loses paragraph breaks and random line breaks.**

Why the garble is permanent: JarvisView.tsx:828 ignores the final `result` frame whenever
any `stream_event` delta arrived (`streamedVisibleText`), and `finalizeAssistantMessage`
(JarvisView.tsx:404) persists the **streamed accumulation** to the DB via `append_message`.
The garbled text is what's displayed, saved, and sent back as `history` on the next turn.

Empty-bubble / "produced no output" path: a synthesizer answer that is entirely echoed
tool JSON now sanitizes to empty at both layers → the bounded empty-completion cascade
(index.ts:1703-1739) advances up to 2 more free-pool models (each streaming into the SAME
bubble) → if all echo, `trimmedAnswer` is empty → fallback notice (index.ts:2003). Edge:
if any attempt streamed whitespace-only deltas, `streamedVisibleText` is already true and
the fallback notice is suppressed → truly blank bubble ("empty response there").

### Handoff hypotheses — verdicts

1. **stream-emitter.ts not using VisibleAnswerStreamSanitizer** — TRUE but contained.
   `VisibleTextPipe` (stream-emitter.ts:55) hardcodes `TextToolCallStreamSanitizer`; it is
   used only by the direct (non-orchestrator) chat loop (index.ts:2324). Not the regression
   path; leave as-is, document.
2. **Stream vs post-turn extract mismatch** — TRUE. Line-based dropping (bubble) vs
   span-based stripping (result/telemetry) diverge (probe #3/#5 vs #9/#10); and the UI
   discards the result frame anyway, so bubble+client-DB ≠ server answer.
3. **Partial-line/flush edge cases** — TRUE. Newline loss at chunk boundaries (#2);
   a single-line `{`-prefixed answer is held until flush (bubble appears only at the end);
   whitespace-only flush emissions suppress the fallback notice.
4. **Raw onChunk vs sanitized stream_event** — TRUE but low impact: `onChunk` gets raw
   chunks (index.ts:1535) → pipeline `onStateChange` → `orchestrator_stage` frames, which
   carry only stage/status (index.ts:1802), never the text. No UI leak. No change needed.
5. **JarvisView streamedVisibleText + result fallback** — TRUE, load-bearing.
   JarvisView.tsx:753/828: any delta (even whitespace) permanently suppresses the result;
   streamed garble is persisted, not the sanitized answer.
6. **Over-aggressive isHallucinatedToolPayload** — TRUE as a risk. `TOOL_ALIASES` includes
   generic words (`read`, `write`, `search`, `find`, `ps`, `agent`, `task`); the "legacy
   flat block" rule (text-tools.ts:407-410) strips any `{"name":"search", …anything}` JSON
   in an answer; fence-blind (#6/#10).

## Fix design

Scope: `server-jarvis/src/text-tools.ts`, `server-jarvis/src/text-tools.test.ts`,
`src-ui/src/components/jarvis/JarvisView.tsx`. No changes to index.ts wiring,
stream-emitter.ts, or pipeline.ts. TDD: write the failing tests below first
(superpowers:test-driven-development), then implement.

### 1. Rewrite `VisibleAnswerStreamSanitizer` to be newline-faithful (text-tools.ts)

Governing invariants (both become tests):
- **Chunking invariance**: for any split of the same full text into chunks, concatenated
  output is identical to single-push output.
- **Identity on clean text**: if no line is dropped, output === input, byte for byte
  (all newlines and blank lines preserved).

State: `tagSanitizer` (keep), `pendingLine: string`, `lineAlreadyEmitted: boolean`,
`inFence: boolean`. Per push (after tag-sanitizing):

- Append to buffer; split completed lines on `\n`.
- For each completed line:
  - If `lineAlreadyEmitted` → emit the remaining segment + `"\n"` verbatim (the line was
    already declared safe; this fixes probe #2 — the newline belongs to a decided line).
  - Else decide on the full line: toggle `inFence` on lines whose trim starts with ```` ``` ````;
    inside a fence → always emit verbatim; otherwise drop the line (and its newline) only if
    it is **entirely** hallucinated tool JSON — i.e. `findJsonObjects(line)` finds ≥1 object,
    every object passes `isHallucinatedToolPayload`, and removing all object spans leaves
    only whitespace (this also handles multi-object lines, probe #4, which currently rely on
    `parseJsonLike`'s first-object fallback).
  - Reset `lineAlreadyEmitted = false`.
- Trailing partial line: hold if its `trimStart()` starts with `{` or `` ` `` (possible
  fence marker) or is all whitespace; otherwise emit it now and set
  `lineAlreadyEmitted = true`. Never emit whitespace-only deltas.
- `flush()`: run the tag sanitizer flush through the same path; then decide the pending
  partial as a full line (emit or drop, no trailing `\n` added). Reset all state.

Policy change vs current behavior: mixed prose+JSON lines (probe #3/#5) are **kept whole**
— stripping is line-bounded only. The live incident was bare JSON lines; keeping mixed
lines intact is what makes bubble == persisted answer achievable (see §2).

### 2. Align the cosmetic strip in `extractTextToolCalls` (tools=[] path only)

So the post-turn `cleanContent` (index.ts:1651) matches what the stream emitted:
- Only strip candidates that are **line-bounded**: expand the candidate span to full
  line(s); strip only if the rest of those line(s) is whitespace, removing the line(s)
  including terminator. Mixed lines stay whole (matches §1).
- **Fence-aware**: never strip candidates inside ```` ``` ```` fences (fixes probe #10).
- **Tighten the payload test for the cosmetic path**: keep the strict shape (aliased name
  + `arguments`/`args`/`input`); restrict the legacy flat-block rule to objects keyed by
  `tool`/`tool_name` (e.g. `{"tool":"find_files","path":"."}`) — a generic
  `{"name":"search", …}` object in prose is no longer stripped. The real tool-call parsing
  path (tools offered) is untouched.

Implementation note: apply the tightened `isHallucinatedToolPayload` variant in BOTH §1 and
§2 so the two layers share one predicate (e.g. `isHallucinatedToolPayload(value, {strict})`
or a dedicated `isCosmeticToolEcho()` helper used by both).

### 3. JarvisView: don't let whitespace suppress the fallback notice

- JarvisView.tsx:753-757: set `streamedVisibleText = true` only when the delta contains
  non-whitespace (`/\S/.test(text)`); still append the text.
- Line 828 logic otherwise unchanged: the result frame fills the bubble when nothing
  meaningful streamed — this restores the "produced no output" notice in the blank-bubble
  edge case.

### Explicitly out of scope (follow-ups, note in commit message)

- Replacing the streamed bubble with the server's final `result` text (fixes residual
  divergence at the cost of a visible content swap; with §1+§2 unified the divergence
  should be ~zero, so not worth the UX churn now).
- Switching `VisibleTextPipe` (direct chat path) to the visible-answer sanitizer.
- A degraded-answer fallback (e.g. surface the executor summary) instead of the
  "produced no output" notice when every cascade model echoes JSON — belongs with the
  unfinished B-02 conductor_replan work. The sanitizer change deliberately does NOT try to
  fix the underlying synthesizer-echo model behavior (known pool weakness, see
  self-tuning DB diagnosis).

## Tests to write FIRST (text-tools.test.ts)

Failing-first, all through the public API:

1. Chunking invariance: a multi-paragraph markdown text (headings, blank lines, list with
   loose items) pushed under 4+ different chunkings (per-char, per-word, mid-newline splits,
   single push) — all equal the input exactly.
2. Probe #1/#2/#8 regressions: paragraph break preserved; `["Hello","\nWorld"]` →
   `"Hello\nWorld"`; loose list keeps its blank line.
3. Bare tool-JSON line dropped under arbitrary chunkings (the original incident case),
   including a `{`-split-across-chunks tokenization and a no-trailing-newline flush.
4. Two tool-JSON objects on one line → dropped.
5. Mixed `Here: {tool-json}` line → kept verbatim (policy change).
6. Fenced ```` ```json ```` tool-JSON → kept verbatim, fence intact.
7. Whitespace-only pushes emit nothing.
8. `extractTextToolCalls(…, [])`: bare JSON line stripped (line-bounded, terminator
   removed); fenced JSON kept; mixed line kept; `{"name":"search","query":"x"}` in prose
   kept; `{"tool":"find_files","path":"."}` on its own line still stripped.
9. Existing 15 tests still pass, except any that encode the old mid-line-strip/blank-line
   behavior — update those to the new policy deliberately (call them out in the commit).

UI change is a 1-line predicate; covered by live verification (no UI test harness).

## Verification

1. `cd server-jarvis && bun test` (full suite; baseline was 391 pass) and `bun run typecheck`.
2. Re-run the `bun -e` probe from the investigation; expected: #1 `"Hello\n\nWorld\n"`,
   #2 `"Hello\nWorld"`, #3 unchanged-verbatim, #4 `""`, #6 fence intact with JSON line
   preserved, #8 loose list preserved.
3. Live smoke: start server-jarvis, `curl -N POST /chat/stream` with a prompt that yields a
   multi-paragraph answer; concatenate `stream_event` deltas and confirm blank lines
   survive; confirm exactly one `message_stop` and a `result` frame whose text matches the
   concatenated deltas (modulo trim).
4. UI: launch the app (Tauri dev or rebuilt via `cargo tauri build` — NOT
   build-optimized.ps1), send a message through the orchestrator, confirm paragraph
   rendering in the bubble, and reload the session to confirm the persisted message matches
   what was displayed.

## Rollback

All changes are function-local to text-tools.ts + one predicate in JarvisView.tsx;
`git checkout -- <file>` restores. Nothing here was committed yet — commit only after
verification passes, as a single commit referencing this plan.
