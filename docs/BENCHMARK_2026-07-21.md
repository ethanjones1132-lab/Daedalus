# Jarvis Architecture vs. Model Baseline — Coding Benchmark, 2026-07-21

Controlled benchmark answering: **does the orchestration architecture produce better
code than a single call to the same underlying model?** Run against the live deploy
(`74ca171`). Baseline and architecture use the **same** model — `opencode_zen
deepseek-v4-flash-free` (the executor's model) — so the comparison isolates the
*architecture's* contribution, not model choice.

## TL;DR

| Suite | Baseline (single-shot) | Architecture | Read |
|---|---|---|---|
| Codegen, 9 tasks (N=1) | 8/9 | 9/9 | **Matches** (within noise) |
| Agentic edit, 4 tasks × K=3 | **9/12** | **6/12** | **Architecture is WORSE** |

**The architecture does not out-reason the model. On write-from-scratch it matches;
on edit-existing-code it underperforms** — its surgical-edit mechanism corrupts simple
fixes. Its one clear win is **resilience**: it recovers transient model failures a naive
single call cannot. All of this at **5–50× latency**.

## Method

- **Same model both sides.** An earlier cut used gemma4:e2b as the baseline (4/5) — the
  *wrong*, weaker model; the architecture actually writes with deepseek. Corrected here.
- **Baseline** = one `deepseek-v4-flash-free` completion (via bun `fetch`; the endpoint
  Cloudflare-blocks non-browser clients, so Python couldn't call it — a methodology trap
  worth recording). Code extracted from the completion and tested.
- **Architecture** = one Jarvis `/chat/stream` turn that writes/edits a file; the file is
  tested. Same deterministic tests decide PASS/FAIL for both.
- **Harness fairness:** the baseline was initially penalized by (a) a 1200-token cap that
  truncated longer solutions and (b) a naive code extractor. Both were fixed (3000 tokens
  + truncation-robust extraction) before the numbers above.

## Findings

### 1. Reasoning — no uplift
Whenever the model returns content, it solves every task in this set correctly. The
architecture does not make it reason better. Codegen 9/9 vs 8/9 is within N=1 noise (the
one baseline "miss" was a transient empty completion, not a logic error).

### 2. Resilience — the architecture's clearest, genuine benefit
`rotate_right`: **baseline 0/3, architecture 3/3.** The model returns an *empty
completion* on that prompt ~50% of the time (confirmed: on retry, 2/3 came back non-empty
and both passed — so it's transient, not a reasoning gap). A naive single call is stuck
when the model returns empty; the architecture's retry / multi-turn execution (incl.
today's reviewer retry-on-empty) recovers it. This is real, demonstrated value.

### 3. Surgical edits — the architecture's clearest pitfall
On the three agentic tasks the model fixes cleanly single-shot (3/3 each), the
architecture introduced failures:

- `is_leap_year` **0/3**. s0 left correct logic but an **orphaned token** from a botched
  `edit_file`: `... or (year % 400 == 0) rule` → SyntaxError (`rule` is the tail of the
  seed's `# bug: ...century rule` comment the edit failed to remove). s1 left the file
  **completely unchanged** (edit never applied) yet the turn ended.
- `flatten` 1/3, `binary_search` 2/3 — same class of edit-application errors.

**Weak models performing surgical `old_string`/`new_string` edits corrupt simple fixes**
(orphaned text, no-op edits), where a single-shot "return the whole corrected file"
rewrites cleanly. This is why the architecture nets 6/12 vs 9/12 on edits.

### 4. The flagship review→rewrite loop barely fires
Across the benchmark turns, executor ran 3× per turn but the **rewriter stage almost never
ran** — so the review/fix loop is *not* where the architecture's (narrow) value came from.
Its recovered wins are from retry/multi-turn execution; its losses are unreviewed edit
corruption. A post-edit syntax/verify gate would have caught the `is_leap_year` SyntaxError
trivially — and did not.

### 5. Cost
Codegen 5–20× slower (35–116s vs ~5s). Agentic worse: 37–268s per turn vs ~5s single-shot.

## Where benefits and pitfalls land

| Axis | Verdict |
|---|---|
| Raw reasoning | No uplift — matches the model |
| Reliability / resilience | **Benefit** — recovers transient empty completions (3/3 vs 0/3) |
| Agentic edit correctness | **Pitfall** — surgical edits corrupt simple fixes (6/12 vs 9/12) |
| Structural capability | Benefit — real file artifacts + verification; no extraction fragility |
| Latency | Pitfall — 5–50× |

## Actionable recommendations

1. **Prefer full-file `write_file` over surgical `edit_file` for small files.** Weak models
   botch precise edits; a clean rewrite avoids the orphaned-text / no-op failure modes that
   cost `is_leap_year` and `flatten`. (Route by file size / edit scope.)
2. **Add a post-write syntax/parse gate.** The `is_leap_year` SyntaxError is trivially
   detectable; the pipeline shipped it. Parse the written file (py_compile / tsc) inside the
   effect gate and force a repair turn on failure.
3. **Make the review loop actually engage on edits** (it barely fired). A cheap
   diff-vs-spec reviewer would catch no-op edits (s1 left the file unchanged).
4. **Keep the resilience wins** — retry-on-empty and multi-turn execution are the
   demonstrated value; do not regress them while fixing the edit path.

## Caveats

- Free local/remote models (deepseek-flash, gemma) — a stronger executor would likely
  shrink both the edit-corruption pitfall and the resilience benefit.
- N=1 on codegen; K=3 on agentic — directional, not tight statistics. The agentic gap
  (6/12 vs 9/12) is large enough to be meaningful; the codegen match is within noise.
- Harness: baseline needs code extraction (a real-world friction the architecture avoids by
  writing files) — noted where it affected results.

Artifacts: `scratchpad/bench/` (tasks, harness, per-sample solution files).
