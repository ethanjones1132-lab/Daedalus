# Long context for keep96: results, 2026-10-07

- **Spec:** `2026-10-07-long-context-design.md` (0c55967). **Plan:** `../plans/2026-10-07-long-context.md` (33cac9b).
- **Runs:** 13:16–15:31 on 2026-10-07. Keep96 ran with `--load-mode none` and the Versutus gate paused (restarted at 15:31, last result 0). The owner's GPU apps were closed, leaving 739 MiB of the card in use at idle.
- **Data:** `docs/benchmarks/longctx/`, with local paths scrubbed.

## Outcome

**The chosen window is 131,072 tokens (128k), with the q8_0 cache.** It is the largest window that passes both bars. 64k passes them too.

| Bar | 64k | 128k |
|---|---|---|
| **(a) Short tasks unchanged.** Tier2b recipe on the 2026-10-06 seeds, against 107/117 at 16k. | 107/117, all 351 answers identical ✓ | 107/117, all 351 answers identical ✓ |
| **(a) Speed.** Short-prompt generation against the 16k control (277 tok/s). | 1.03× ✓ | 1.02× ✓ |
| **(b) Late no worse.** Same tasks after a long session, against Short at the same window. | 94 vs 100. Tasks 3 vs 8, sign p 0.23 ✓ | 92 vs 100. Tasks 5 vs 8, sign p 0.58 ✓ |

Three findings temper this. None changes the pre-registered verdict, but all three matter for how the window is used:
1. **Late loses more outside hidden-convention tasks** (§3).
2. **Recall over distance fails badly** (Early, §4).
3. **Jarvis's batch size has to drop to 512** at any window from 64k up. And **64k and 128k fit on the card only with GPU-heavy apps closed** (§1).

## 1. Memory and speed grid

All rows used keep96 with all layers on the GPU and MTP 2 + n-gram speculation. "Short" is the mean of `gen` and `edit2k`, run 3 times each. "Depth" is the worst ratio of a deep prompt's generation or reading speed against the smallest window that ran it.

| Window | ub | Cache | VRAM above idle, loaded / peak (MiB) | Shared memory vs control (MiB) | Short tok/s (ratio) | Depth ratio | Pass |
|---|---|---|---|---|---|---|---|
| 16k | 512 | q8_0 | 5,647 / 5,677 | 0 | 277.0 (1.00) | — | ✓ control |
| 32k | 512 | q8_0 | 5,865 / 5,953 | +32 | 277.0 (1.00) | 1.00 | ✓ |
| 64k | 512 | q8_0 | 6,384 / 6,474 | +92 | 284.6 (1.03) | 1.00 | ✓ |
| 64k | 1024 | q8_0 | 6,600 / 6,677 | +244 | 217.0 (**0.78**) | **0.54** | ✗ |
| 96k | 512 | q8_0 | 6,852 / 6,912 | +148 | 284.3 (1.03) | 0.99 | ✓ |
| 128k | 512 | q8_0 | 6,852 / 6,986 | +219 | 282.6 (1.02) | 0.99 | ✓ |
| 96k | 512 | q4_0 | 6,441 / 6,493 | +160 | 281.7 (1.02) | **0.48** | ✗ |
| 128k | 512 | q4_0 | 6,812 / 6,866 | +224 | 275.6 (1.00) | **0.46** | ✗ |

**Speed at depth,** from the 128k q8_0 row (prompt tokens counted by the server):

| Prompt | Tokens | Reading | Generation |
|---|---|---|---|
| deep26k | 25,189 | 1,922 tok/s (13 s) | 111 tok/s |
| deep54k | 56,389 | 1,654 tok/s (34 s) | 183 tok/s |
| deep80k | 82,894 | 1,475 tok/s (56 s) | 105 tok/s |
| deep108k | 114,032 | 1,306 tok/s (87 s) | 61 tok/s |

Generation speed at depth depends on the prompt's content as well as its length (n-gram speculation). The same prompt runs at the same speed at every window size that holds it.

**Reuse across turns works on this hybrid model.** At every window, with the server's context checkpoints:
- the same deep prompt again read 4 new tokens;
- the same chat plus one turn read 28;
- the same text with a different closing question read 511 (1,023 at ub 1024).

In the long-session runs, after each filler's first read, a Late task read only its own 60–190 tokens, in about 0.4 s.

**Headroom: the window's cache is reserved at load, whether or not it is used.**

| Window | Loaded above idle | Peak above idle | Total, apps closed (739 MiB) | Total, usual apps (about 1,930 MiB) |
|---|---|---|---|---|
| 16k | 5,647 | 5,677 | 6.4 GB | 7.6 GB |
| 32k | 5,865 | 5,953 | 6.7 GB | 7.9 GB |
| 64k | 6,384 | 6,474 | 7.2 GB | **8.4 GB** |
| 128k | 6,852 | 6,986 | 7.7 GB | **8.9 GB** |

The card has 8,188 MiB. **With the usual apps open, both 64k and 128k exceed it even before a long prompt.** This grid ran with apps closed and did not measure what Windows does then: moving the cache to system memory could slow every request, as ub 1024 did (0.78×). The rollout check must measure that (see Rollout).

**Batch 1024 overflows.** It is Jarvis's current setting. At 64k, generation drops to 0.78× on short prompts and 0.54× at depth. The ub-1024 row at 128k wasn't run (deviation 1). Since 64k already fails, Jarvis needs `batch_size` 512 for any window from 64k up. Prompt reading at ub 512 is about 9% slower than at ub 1024 when it fits.

**The q4_0 cache saves about 400 MiB but halves generation at depth** (89 vs 184 tok/s on deep54k). It is not worth it on this card.

## 2. Bar (a): short tasks

| Window | Recipe solved | Paired against 16k | Candidate answers identical |
|---|---|---|---|
| 64k | 107/117 | 0 vs 0 | 351/351 |
| 128k | 107/117 | 0 vs 0 | 351/351 |

A larger window changes nothing on tier2b's short tasks. Short single answers inside the long-session runner also matched the stored 16k candidate 0:
- grade on 115 of 117;
- text on 105 of 117;
- 100 solved on both sides.

The cause of the 12 text differences was not investigated. Only 2 change the grade, one each way, and both sides solve 100.

## 3. Bar (b): Late against Short

Late puts each tier2b task turn, unchanged, after a filler from the calibration pool and standard-library files. There are 3 fillers per length, one per trial.

| | Short | Late, 64k | Late, 128k |
|---|---|---|---|
| Session before the task (tokens, server count) | 0 | 53,700–53,900 | 110,700–112,100 |
| Solved | 100 | 94 | 92 |
| Samples: Late-only vs Short-only (McNemar p) | — | 5 vs 11 (0.21) | 6 vs 14 (0.115) |
| Tasks: Late better vs worse (sign p) | — | 3 vs 8 (0.23) | 5 vs 8 (0.58) |
| A / B / C / D / E solved | 36 / 6 / 21 / 20 / 17 | 32 / **9** / 19 / 20 / 14 | 33 / **9** / 18 / 18 / 14 |
| First read of a filler | — | 33.5 s | 87 s |
| Mean wall time per sample | 0.8 s | 2.0 s | 3.9 s |

**A confound the design missed.** The filler's 12 calibration-pool hidden-convention episodes each show a hidden-package fix with its reference answer. They act as worked examples, so hidden-convention tasks (B) went up, 6 → 9.

The other four categories carry the cost of length. Without B, the totals are 94 → 85 at 64k and 94 → 83 at 128k. The tasks that drop are the same at both lengths:

| Task | Short | Late 64k | Late 128k |
|---|---|---|---|
| `retry_with_backoff` (C) | 3 | 1 | 0 |
| `clamp_with_lib` (E) | 3 | 1 | 0 |
| `parse_csv_line` (A) | 3 | 2 | 1 |
| `ensure_parent_write` (D) | 3 | 2 | 1 |

*Exploratory, not pre-registered:* the sign test without B gives 7 vs 1 tasks at 64k (p 0.07) and 7 vs 2 at 128k (p 0.18).

So the pre-registered bar passes, but a long session does cost something on ordinary tasks. The pass is helped by an in-context-example effect that real sessions will have only sometimes.

## 4. Early: recall over distance (reported, not in the bar)

Early states the task and its file first, then about 54k tokens of filler, then "Back to the first task: write the complete fixed file now."

| | Short | Early, 64k |
|---|---|---|
| Solved | 100 | **53** |
| Samples: Early-only vs Short-only | — | 1 vs 48 (McNemar p < 0.001) |
| Tasks: Early better vs worse | — | 0 vs 24 (sign p < 0.001) |
| A / B / C / D / E | 36 / 6 / 21 / 20 / 17 | 22 / **0** / 15 / 13 / **3** |
| Prompt read per sample | 0.2 s | 33 s (no shared prefix) |

**Failure mode, from the stored answers.** The model usually returns the right file with the bug left in, or a near-copy of it. It recalls the code but not the requirement. A few answers name the wrong function or module.

**Keep96 cannot act on a requirement stated 54k tokens back.** Agent sessions that rely on that will fail about half the time.

## 5. What this means for using the window

- **The window size itself is free.** Bar (a) is identical, and speed is unchanged when the window isn't filled.
- **Filling it has two costs:**
  1. Prompt time: 33 s for a cold 54k read and 87 s for 111k. It is fast afterwards only if each turn keeps the previous prompt as an exact prefix.
  2. Quality: a modest loss when the task is stated at the end, and a large one when it is stated far back.
- **For Jarvis this argues for three things:**
  1. **Restate the active requirement in the latest turn** (Late's shape, not Early's).
  2. **Keep prompts append-only, so checkpoints are reused.** Jarvis's `optimizeContextWindow` trims history from the front, which changes the prefix and forces a full re-read. At 128k that happens only when the window overflows.
  3. **Treat compaction (approach C in the design discussion) as a complement:** the large window is headroom, not the default fill.

## Deviations from the spec and plan

1. **Grid pass rule** (owner-approved at 13:36). The spec judged overflow by the shared-memory counter, at most 100 MiB above the 16k control.
   - The counter grew with the window at unchanged speed, and also with *less* VRAM in use (q4_0). So it measures a host-side buffer, not overflow.
   - The rule became: same-prompt generation and reading speed at depth within 5% of the smallest window that ran the prompt, plus the short-prompt check.
   - The original verdict is kept as `grid.verdict.v1-spill-rule.json`. Under it, only 64k would have passed.
   - The grid had already chosen its extra rows under the old rule, so q4_0 rows ran at 96k and 128k, and no ub-1024 row ran at 128k.
2. **Run order** (plan): bar (a) at 64k ran before the 128k session, and Early ran last.
3. **Unit token counts** came from the session server's `/tokenize`. Real fillers landed 3–4% under target (53.7–53.9k against 56k, and 110.6–112.0k against 116k, by the server's count), inside the builder's ±5%. The server's own prompt counts are stored per sample.

## Rollout (plan Task 8; after the Laya v3 run, about 15:00 on 2026-10-08)

- **Serve script:** `-c 131072`, plus the 128k row in the docblock table. The cache stays q8_0.
- **Jarvis:**
  - `context_window` 131072 and `batch_size` 512 in both stores, with backups;
  - restart, then confirm `/props` reports `n_ctx` 131072;
  - **with the usual apps open,** time short-prompt generation at 131072 against 16384. If it drops more than 5%, fall back to the largest window that holds speed with apps open (32k fits with 0.3 GB to spare), or run long sessions with GPU-heavy apps closed. This is the owner's call;
  - hold one chat past 30k tokens and check that turn 2's `cache_n` covers the earlier turns (append-only prompts).
- **Benchmark harnesses stay at 16k.**

## Files

`docs/benchmarks/longctx/`:

| File | Contents |
|---|---|
| `grid.jsonl`, `grid.out` | Grid rows |
| `grid.verdict.json` | Grid verdict, speed rule |
| `grid.verdict.v1-spill-rule.json` | Grid verdict, original rule |
| `sessions.jsonl` | Every Short, Late and Early sample, with timings and answers |
| `sessions.fillers.json` | The units in each filler |
| `unit-tokens.json` | Unit token counts |
| `report.json`, `report.out` | The report |
| `recipe-{65536,131072}.jsonl` and `.out` | Bar (a) runs |
| `bar-a-*.json` | Bar (a) scores |
| `chain.log` | The chain's log |
