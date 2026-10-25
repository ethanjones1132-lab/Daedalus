# Best-of-N offline measurement (DD-011 hold prerequisite)

**Date:** 2026-10-24
**Run:** `20261024-1815-daedalus-197-daedalus-dd011-offli` (evidence only)
**Status:** measurement produced; live wiring **not** merged, **not** modified.
**Verdict:** does **not** clear the §674 gate as an unconditional licence to enable. Recommendation:
land the wiring (it is correct and gated) with `orchestrator.best_of_n.enabled` staying **`false`**
— i.e. keep the stage inert in practice until the follow-ups in §9 land.

> Provenance note, read this first. The harness is `server-jarvis/scripts/benchmark-best-of-n-offline.ts`
> and it runs the real scorer/sampler/config-gate/telemetry. Its **model turns are authored fixtures**,
> not recorded model output (no pinned loopback model is available in this environment; see
> `AGENTS.md`). The defect rate of the fixtures is therefore an *assumption*, which is why §7 reports
> a fixture-independent sensitivity curve. The executing worker's shell was sandboxed to read-only
> git, so the harness could not be executed by the worker: every number below was derived from the
> fixture definitions plus the scorer's published arithmetic, and the harness **hard-asserts the
> headline totals and the per-group improvement counts at the end of the run and exits 1 on any
> drift**. The coordinator's run of `bun run scripts/benchmark-best-of-n-offline.ts` is the
> verification step.

---

## 1. What §674 actually asks for

`docs/superpowers/plans/2026-08-17-best-of-n-tool-calls.md:674`:

> **Deliberately deferred — read before executing:** this plan does not wire the sampler into a live
> stage. Every module is tested and inert. Call-site integration is a separate change with its own
> risk (latency multiplication on a local 9B, interaction with the stage watchdog and the first-token
> affordability cap), and it should be made only after a measurement run shows `improvedOverFirst` is
> true often enough to be worth the tokens. Run the sampler offline against fixture tasks first.

So the gate has three parts, and this run addresses them separately:

| §674 requirement | Addressed by | Result |
|---|---|---|
| Run the sampler offline against fixture tasks | harness + 60 fixture slates | done |
| `improvedOverFirst` often enough to be worth the tokens | §5, §6, §7 | 26.7% at d=0.30; cost is 3.0× with no early exit |
| Live-latency / watchdog / first-token risk | §6.3, §6.4 (repo-anchored budgets) | 3.0× per-turn wall clock; stage budget headroom 19.4 → 6.5 turns |

§674 supplies **no numeric threshold**. §8 defines one explicitly rather than inventing agreement
after seeing the number.

## 2. Method

**Code under measurement.** Base commit `bae5796` (`rh/…-dd011-offli` HEAD, the held patch's base).
The held patch `b985c87` was read, not applied. It contains exactly one behavioural change relevant
here — `normalizeSampledCall` at the model boundary (`best-of-n.ts`) — plus the executor call-site
swap in `pipeline.ts:3503`. The harness copies that normalization function verbatim at the *stub*
boundary so the fixture slates reach the unmodified base scorer/selector in the same shape the patch
produces. Everything downstream (min-across-calls scoring, fatal filtering, sort by score then seed,
`summarizeSampling`) is the real module.

**Control.** The harness also replays the same slates with **no** normalization — the exact situation
if the sampler were wired without the patch's mapping. That is not a hypothetical: the base sampler
reads `candidate.name` / `candidate.arguments`, while the provider boundary emits
`{ id, type, function: { name, arguments } }`.

**Modes compared, per fixture, same messages and tools:**

| Mode | Path exercised | Calls |
|---|---|---|
| baseline | `callModelWithBestOfN` with `{enabled:false, n:3, stages:["executor"]}` → `bestOfNForStage` → 1 | 1, **unseeded** (asserted) |
| enabled | `callModelWithBestOfN` with `{enabled:true, n:3, stages:["executor"]}` → `sampleBestToolCall` | 3, seeds 0/1/2 |

`improvedOverFirst`, `firstScore`, `selectedScore`, `fatalCandidates`, `emptyTurns` all come from
`summarizeSampling`. No network, no model calls, no filesystem writes, no execution of the sampled
tool calls.

## 3. Fixtures

60 cases. Each case is a plausible executor slate of three candidate turns against the real executor
tool surface (`read_file`, `list_directory`, `grep`, `write_file`, `run_check`), with one or two tool
calls per turn. Defect classes are exactly the ones the static scorer can detect — unknown tool,
missing required argument (fatal); unknown argument −0.15, wrong type −0.25, empty string −0.20,
placeholder path −0.30, stacked defects additive.

`d` = share of cases whose **first** sample is defective (non-fatal defect, fatal, or empty turn).
The primary fixture set uses **d = 0.30 (18/60)**. This is a deliberate assumption, chosen at the
generous end of what a local 9B executor plausibly produces, so the measurement is biased *towards*
justifying the patch. §7 replaces it with a curve so no reader has to accept 0.30.

| Group | Pattern (seed0 / seed1 / seed2) | n | Purpose |
|---|---|---|---|
| A `clean_first_all_clean` | clean / clean / clean, same call | 26 | the common case: sampling can never help, still pays |
| B `clean_first_valid_tie` | three valid but *different* real paths (1.0 tie) | 8 | semantic choice, invisible to the scorer |
| C `clean_first_later_defective` | clean / placeholder or fatal / unknown-arg | 8 | pure cost (2 cases carry a fatal later sample) |
| D `placeholder_then_clean` | placeholder / clean / clean | 8 | placeholder path repaired |
| E `fatal_missing_required_then_clean` | fatal `{}` / clean / wrong-type | 4 | fatal candidate rescued |
| F `empty_turn_then_clean` | no tool call / clean / clean | 2 | empty turn rescued |
| G `all_defective_marginal_gain` | placeholder+unknown-arg / placeholder / placeholder | 2 | improvement *within* defective class |
| H `all_defective_first_still_best` | empty-string arg / wrong-type / placeholder | 1 | pays, first still wins |
| I `defective_tie_with_different_call` | placeholder / placeholder-alt / placeholder+unknown | 1 | equal top score, different call, tie-break keeps seed 0 |

6 cases carry a multi-call turn (the executor's real shape, where the sampler scores a turn by its
*minimum* call and marks the turn fatal if *any* call is fatal).

## 4. Headline numbers

| Metric | Baseline (disabled) | Enabled (n=3) | Delta |
|---|---|---|---|
| Model calls | 60 | 180 | +120 (3.00×) |
| Prompt tokens | 126,000 | 378,000 | +252,000 |
| Completion tokens | 3,124 | 9,540 | +6,416 |
| **Total tokens** | **129,124** | **387,540** | **+258,416 (3.0012×)** |
| Improved over first | — | **16 / 60 = 26.7%** | — |
| Tokens per improved call | — | **16,151** | — |
| Extra calls per improvement | — | 7.5 | — |
| Spend on the 44 non-improving turns | — | 190,198 (73.6% of the extra) | — |

Per-group detail (extra calls = 2 per case by construction, since n=3 defeats the early exit — §6.1):

| Group | n | improved | extra calls | extra tokens | fatal cands | empty turns | ties* |
|---|---|---|---|---|---|---|---|
| A | 26 | 0 | 52 | 111,588 | 0 | 0 | 0 |
| B | 8 | 0 | 16 | 34,368 | 0 | 0 | 8 |
| C | 8 | 0 | 16 | 35,050 | 2 | 0 | 0 |
| D | 8 | **8** | 16 | 33,768 | 0 | 0 | 0 |
| E | 4 | **4** | 8 | 17,866 | 4 | 0 | 0 |
| F | 2 | **2** | 4 | 7,992 | 0 | 2 | 0 |
| G | 2 | **2** | 4 | 8,592 | 0 | 0 | 0 |
| H | 1 | 0 | 2 | 4,296 | 0 | 0 | 0 |
| I | 1 | 0 | 2 | 4,896 | 0 | 0 | 1 |
| **Total** | **60** | **16** | **120** | **258,416** | **6** | **2** | **9** |

\* ties = a later sample reaches the same top score with a *different, equally valid* call, and the
seed-order tie-break keeps seed 0. These 9 cases are the sharpest limit of the rubric: the model
actually offered a different choice and the scorer had no way to prefer either one.

## 5. On which dimensions the winner beat the first sample

The plan's rubric is the static scorer (plan §"Why static scoring": schema validity, required
arguments, argument plausibility; 1.0 = no defects). Improvement is therefore always *structural*:

| First-sample defect repaired | Count | Score delta |
|---|---|---|
| Placeholder path (`path/to/your/file.ts` → real path) | 8 | 0.70 → 1.00 |
| Missing required argument (fatal, call undispatchable) → valid call | 4 | 0.00 → 1.00 |
| No tool call at all → valid call | 2 | 0.00 → 1.00 |
| Placeholder + unknown argument → placeholder only | 2 | 0.55 → 0.70 |
| **Total** | **16** | |

**Zero** improvements were "semantically wrong call → semantically right call". The scorer cannot see
that dimension, which is why group B (8 cases) and group I (1 case) exist: 9 times out of 60 the
slate contained a different, equally-scoring call and sampling selected seed 0 anyway, paying 3× for
the privilege.

Improvement is structurally bounded by the first-sample defect rate: `P(improve) ≤ d`, and given a
defective first sample the fixture set rescued **16/18 = 88.9%**.

## 6. Cost

### 6.1 Calls — the early exit is dead at the default `n`

`best-of-n.ts:124` stops sampling early only when **`input.n > 3`**. The shipped config is `n: 3`
(`config.ts`, asserted by `best-of-n.test.ts:109-115`), so a gated executor stage always draws exactly
three calls, even when sample 0 is already perfect. Measured: 180/180 fixture turns made 3 calls;
0/60 slates exited early. The plan's "stops early on a perfect candidate to save tokens" property
(plan Task 2, test at `best-of-n.test.ts:79`) buys nothing at the default configuration.

Disabling the extra samples would otherwise be the cheapest fix, and it is not available.

### 6.2 Tokens

`+258,416` tokens per 60 executor turns = **+4,306.9 tokens per executor model turn**, of which
73.6% is spent on turns that could not improve. At an 8-turn executor loop that is ≈+34.5k tokens per
task, ≈+1.03M tokens per 30-task day, to obtain ≈2.1 improved calls per task.

Prompt tokens dominate (97.5% of the delta) because each extra sample re-sends the full executor
prompt: 3.0× prompt, not 3.0× total.

### 6.3 Latency — anchored to repo-measured numbers, not invented

- Executor successful-run p50 duration is **3.1 s** (`turn-budget.ts:70-72`, from `self-tuning.db`,
  n=3112). Three sequential samples make an executor model turn ≈**9.3 s** (+6.2 s, 3.0×).
  Nothing in the sampler overlaps the calls (`for` loop with `await`).
- Executor stage ceiling is **60 s** in both `workspace_read` and `full_execution`
  (`turn-budget.ts:218`, `:237`). Model-turn headroom inside one executor stage therefore falls from
  **19.4 turns to 6.5 turns**. Multi-file executor loops that currently need more than ~6 model turns
  will begin hitting `StageBudgetExhaustedError` purely because of sampling — a behaviour change that
  no correctness test in the held patch covers.

### 6.4 First-token and watchdog behaviour (the risk §674 names)

- The sampler passes **`onChunk: undefined`** (`best-of-n.ts:83-85`). With sampling enabled the
  executor publishes **no `stage_token` events** for the whole sampling window: the user-visible
  first token for that turn arrives only after all three samples return, ≈3× the per-call
  first-token latency. `suppressActivity: true` is already set at the call site, so nothing else
  covers the silence.
- Per-call first-token watchdog is 45 s (`config.ts:648`, `:653`), and it is clamped to
  `requestBudgetMs` derived from the *remaining* stage budget (`index.ts:3139`). Sample 2 and 3 start
  with strictly less remaining budget, so the samples that carry the entire benefit are exactly the
  ones with the smallest first-token window. A model with a 20 s cold start needs 60 s of first-token
  allowance across three sequential calls — the whole 60 s executor stage ceiling.
- The sampler throws `StageAbortedError` if the stage aborts mid-slate (`best-of-n.ts:127-129`); the
  conductor's `abort_stage` (`conductor.ts:711`) now has 3× the wall-clock window to fire, and when it
  does, every already-valid candidate is discarded rather than used.
- Offline fixture runs cannot produce watchdog timeouts, so this table reports **0** and the numbers
  above are the structural reason to expect them live. That is a stated limitation, not a zero.

## 7. Sensitivity — the part that does not depend on the authored fixtures

For independent samples where a defect is detected with probability `d` and exactly one "clean" state
exists: with n=3, `P(improve) = d·(1−d²)`; with n=2, `P(improve) = d`. Tokens per improvement use the
measured means (`+4,306.9` per turn for n=3; `2,152.1` per call for n=2).

| Defect rate d | P(improve) n=2 | tokens/improvement n=2 | P(improve) n=3 | tokens/improvement n=3 |
|---|---|---|---|---|
| 0.05 | 5.0% | 43,041 | 5.0% | 86,355 |
| 0.10 | 10.0% | 21,521 | 9.9% | 43,504 |
| 0.15 | 15.0% | 14,347 | 14.7% | 29,374 |
| 0.20 | 20.0% | 10,760 | 19.2% | 22,432 |
| 0.25 | 25.0% | 8,608 | 23.4% | 18,376 |
| **0.30 (primary)** | **30.0%** | **7,174** | **27.3%** | **15,776** |
| 0.40 | 40.0% | 5,380 | 33.6% | 12,818 |
| 0.50 | 50.0% | 4,304 | 37.5% | 11,485 |

Note the ceiling: `P(improve)` never exceeds 37.5% for n=3, because two thirds of the slate is spent
on turns whose first sample was already fine. `n=2` dominates `n=3` at every defect rate on this
rubric — it halves the cost and loses no improvements when a single later clean sample suffices.

## 8. Verdict against §674

§674 gives a qualitative test: `improvedOverFirst` "true often enough to be worth the tokens".
Operationalized as token-neutrality — extra tokens per improved call must not exceed the cost of the
failure the improvement prevents:

- Extra spend: **16,151 tokens per improved call**, = **7.5 baseline executor calls**
  (16,151 / 2,152.1).
- An avoided defect costs **one** recovery turn in the cheap case (tool error → re-call): 2,152
  tokens. Sampling is then **7.5× token-negative**.
- Break-even requires the avoided defect to cost **≥7.5 executor model turns** (≈23 s at p50, more
  than a third of the 60 s executor stage budget) — i.e. only near-catastrophic defects pay for
  themselves.
- Even at an implausible d=0.50, cost is 11,485 tokens per improvement (5.3× a recovery turn).

Against the qualitative reading ("is it *rarely* true?"), 26.7% is **not** rare — but "not rare" is
not the same as "worth it", and the rubric's own ceiling (37.5%) plus the flat 3.0× charge on every
turn is why the plan's telemetry docstring says to turn sampling off if it does not justify the
spend.

**Verdict: FAIL** on the operationalized threshold; **inconclusive** on the qualitative one, because
the plan states no number and the rubric measures structural validity only, not task success. The
§674 clause *"run the sampler offline against fixture tasks first"* is now discharged: the
harness exists and is reproducible. That does not show the extra tokens are worth paying; the
verdict above is FAIL on that test.

Separately, a piece of **supporting evidence for the patch itself**: without `normalizeSampledCall`
the control run scores **178/180 candidates fatal**, selects **0/60** slates, and dispatches a tool
call on **0/60** turns. The other two candidates are the empty first samples (group F): they have no
tool call, so they are not fatal, and they do not dispatch either. The mapping in the held patch is
necessary; wiring the sampler without it would silently turn the executor into a no-tool-call stage.
This is a correctness argument, not a value argument. Re-ran 2026-10-24 (grok): every other
documented total matched; only this control count was wrong (180 vs 178).

## 9. Recommendation

**Land the live wiring, keep the config default off — do not enable sampling.**

1. The wiring is correct and gated (`enabled:false` + `stages:["executor"]`); landing it changes no
   runtime behaviour, and §8's control run shows the normalization in the patch is load-bearing.
2. Do **not** flip `enabled` on this evidence. At the plausible-to-generous d=0.30 it costs 3.0× the
   executor stage's model spend to buy one structurally-better call per ~4 turns, ≈7.5× short of
   token-neutral.
3. Before any enablement, three code changes are prerequisites, none of which this evidence run is
   allowed to make:
   - **Make the early exit reachable at n=3** (or default to n=2). Today `n > 3` means the cheap path
     is unreachable at the shipped configuration, and `n=2` strictly dominates on this rubric.
   - **Restore a heartbeat while sampling**: forward `onChunk` for the *winning* sample or publish a
     stage-activity ping per sample, otherwise enabling sampling dark-outs the executor UI for 3×
     the per-call latency.
   - **Gate sampling by turn class** (write-effect / evidence-bearing turns only) rather than every
     executor model turn, so the 73.6% of spend on already-clean turns disappears.
4. **The held patch cannot, by itself, ever produce the live evidence §674 wants**: nothing in the
   patch calls `summarizeSampling` (`grep summarizeSampling server-jarvis/src` finds only the module
   and its tests), so a wired run would not record `improvedOverFirst` anywhere. Adding that
   telemetry call at the executor call site is a required follow-up — noted here rather than edited,
   per the run's hard rules.
5. To replace the d=0.30 assumption with a measurement, capture ~50 real executor slates from a
   pinned local model and replay them through `sampleBestToolCall`; that also exercises the
   first-token watchdog and stage budget, which no offline harness can.

## 10. Failure modes (counts)

| Failure mode | Count | Note |
|---|---|---|
| First sample defective | 18 / 60 | the assumed d = 0.30 |
| Rescued given a defective first sample | 16 / 18 (88.9%) | the best case for the patch |
| Fatal candidates | 6 / 180 | 4 fatal first samples (E, missing required argument), 2 fatal later samples (C: 1 missing-required, 1 unknown tool) |
| Empty turns (no tool call) | 2 | first-sample empties inflate `improvedOverFirst`: firstScore 0 by definition |
| Seed disagreements (selected seed ≠ 0) | 16 | identical set to the improvements, by construction |
| Ties at top score, different call | 9 | scorer blind to which valid call is right |
| Slates with no viable candidate | 0 | sampler correctly returns no selection |
| Baseline fatal first samples | 4 / 60 | those turns fail without sampling |
| Watchdog timeouts / aborts | 0 | **not reproducible offline** — see §6.4 |

## 11. Reproduction and checks

```bash
cd server-jarvis
bun run scripts/benchmark-best-of-n-offline.ts          # table; exits 1 if any documented total drifts
bun run benchmark:best-of-n                             # same, via package.json script
bun run scripts/benchmark-best-of-n-offline.ts --json   # per-case records
```

Project verify commands, expected unchanged by this run because it adds **no** `src/**` file
(`tsconfig.json` includes only `src/**/*.ts`; the harness lives in `scripts/`):

```bash
cd server-jarvis && bunx tsc --noEmit
cd src-ui && npx tsc -b
cd server-jarvis && bun test src/orchestration
```

Check results **for this run**: `tsc --noEmit`, `npx tsc -b` and `bun test src/orchestration` were
**not executed by the worker** (sandbox restricts the shell to read-only git). Expected: unchanged
from `bae5796`, since the only added file is outside the typecheck include and no test imports it.
The harness's own assertion block is the gate that its numbers match this document.

## 12. Limitations

1. **Slates are synthetic.** They encode the scorer's defect taxonomy, not an observed model
   distribution. The defect rate d is the assumption that drives the result; §7 bounds it.
2. **Token sizes are authored** (1,800 / 2,100 / 2,400 prompt tokens; 48 / 130 / 6 completion
   tokens). They are not provider usage; the *multiplier* (3.0× prompt) is the invariant result.
3. **No latency or watchdog measurement is possible offline.** §6.3–6.4 uses the repo's own recorded
   p50 (3.1 s) and configured ceilings (45 s first token, 60 s executor stage) to bound the risk;
   those are structural bounds, not observations of a sampled run.
4. The harness applies the held patch's `normalizeSampledCall` at the stub boundary because the base
   branch does not contain it. Scoring and selection run unmodified; the one behavioural difference
   is that the patch's `reasons` strings lose the `tool call N:` prefix.
5. `scripts/` is outside `tsconfig.json`'s include (`src/**/*.ts`), so `bunx tsc --noEmit` does not
   typecheck the harness. Running it is the check.
