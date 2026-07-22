# Jarvis Architecture vs. Model Baseline — Tier-2 (Harder) Coding Benchmark, 2026-07-21

Follow-up to `BENCHMARK_2026-07-21.md`, which the tier-1 suite (4 simple
agentic-edit tasks) hit 12/12 on after the surgical-edit fixes. This round
raises the difficulty specifically to find where the architecture's benefit
comes from now, and where it still has weaknesses. Same model both sides —
`opencode_zen deepseek-v4-flash-free` — confirmed as the live executor's
actual model via `self-tuning.db` (200 recent `executor`-stage attributions),
against the live deploy (`b536279`).

## TL;DR

| Category | Baseline | Architecture | Read |
|---|---|---|---|
| A — harder matched-info logic bugs (4 tasks × K=3) | 7/12 | 6/12 | **Architecture slightly worse** — new pitfall found (below) |
| B — multi-file exploration, asymmetric baseline (2 tasks × K=3) | 2/6 | 5/6 | **Architecture wins big** — real structural capability |
| C — iteration-required edge cases (2 tasks × K=3) | 6/6 | 6/6 | **Ceiling — didn't discriminate** |
| **Total** | **15/24** | **17/24** | Architecture ahead, but the headline number understates what's actually going on |

**The real story isn't in the totals.** Diagnosing every failing sample down
to the actual file contents (not just PASS/FAIL) surfaces two findings much
bigger than the topline delta:

1. **8 of baseline's 9 failures (89%) were empty completions, not wrong
   answers** — `deepseek-v4-flash-free` returns nothing on a large minority
   of harder prompts. When it returns *any* content, it was correct in
   15/16 of those cases (93.75%). Architecture had **zero** empty-response
   failures across all 24 samples. Resilience — not reasoning — is still the
   dominant, and now much larger, advantage.
2. **4 of architecture's 7 failures (57%) are silent no-ops**: the turn
   reports success but the file on disk is byte-identical to the buggy seed
   — nothing was ever written. This is a *new* failure mode the tier-1
   fixes (write-file preference, syntax gate, syntax-driven repair loop)
   do not catch, because a no-op leaves syntactically perfect code — there's
   nothing for a parse-check to flag.

## Method

- **Category A** (`merge_intervals`, `lru_cache`, `topological_sort`,
  `parse_csv_line`): both sides see the full buggy file — a fair,
  matched-info reasoning test, just with harder bugs than tier-1's
  (unsorted-input handling, recency tracking, cycle detection, quoted-field
  parsing vs. tier-1's leap-year/flatten/binary-search/rotate).
- **Category B** (`pkg_discount`, `pkg_auth`): a 2-file package where the
  actual bug lives in a helper module. The baseline is deliberately shown
  only the entry file (a single completion structurally cannot browse a
  repo it wasn't pasted into) and told the other module exists but is
  off-limits; the architecture gets the whole package seeded on disk and
  must Grep/Read to find the real bug. **This is an intentional asymmetry**
  measuring a structural capability gap, not a fairness-matched contest.
- **Category C** (`safe_divide_batch`, `retry_with_backoff`): bugs where an
  "obvious" first-pass fix commonly still fails a strict edge case (wrong
  output length from a stray `continue`, off-by-one total call count) that
  only running the test reveals — meant to probe whether the review/verify
  loop earns its keep.
- K=3 per task (24 samples per arm). Baseline = one direct
  `chat/completions` call via `bun fetch` (Python is Cloudflare-blocked on
  this endpoint — same trap as tier-1). Architecture = one live
  `/chat/stream` turn. Same deterministic test scores both.

## Findings

### 1. Resilience is bigger than tier-1 showed — and it's now the dominant story
Tier-1 found this on one task (`rotate_right`, ~50% empty-completion rate)
and treated it as a narrow quirk. It isn't: **8 of 9 baseline failures across
this whole harder suite were empty completions** — `lru_cache`,
`topological_sort` (all 3 samples), `parse_csv_line`, `pkg_discount`,
`pkg_auth` (2 of 3) all returned `content: ""` from the model, confirmed by
reading the raw call output directly (not inferred from the test failure).
Only one baseline failure (`pkg_auth` s0) was the model actually answering
and getting it wrong. Architecture recovered every single one — zero
stream/empty failures in 24 turns. If graded only on samples where the
baseline model actually said something, it passed 15/16 (93.75%) — **matches
tier-1's "no reasoning uplift" finding almost exactly**, just with a much
larger empty-completion floor than previously measured.

### 2. New pitfall: silent no-op edits (majority of remaining failures)
Direct diffs against the seed file:
- `merge_intervals` s0 — file is **byte-identical** to the buggy seed.
- `lru_cache` s1 and s2 — both **byte-identical** to the buggy seed.
- `pkg_discount` s1 — **both** `calc.py` and `rules.py` byte-identical to
  seed (the turn never touched the package that contained the actual bug).

That's 4 of 7 total architecture failures. The turn completed, the SSE
stream drained normally, and the pipeline reported done — but no tool call
that actually mutated the file ever landed, or one was attempted and
silently failed. This is the tier-1 report's predicted-but-unclosed gap:
recommendation #3 from `BENCHMARK_2026-07-21.md` ("a cheap diff-vs-spec
reviewer would catch no-op edits — s1 left the file unchanged") was flagged
but the syntax gate that actually shipped only catches *parse* failures.
An unchanged file is syntactically perfect Python — the gate has nothing to
flag. **This is the architecture's clearest remaining weakness.**

### 3. Multi-file exploration: real signal, once the task didn't leak the fix
`pkg_auth` is the clean version of this test: baseline 0/3 (2 empty, 1 wrong
— structurally it can only edit `session.py`, and the bug is in `tokens.py`,
which it never sees) vs. architecture 3/3 (found and fixed the inverted
`now > expires_at` comparison in `tokens.py` every time). This is the
architecture's clearest genuine capability advantage — file-system access
and grep/read tools reach bugs a single completion structurally cannot.

`pkg_discount` (2/3 baseline vs 2/6 arch... — actually 2/3 both) is a weaker
version of the same test, and it's a benchmark-design mistake on my part:
the bug-report text spelled out the exact numeric discount schedule ("under
$100 = 0%, $100–$200 = 10%, $200+ = 20%"), so a model could pass by simply
inlining that literal schedule into `calc.py` without ever needing to find
or read `rules.py` — which defeats the point of hiding the file. Worth
fixing before reusing this task: describe the *symptom* only, never the
corrected rule.

### 4. Category C didn't discriminate — a calibration miss, reported honestly
Both `safe_divide_batch` and `retry_with_backoff` went 3/3 on both arms.
The hypothesized trap (an obvious fix that quietly breaks a strict edge
case) didn't materialize for this model — `deepseek-v4-flash-free` handles
both edge cases correctly on the first pass essentially every time. Not
every difficulty hypothesis pans out; this one didn't, and it's reported as
a miss rather than reframed after the fact.

### 5. Task-design defect found in `topological_sort` — both arms' 0/3 is not a clean signal
Every sample on both sides failed this task, but reading the architecture's
actual output shows why it's not a fair "architecture is bad at cycle
detection" data point: one recovered sample
(`work/arch_topological_sort_0/solution.py`) implements textbook-correct
3-state (unvisited/visiting/visited) cycle detection and correctly raises
`ValueError` on cycles — the intended fix landed cleanly. All 3 samples
still failed on the *acyclic* ordering checks with the exact same symptom:
output order reversed (`['c','b','a']` instead of `['a','b','c']`). Tracing
it back: **the original seed's `return order[::-1]` was already wrong** for
the edge convention this task specifies (`graph['c']=['a','b']` means `a`
and `b` are `c`'s prerequisites) — postorder DFS under that convention
already yields dependencies-first without reversing; reversing it flips
dependents before dependencies. This is a second, unintended bug I baked
into the seed alongside the intended "no cycle detection" one, and none of
the 6 total samples (3 baseline empty, 3 architecture) happened to catch or
question it since they weren't asked to. Recommendation: fix the seed
(drop the reversal) and re-run this task in isolation before trusting its
score either direction.

### 6. Cost
Architecture averaged 107s/turn vs. baseline's 18s/turn — **~5.9× slower**
on average (range 50–366s vs. baseline's near-instant-or-empty pattern).
Consistent with tier-1's 5–50× finding; the harder tasks didn't change the
latency multiplier materially.

## Actionable recommendations

1. **Close the no-op-edit gap.** The syntax gate only catches parse
   failures; it does nothing when a tool call silently fails to apply or
   the model claims completion without ever invoking a write/edit tool.
   Needs a **diff-based effect check**: after a CHANGE-classified turn,
   compare the target file(s)' content/mtime against a pre-turn snapshot;
   if nothing changed, treat it exactly like the existing
   `empty_completion` reviewer-feedback path (force a rewriter turn with
   explicit "your last attempt did not modify the file" feedback) instead
   of letting the turn report success. This is the single highest-value fix
   from this round — it accounts for the majority of remaining failures.
2. **Re-measure baseline empty-completion rate as a first-class metric**,
   not an aside. It's now 33% of all baseline attempts in this suite (8/24),
   not the ~17% (1/6 on one task) tier-1 suggested. Worth tracking
   per-provider/per-model in the self-tuning DB alongside the existing
   `fallback_used`/`had_error` columns so this shows up in the same place
   as other reliability telemetry P5.1 just added.
3. **Fix task hygiene before reusing this suite**: `topological_sort`'s
   seed has an unintended second bug (the reversal); `pkg_discount`'s spec
   leaks the exact numeric fix. Both should be corrected so a re-run
   produces a clean signal in isolation.
4. **Category C's difficulty hypothesis missed** — if further probing this
   model's edge-case handling is wanted, harder traps are needed; these two
   didn't stress it.

## Caveats

- Free/shared models — `deepseek-v4-flash-free`'s empty-completion rate is
  plausibly load-dependent (shared free-tier capacity), not a fixed model
  property; a paid/dedicated endpoint would likely show a different (lower)
  floor. Doesn't change the qualitative finding that the architecture's
  retry path is where most of its measured value still comes from.
- K=3 per task — directional. The clean categorical results (`pkg_auth`
  0/3→3/3, `topological_sort` 0/3→0/3 both arms) are large enough to be
  meaningful; single-sample deltas within Category A are closer to noise.
- No fix has been implemented yet for finding #2 (no-op edits) — this
  report is the diagnosis, not a re-verified fix, unlike tier-1's doc which
  included a post-fix re-run.

Artifacts: `scratchpad/bench2/` (tasks, harness, `results_baseline.json`,
`results_arch.json`, full per-sample solution files under `work/`,
`full_run.log`).
