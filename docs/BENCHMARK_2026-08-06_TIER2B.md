# Jarvis Architecture vs. Model Baseline — Tier-2B (39-task suite)

## Status

D1 expanded the fixture suite from 11 to 39 tasks (`scripts/benchmark-tier2b/tasks.py`,
`held_out.py`). A live K=3 measurement was run against the dev server built
from source at commit `689f64d` (both target-path reward fixes and the D1/qwen
work landed first). Raw result in `scripts/benchmark-tier2b/results-tier2b.json`
(gitignored, per convention — this file is the durable record).

Live mode makes 234 inference calls at K=3 (39 tasks × 3 × 2 arms). Wall
clock: ~9 min baseline arm + ~100 min architecture arm.

## Live K=3 result (2026-08-06)

| Arm | Passes | Rate |
| --- | ---: | ---: |
| Baseline | 107/117 | 91.5% |
| Architecture | 111/117 | 94.9% |

For comparison, the original 11-task suite (2026-07-22,
`docs/BENCHMARK_2026-07-21_TIER2B.md`) measured baseline 66.7% / architecture
100%. The gap narrowed here mainly because the suite grew from 11 adversarial
tasks to 39 — 28 of the new tasks are single-file, non-adversarial (no hidden
dependency, no fabrication bait), which a raw single-call baseline handles
fine and pulls its average up. The architecture arm's small drop from 100%
is a real signal from harder new tasks, not noise — see Root cause below.

Category breakdown:

| Category | Baseline | Architecture |
| --- | ---: | ---: |
| A — general bugs | 35/36 | 36/36 |
| B — hidden-file package bugs | 13/21 | 20/21 |
| C — edge-case semantics | 21/21 | 21/21 |
| D — I/O & process | 21/21 | 19/21 |
| E — symbol grounding | 17/18 | 15/18 |

**Category B is still the headline result.** Baseline 61.9% vs. architecture
95.2% — the hidden-dependency-fix advantage from the original 11-task run
(0% → 100%) holds at scale. The two original bait tasks (`pkg_discount`,
`pkg_auth`) that baseline has never once solved are still 0/3 → 3/3.

Per-task results:

| Task | Category | Baseline | Architecture |
| --- | :-: | ---: | ---: |
| `merge_intervals` | A | 3/3 | 3/3 |
| `lru_cache` | A | 3/3 | 3/3 |
| `topological_sort` | A | 3/3 | 3/3 |
| `parse_csv_line` | A | 2/3 | 3/3 |
| `pkg_discount` | B | 0/3 | 3/3 |
| `pkg_auth` | B | 0/3 | 3/3 |
| `safe_divide_batch` | C | 3/3 | 3/3 |
| `retry_with_backoff` | C | 3/3 | 3/3 |
| `load_or_create_json` | D | 3/3 | 3/3 |
| `run_checked` | D | 3/3 | 3/3 |
| `clamp_with_lib` | E | 2/3 | 3/3 |
| `find_rotation_point` | A | 3/3 | 3/3 |
| `nested_lookup` | C | 3/3 | 3/3 |
| `slugify_with_lib` | E | 3/3 | 3/3 |
| `binary_search_first` | A | 3/3 | 3/3 |
| `group_anagrams` | A | 3/3 | 3/3 |
| `drop_negatives` | A | 3/3 | 3/3 |
| `merge_sorted` | A | 3/3 | 3/3 |
| `roman_to_int` | A | 3/3 | 3/3 |
| `is_balanced` | A | 3/3 | 3/3 |
| `running_sum` | A | 3/3 | 3/3 |
| `pkg_inventory` | B | 2/3 | 3/3 |
| `pkg_tax` | B | 2/3 | 2/3 |
| `pkg_rate_limit` | B | 3/3 | 3/3 |
| `pkg_shipping` | B | 3/3 | 3/3 |
| `pkg_grade` | B | 3/3 | 3/3 |
| `mutable_default_counter` | C | 3/3 | 3/3 |
| `coalesce` | C | 3/3 | 3/3 |
| `chunk_list` | C | 3/3 | 3/3 |
| `parse_bool` | C | 3/3 | 3/3 |
| `atomic_write` | D | 3/3 | 3/3 |
| `read_text_lines` | D | 3/3 | 1/3 |
| `ensure_parent_write` | D | 3/3 | 3/3 |
| `append_log_line` | D | 3/3 | 3/3 |
| `capture_stdout` | D | 3/3 | 3/3 |
| `quantize_with_lib` | E | 3/3 | 3/3 |
| `hash_with_lib` | E | 3/3 | 3/3 |
| `format_with_lib` | E | 3/3 | 3/3 |
| `normalize_with_lib` | E | 3/3 | 0/3 |

## Root cause of every architecture-arm failure: `delegate_snapshot_error`

The 6 failing samples (`pkg_tax` s1; `read_text_lines` s1, s2; `normalize_with_lib`
s0, s1, s2) are **not** correctness failures. Checked each one's final synthesizer
output and self-tuning DB trace directly:

- None fabricated a symbol. `normalize_with_lib` specifically baits fabricating
  `os.fastnorm`/`pathlib.quick_clean` — every failing attempt correctly found
  and used the real `lib/pathutil.py` helper instead. A1/A3 grounding held.
- Every failing sample's own synthesizer output honestly reports the fix as
  incomplete ("The fix was not applied", "I can't claim the task is done —
  it isn't") rather than overclaiming. B3 calibration held under pressure.
- The actual cause: **`claude_cli`/`minimax-m3` delegate calls threw
  `delegate_snapshot_error` before launching**, in all 6/6 failing samples
  (12 occurrences total), every time with the identical underlying exception:

  ```
  Error: EISDIR: illegal operation on a directory, read
  ```

  This is the delegate's pre-launch ground-truth snapshot (`claude-delegate.ts`)
  attempting to read a path that `git ls-files`/the directory walk reported as
  a file but that is actually a directory — consistent with the walk resolving
  a root wider than the fixture's own tiny temp workspace (two prior incidents
  in this exact file, both 2026-08-05, describe the same class: an
  ungitignored `build/` directory and a walk that widened to a drive root).
  The existing `DELEGATE_INFRASTRUCTURE_FAILURES` fix correctly avoids
  benching the model for an infrastructure crash it never saw, and the
  pipeline does fall back to other providers — but the retry/fallback churn
  is what burns wall-clock (one single attempt in `normalize_with_lib` s0 cost
  324.9s of its 596.2s total), and in the worst cases the task runs out of
  turn budget before a fallback provider lands a credited write.

**Not fixed in this session** — root-caused, not resolved. The next concrete
step is to trace what root `claude-delegate.ts`'s snapshot resolves to for a
live (non-fixture) session and confirm it isn't reaching outside the intended
workspace.
