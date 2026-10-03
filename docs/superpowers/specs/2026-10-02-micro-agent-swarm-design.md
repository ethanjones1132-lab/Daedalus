# Micro-Agent Swarm on 8 GB: Design and Experiment Plan

- **Date:** 2026-10-02
- **Revision:** 2
- **Status:** proposal. Nothing new in this document has been built or measured yet.

**The brief:** "A swarm of specialized micro-agents, driven by Jev and Laya, with swappable adapter heads, that one-shots coding tasks or benchmarks at frontier level: at least on par with Qwen 3.8 27B." It runs locally on an RTX 4060 (8 GB VRAM, ~7 GB usable), 16 GB RAM, Windows 11 + WSL.

**Revision history**

- **r1:** independent design from first principles and outside research. No project plans or results were read.
- **r2 (this one):** folds in four things:
  - a comparison with the project's current direction (`2026-10-02-line-edits-fastloop-design.md`);
  - configurations already proven on this machine (the Gemma 26B-A4B serving script) and owner-reported results;
  - a new MoE brain (Qwen3.6-35B-A3B);
  - a diagnosis of why training and adapter heads have not paid off, and a much larger role for Jev and Laya.

**How numbers are tagged**

| Tag | Meaning |
|---|---|
| [measured: source] | Measured and published by someone; source in section 18 |
| [project evidence] | Measured by this project; quoted from the line-edits spec or the Gemma serving script |
| [owner-reported] | Stated by the project owner; not re-checked here |
| [on disk] | Read from this machine |
| [estimate] | My own arithmetic or judgment; must be confirmed by experiments |

---

## Contents

1. Summary
2. How this document was produced
3. Starting facts
4. Where the project stands, and what changes
5. Restating the target
6. Core principles
7. The model ladder
8. Part 1: Crucible, test-driven repair (Tier A and Tier B)
9. Part 2: long agent jobs on 8 GB (Tier C)
10. The decision plane: Jev and Laya do every pick
11. Training: why it hasn't paid off, and the fixed recipe
12. Hardware budgets
13. Why this can reach the target, and the maximum capability
14. Designs considered, rejected and reversed
15. Experiments
16. Risks
17. Open questions
18. Sources
19. Glossary

---

## 1. Summary

### The project's position today

The project's own measurements say the patch station — the stage that writes the fix — reads zero:

- **0 of 32 tasks** for Qwen 7B, Granite 3B and Qwen 1.5B, even with the right file and a window around the answer handed to them;
- **0.4–0.9% acceptance per attempt**;
- more attempts bought one extra task for four times the cost.

All [project evidence].

**What is broken:**
- The output format. Free SEARCH/REPLACE makes small models copy long text exactly, and they fail at it.
- Training. It has not paid off.

**What already works on this machine:**
- A Gemma 26B-A4B mixture-of-experts configuration runs at **39.1 tokens/s in 6,092 MiB of VRAM** and scores **105/117** on the forge's tier2b suite [project evidence].
- A locally installed DeepSeek fine-tune of Qwen (`deepseek-v4-pro-9b`) was the best model before Gemma [owner-reported].

Neither model is in the current patch-station plan.

### Five moves

1. **Fix the output, then climb the ladder.** Adopt the project's line-numbered edit format and fast inner loop. Add the models already proven here — the 9B and the Gemma MoE — plus a new MoE as rungs above the small heads. Those rungs should be above zero.
2. **The best brain per GB of VRAM is a sparse mixture-of-experts.** Keep attention on the GPU, keep the experts in RAM, and draft with MTP.
   - Gemma 26B-A4B proved the method.
   - **Qwen3.6-35B-A3B** is the next pick: 3B active parameters, SWE-bench Verified 73.4, SWE-bench Pro 49.5, LiveCodeBench v6 80.4 [measured: Qwen card].
   - It replaces the dense 27B as the main brain. The dense 27B stays as a rare expert.
3. **Anything that is a pick from a list goes to Jev or Laya.** Models only write text that cannot be picked. Laya picks the edit location, the fix pattern, the context to show, and the model rung. Jev answers wide, rare and last-resort questions.
4. **Train differently.** The likely causes of no payoff are a train/serve mismatch, copy-heavy targets, hard-to-imitate labels, too little data, one head doing too much, possible pipeline bugs, and the wrong yardstick. Each has a cheap check, and the fixes form one recipe (section 11). The headline change: train small heads on **teacher labels** — fixes written by the MoE and proven correct by tests — instead of raw commit diffs.
5. **Long jobs (Tier C):** the MoE brain drives short-memory steps; every step has a check; risky steps fork and rewind; the 27B is called rarely.

**The principle behind all five: trade time for size, and never spend a model on a decision a list-pick can make.**

### What decides the project in the first week

| Experiment | Question | Go | Kill / redirect |
|---|---|---|---|
| X1 | Do the 9B, Gemma and Qwen3.6 beat 0 on the 32 location-given tasks? | Any model ≥5/32 → model size is a lever | All 0 in both formats → audit the task setup before anything else |
| X2 | Can the training pipeline memorise 20 examples? | ≥95% reproduced in HF and served | Below → pipeline bug; fix before any more training |
| X3 | Does Qwen3.6-35B-A3B serve fast enough here? | ≥25 tok/s and ≥ Gemma's tier2b score | Below → Gemma stays the brain |

---

## 2. How this document was produced

**r1 (independent):**
- Read: source code only — `jev-swarm/runtime/types.ts`, `pipeline.ts`, `ladder-types.ts`, `ladder-oracle.ts`, `providers.ts` — plus directory listings and GGUF file sizes.
- Not opened: `PLAN.md`, `prompts/`, `evidence/`, `logs/`, eval results, `docs/`.
- Disclosure: my session loaded a memory index with one-line titles of earlier project findings; I did not use them.

**r2, at the owner's direction, I also read:**
- `jev-swarm/.claude/worktrees/line-edits-fastloop/docs/superpowers/specs/2026-10-02-line-edits-fastloop-design.md` — the project's current direction;
- `D:\qwen3-forge\scripts\serve-gemma4-26b.ps1` — the proven Gemma serving configuration and its measurements.

**Not read:** documents the line-edits spec cites (`assembly-line-v0.md`, `GATE-VERDICT.md`, `AMENDMENT-*.md`, `PROTOCOL-v4.md`, results files). Numbers from them are quoted as that spec states them.

**Owner-reported and not re-checked:**
- `deepseek-v4-pro-9b` was the best local model before the Gemma MoE.
- Training and fine-tuning are known to give substantial improvement in general, even though this project has not yet seen a large payoff.

**Corrections from r1:**
- The 9B cannot be the dense 27B's speculative-decoding draft. Both cannot fit in VRAM together.
- Free search/replace output "as a diversity axis" is replaced by the project's line-numbered format. The project's evidence shows free-text copying is the main failure for small models.
- Per-repo adapters were rejected in r1. They are now proposed (section 11.6), because the project measured large in-repo gains.
- The dense 27B as the main long-job brain is replaced by the Qwen3.6 MoE.

---

## 3. Starting facts

### 3.1 The target model

**Qwen3.8-27B** [measured: Qwen card]:
- Dense 27B, Apache-2.0.
- 64 layers: 48 Gated DeltaNet (linear attention) and 16 full attention (24 query heads, 4 KV heads, dim 256).
- FFN 17,408; vocabulary 248,320; trained with multi-step MTP; 262K context.
- Published: Terminal-Bench 2.1 (Terminus) **73.0**; SWE-bench Pro **61.7**; NL2Repo 42.3; DeepSWE 1.1 42.2; QwenSWEBench 79.0.
- LiveCodeBench v6 **90.3** [measured: Qubrid summary of official results].

### 3.2 Local and candidate models

| Model | Key facts | Tag |
|---|---|---|
| **Gemma-4-26B-A4B IQ2_M + MTP** | 10.2 GB file + 441 MB MTP file. See the measured table below. | [on disk] / [project evidence] |
| **deepseek-v4-pro-9b** | Fine-tune of Qwen (the brief calls it a rebranded Qwen3.5-9B). Best local model before the Gemma MoE. | [owner-reported] |
| **Qwen3.6-35B-A3B** (Apache-2.0, April 2026) | 35B total, **3B active**. 40 layers, hidden 2048; layout 10 × (3 DeltaNet→MoE, 1 attention→MoE); 256 experts, 8 routed + 1 shared; MTP; 262K context. SWE-bench Verified **73.4**, SWE-bench Multilingual 67.2, SWE-bench Pro **49.5**, Terminal-Bench 2.0 **51.5**, LiveCodeBench v6 **80.4**, NL2Repo 29.4. | [measured: Qwen card] |
| Qwen3.5-35B-A3B | The predecessor: SWE-bench Verified 70.0, SWE-bench Pro 44.6, Terminal-Bench 2.0 40.5, LiveCodeBench v6 74.6 | [measured: Qwen3.6 card's comparison column] |
| Qwen-AgentWorld-35B-A3B | Environment simulator ("world model") built on Qwen3.5-35B-A3B-Base, June 2026. A candidate for predicting command outcomes in long jobs. | [measured: HF listing] |
| Qwen3.5-9B | 32 layers (24 DeltaNet + 8 attention); LiveCodeBench v6 65.6; BFCL-V4 66.1; TAU2 79.1 | [measured: Qwen card] |
| Qwen3.8-9B-Distill (Empero) | Community full fine-tune of Qwen3.5-9B on ~70k traces; reports only GSM8K and MMLU; safetensors on disk | [measured: Empero card] / [on disk] |
| Qwen2.5-Coder 0.5B / 1.5B / 3B / 7B | 0.5B and 1.5B are the project's trainable small rungs | brief / [project evidence] |
| Granite 4.1 3B / 8B | Granite 3B is a trainable small rung | brief / [project evidence] |
| FunctionGemma 270M + one LoRA | A 270M model with a tiny typed output under a grammar beat the parser by +48 points | [project evidence] |
| Qwen3.8-27B UD-IQ2_XXS / IQ1_M / IQ1_S | 6.9 / 6.4 / 5.9 GB | [on disk] |

**Gemma 26B-A4B serving measurements** (RTX 4060, 2026-09-10) [project evidence]:

| Setting | Speed |
|---|---|
| All experts on CPU (Ollama-equivalent) | 22.9 tok/s |
| `--n-cpu-moe 20` | 33.3 tok/s |
| `--n-cpu-moe 20` + MTP draft depth 2 | **39.1 tok/s** (1.71× over all-CPU) |
| MTP draft depth 3 / 4 | Worse (27.2 and 23.0) |

- **Profiles:** Fast = 16k context, 39.1 tok/s, 6,092 MiB. LongCtx = `--n-cpu-moe 22`, 64k context, 33.8 tok/s, 6,449 MiB.
- **Thinking budget, 5 hard tier2b tasks:** off 0/15; 512 tokens 6/15; 1,536 tokens **8/15**; unbounded 5/15 (and only 10 of 15 answered).
- **Full 39-task tier2b suite:** 96/117 with thinking off; **105/117** at a 1,536-token budget.
- **Lesson:** a bounded thinking budget beats both no thinking and unbounded thinking.

### 3.3 The decision plane

**Jev** (TypeSafe System One, hosted):
- State plus typed questions in; typed answers with probabilities out.
- Question types: `choice` (one of a set), `score` (position on ordered levels), `noul` (probability that a condition holds).
- Confidence is not probability. Thresholds must come from your own data [measured: TypeSafe docs].

**Laya** (`convaiinnovations/laya`, 421M, Apache-2.0) [measured: Laya card]:
- ModernBERT-large backbone plus a decision head (2 transformer layers, option-marker scorer, act/escalate module). Answers in one forward pass.
- Context: 512 tokens (English checkpoint), 1,024 (typed-decisions checkpoint), up to 8,192 with `max_len`.
- Speed: 32.8 ms p50 vs 236–276 ms for Jev. On CPU, 193–464 ms. An ONNX build exists.
- Accuracy on typed decisions: 0.766 for the typed-decisions checkpoint vs 0.727 for Jev 1.13.0.
- **Weaknesses:**
  - zero-shot base checkpoints score 0.362, below the 0.461 majority baseline;
  - Jev is far better on wide choices (Banking77: 0.870 vs 0.425);
  - probabilities need temperature calibration;
  - `noul` can follow option labels instead of state content;
  - `score` is the weakest primitive.
- Fine-tuning recipe: RLCD (a proper scoring rule).
- In this project, Laya's L1N missed its gate by 0.3 points [project evidence].

### 3.4 Hardware basics

- **GPU:** RTX 4060, 8 GB, ~272 GB/s, PCIe 4.0 x8 (NVIDIA spec, from memory — verify).
- **RAM:** 16 GB, typically ~40–60 GB/s in practice [estimate].
- **Decode speed** ≈ bandwidth ÷ bytes of weights read per token. That is why MoE models (few active parameters per token) fit this machine so well: only the active experts are read each token, so most of the model can sit in slower RAM.
- **Project VRAM rule:** footprint must stay inside **7,168 MiB including Laya**, measured as one nvidia-smi delta (`AMENDMENT-2.md` §1, per the line-edits spec).

### 3.5 What the existing code already does

From `jev-swarm/runtime/ladder-*.ts` [on disk]:
- Tasks revert a real commit's code half. The commit's tests grade; its diff is the reference.
- `gradePatch` accepts only when every fail-to-pass test is green and no previously green test turns non-green.
  - It rejects patches that edit test files.
  - A missing report counts as a failed run.
- Pipeline seams: L1 provider, L2 emitter, L3 sandbox. Tool packs for rg, pytest, cargo, npm, tsc, clippy, ruff, mypy. Paired-statistics scripts.

### 3.6 Project evidence that shapes this revision

From the line-edits spec [project evidence]:
- **The patch station reads zero with the answer's location handed over:** 0/32 for Qwen 7B, Granite 3B and Qwen 1.5B.
- **Workarounds didn't move it:**
  - more attempts bought one task for 4× the attempts;
  - the repair experiment read 8 vs 7 (p = 1.000);
  - k-shot v3 read 1/78;
  - per-attempt acceptance is 0.4–0.9%.
- **Pass/fail can't show progress at this floor.** At 0–8 accepts of 78, McNemar needs at least 6 discordant pairs all in one direction to reach p < 0.05.
- **Output failures:**
  - most apply failures are "far": the SEARCH text isn't in the file;
  - 10–19% of attempts hit the 4,096-token cap;
  - 8–16% are no-ops;
  - the trained head reproduces 0 of 86 training labels longer than 500 characters.
- **The one banked win** is a 270M model with a tiny typed output under a grammar: +48 points over the parser.
- **Leave-one-repo-out:** training on a repo is worth +23.5 / +36.4 points on that repo; transfer to an unseen repo was not detected.
- **Three different context windows** were in use: gold-anchored for patch evaluation, gold-free for training, search hits for serving.

---

## 4. Where the project stands, and what changes

### 4.1 The current direction: line edits and a fast loop

The line-edits spec:
- replaces free SEARCH/REPLACE with **line-numbered ops** (`REPLACE a-b`, `INSERT_AFTER n`, `DELETE a-b`, 1–6 ops) under a **per-task grammar**. The grammar pins the file and allows only line numbers that were shown, so the model cannot address a line it didn't see;
- uses **one window rule** for labels, training, fast-loop prompts and serving;
- adds a deterministic bottom-up applier with reason codes, and a gold-to-label converter with a byte-exact round-trip test;
- measures progress with a **fast teacher-forced loop** on an unseen repo F:
  - **header exact** — every line-number and op token is right;
  - **body NLL per token**;
  - **answer-token accuracy** —

  all with paired bootstrap CIs, a ledger, and a ≤15 min per-arm target;
- keeps the reserved sets unchanged and uses tiers T1/T2/T3/unreachable by fix size;
- trains the 0.5B, 1.5B and Granite 3B bases (Qwen 7B nf4 is an untrained reference) and keeps the smallest base within its CI of the best;
- **parks** Laya routing, more attempts and repair turns, the synthetic generator, bigger-model training and locate improvements, each with a return condition.

### 4.2 Comparison

| | Line-edits spec | This design (r2) |
|---|---|---|
| Immediate goal | Get the patch station off zero | Same, then climb to 27B parity, including long jobs |
| Edit format | Line-numbered ops, per-task grammar | **Adopted** |
| Window rule | One rule everywhere | **Adopted** |
| Fast loop and ledger | Teacher-forced metrics, paired CIs | **Adopted**, with more arms (section 15) |
| Models | 0.5B, 1.5B, Granite 3B trained; smallest that ties | A **ladder**: template menu → small heads → 9B → MoE brain → 27B rare expert, routed by Laya |
| Labels | Gold commit diffs converted to line ops | Gold **and** teacher labels (MoE-written, test-verified, minimal) as competing arms |
| Data | Synthetic generator parked until M1 shows data binds | Unpark early; the transfer evidence already points at data |
| Laya / Jev | Parked until a second head needs routing | Central now: location picker, fix-pattern menu, context shrinker, router, data cleaner, last-resort diagnosis |
| More attempts / repair | Parked until per-attempt rate is off the floor | **Agree** — same return condition |
| Per-repo gains | Treated as memorisation to avoid in evaluation | Agree for evaluation, **and** use it as a feature: per-repo adapters trained on a repo's own past commits |
| Long jobs (Tier C) | Not addressed | Separate track (section 9) |
| Governance | Reserved sets, registration, ledger | **Adopted unchanged** |

### 4.3 Where we disagree, and why

1. **"Smallest base that ties."** That rule optimises footprint. If the floor is partly a capability floor — and the proven 9B and Gemma suggest bigger models clear it — then the smallest base caps the system. Keep the small heads, but as the cheap rung of a ladder, not the only rung.
2. **Parking Laya.** Several jobs here are pure list-picks: the location (exactly what "header exact" measures), the fix pattern, the context spans. That is Laya's native shape, and the banked +48-point result was exactly that shape: a tiny typed output under a grammar. Parking Laya leaves the project's one proven pattern unused.
3. **Parking data work.** No transfer to unseen repos, alongside large in-repo gains, is the classic sign of too little and too narrow data. The step-M1 count will confirm it; I would start the teacher-label and synthetic pipelines in parallel rather than after.

---

## 5. Restating the target

### 5.1 One-shot

"One-shot" means **one submitted answer and no human in the loop.** Internal search judged by tests is allowed.

### 5.2 Tiers

| Tier | What | Oracle | Target |
|---|---|---|---|
| A | Test-specified repair (the project's task format) | Very strong (the given failing test) | Parity with the 27B |
| B | Issue-specified repair, hidden tests (SWE-bench Verified style) | Built from self-written repro tests | Close most of the gap; the Qwen3.6 MoE alone is published at 73.4 on SWE-bench Verified |
| C | Long agent jobs: SWE-bench Pro, Terminal-Bench | Weak unless built per step | Research bet: from the MoE's 49.5 SWE-bench Pro toward the 27B's 61.7 |
| Side check | LiveCodeBench with public examples | Weak | MoE 80.4 vs 27B 90.3 |

### 5.3 Matched-protocol comparison

- Same tasks and same harness for both systems. The 27B baseline runs in the cloud (full precision). Its score is the better of (a) the same pipeline with one sample and (b) its native agent mode.
- The local budget is declared in advance.
- Tier C reports a score within official timeouts **and** an unlimited-time score.
- Paired McNemar plus a pre-registered non-inferiority margin.

### 5.4 Hygiene: the project's sets, unchanged

| Set | Contents | Rule |
|---|---|---|
| H | click (54 tasks) | Held-out train repo; read only per `AMENDMENT-4.md` §3 |
| Dev pool | pyparsing (64) | Read once after protocol and recipe are frozen; opens the gate only at ≥0.35 |
| Gate | httpx, boltons, sqlparse | Read once at the end; no repo below 0.35 |
| T-cal | 40 ids | Never trained on |
| F | One drawn T repo (from arrow, attrs, jsonschema, packaging) + celery | Fast-loop set; unseen by training |

Additions:
- **Freshness split:** report results on commits newer than the Qwen3.6/3.8 releases. Popular repos are likely memorised.
- **Hidden-test split:** when a task has two or more fail-to-pass tests, withhold one for grading only.
- **Power:** expand evaluation sets with the generator on more commits of the same reserved repos (respecting their read-once rules).

---

## 6. Core principles

1. **Execution decides correctness. Models and the decision plane decide where compute goes.** Nothing overrules a test result.
2. **Anything that is a pick from a list goes to Jev or Laya.** Models only write text that cannot be picked. Every pick removed from a generator shrinks the generator's job below its size threshold.
3. **Fix the floor before scaling attempts.** More attempts multiply a per-attempt rate; a rate near zero stays near zero.
4. **Measure what moves before pass/fail moves.** Fast teacher-forced metrics for search; pass/fail for confirmation.
5. **Trade time for size.** Use the best brain that fits in VRAM plus RAM (MoE first), and call it only when the cheaper rungs fail.
6. **No prose between agents.** Every handoff is a typed artefact: line range, op list, test result, probability, check command.
7. **Make every step checkable, and make mistakes cheap** (checks, snapshots, rewind).
8. **Train on what serving will actually see.** Same window, same upstream errors, same format.
9. **Every run is data, but only execution-verified results become labels.**

---

## 7. The model ladder

Each rung costs more and can do more. Laya's router (section 10, R1) sends each job to the cheapest rung likely to solve it, and escalates on failure.

| Rung | What | Speed / cost | Job size it handles | Trainable here? |
|---|---|---|---|---|
| 0 | **Fix-pattern menu**: code templates, Laya picks the pattern and its parameters | Milliseconds, CPU | Tiny one-op fixes (T1) | Laya only |
| 1 | **Small heads**: 0.5B / 1.5B / Granite 3B + LoRA, line-op grammar | Fast | Small, well-localised fixes once shrunk | Yes (the project's current rungs) |
| 2 | **9B**: `deepseek-v4-pro-9b` (previous best) or a Qwen3.5-9B variant | ~30–40 tok/s [estimate] | Medium fixes | Yes, with care (QLoRA; DeltaNet kernels needed) |
| 3 | **MoE brain**: Gemma 26B-A4B (39.1 tok/s measured), or Qwen3.6-35B-A3B (~30–45 tok/s [estimate]) | Swap-in; bounded thinking budget | Large, multi-op, cross-file fixes; plans for long jobs | No (too big to fine-tune here); frozen |
| 4 | **27B dense**, split across GPU and RAM | ~12–20 tok/s with speculative decoding [estimate]; slow swap | Rare expert hints | No; frozen |

**Swap costs:** only one of rungs 2–4 can be resident at a time. Loading takes roughly 10–30 s each way [estimate]. Save slot state on swap so no prompt is re-read. Measure in X3/C0.

**Rung 3 is also the teacher.** Its test-verified fixes become training labels for rungs 1–2 (section 11.4).

---

## 8. Part 1: Crucible, test-driven repair (Tier A and Tier B)

### 8.1 Shape

```
 task: repo snapshot + failing test ids
        │
   Reproducer ── pytest + per-test coverage (sandbox, CPU)
        │
   Analyzers (no model): traceback frames · missing-symbol resolver · SBFL · imports · rg
        │  candidate regions
   Laya L1: shrink context (keep only needed spans)                ─┐
   Laya L2: pick location (function → block → line range)           │ decision plane
   Laya R1: route to rung (0 menu | 1 small head | 2 9B | 3 MoE)   ─┘
        │
   Rung writes line ops under the per-task grammar (shown line numbers only)
        │
   applyLineEdits (deterministic; reason codes) → gatekeepers
        │
   Oracle: failing tests → affected passing tests → full suite          (CPU)
        │
   green? ─yes─▶ hack check ─▶ selector ─▶ ONE patch
     │no
   Laya R2: escalate rung | retry with new location | (off floor only: repair, more attempts)
     │all rungs exhausted
   Jev D1–D4: diagnose failure → structured hint → final try on top rung
        │
   Ledger ─▶ nightly training (heads, Laya) + teacher labels
```

### 8.2 The cast

| Micro-agent | Job | Implementation | Runs on |
|---|---|---|---|
| Reproducer | Run fail-to-pass and affected pass-to-pass tests; traceback; per-test coverage; abort on a broken environment | pytest pack + coverage | CPU, L3 sandbox |
| Analyzers (no model) | Repo frames from the traceback; missing-symbol resolver; SBFL (Ochiai); modules the test imports; rg on assertion identifiers | Code | CPU |
| Context shrinker | Keep only the spans the fix needs | Laya L1 (`noul` per span) | CPU |
| Location picker | Function → block → exact line range | Laya L2 (hierarchical `choice`); Jev for wide lists | CPU / cloud |
| Router | Cheapest rung likely to solve this | Laya R1 (`score` per rung) + cost table | CPU |
| Fix-pattern menu (rung 0) | Instantiate a template at the picked location | Code + Laya P1/P2 | CPU |
| Writers (rungs 1–3) | Write line-op bodies (and headers when Laya didn't pick) | Small heads / 9B / MoE, per-task grammar | GPU |
| Applier | Bottom-up, deterministic; rejects overlaps, out-of-order ops, no-ops | `applyLineEdits` (line-edits spec) | CPU |
| Gatekeepers | Parses? touches a test file? duplicate? | Code | CPU |
| Hack judge | Does a passing patch special-case the test? | Rules + Laya V2; Jev audits | CPU / cloud |
| Selector | One patch among passing candidates | Full suite → behaviour clusters → smallest diff | CPU |
| Diagnostician | When all rungs fail: typed questions about the failure → hint | Jev D1–D4 | Cloud |
| Ledger | Every state, question, answer, candidate, outcome | SQLite (Jarvis self-tuning DB) | — |

### 8.3 One Tier A task, end to end

1. **Reproduce.** Confirm the task is red for the right reason.
2. **Analyze.** Build candidate regions: traceback frames, missing symbols, SBFL ranks, imported modules.
3. **Shrink (Laya L1).** Drop spans the fix does not need, so the window stays under the chosen rung's size threshold.
4. **Locate (Laya L2).** Pick function, then block, then line range. The picked range becomes a *fixed header*: the writer only fills in the body. This removes the "where" half of the job from the generator.
5. **Route (Laya R1).** Pick the cheapest rung with a good enough chance:
   - rung 0 if a fix pattern fits (P1 confident);
   - otherwise the small head, 9B or MoE, by predicted size and difficulty.
6. **Write.** One greedy attempt per rung at first. Bounded thinking (1,536 tokens) on rung 3, the setting proven best for Gemma.
7. **Apply, gate, test.** `applyLineEdits`, then failing tests, then affected passing tests, then the full suite.
8. **If green:** hack check (V2), then select.
9. **If not green (Laya R2):**
   1. escalate one rung, or re-pick the location (L2's second choice);
   2. once a rung's per-attempt rate is measured off the floor: repair turns and extra attempts for that rung only (the line-edits spec's return condition).
10. **All rungs exhausted:** Jev diagnosis (D1–D4) turns the failure into a structured hint for one final attempt on the top rung. Then stop and log.

### 8.4 Tier B additions (issue text, hidden tests)

1. The repro-writer (rung 2 or 3) proposes K candidate failing tests from the issue.
2. Laya V3 keeps those that fail now for a reason involving the issue's symbols.
3. The survivors become the visible oracle.
4. Selection leans on cross-repro agreement, Laya V1/V2, and Jev. Self-written tests are a weaker judge. Large Language Monkeys measured that voting and reward models plateau as selectors.

### 8.5 Edit format

- **Adopted from the line-edits spec:** line-numbered ops with a per-task grammar. This removes invented SEARCH text, truncation from copying, and silent no-ops by construction. What it adds is off-by-one risk, which "header exact" measures directly.
- **New:** when Laya L2 picks the range, the header is **forced** by the grammar. The writer cannot get the location wrong, and the fast loop can separate "where" errors (Laya's) from "what" errors (the writer's).
- **For rung 3 (MoE):** test both line ops and whole-function rewrite. Diffs vs. Whole Files measured that direct generation beats diffs except on short, localised edits — but that was on 100M and 0.5B models [measured]. A strong model may prefer either. Let the fast loop and confirmation decide.

### 8.6 Selection

- **Tier A:** a candidate that turns the failing tests green, passes the full suite and passes the hack check is very likely correct. The hidden-test split measures how likely.
- **Several passing candidates:** prefer the largest behaviour cluster, then the smallest diff.
- **Tier B and LiveCodeBench:** generate inputs that distinguish candidates and compare their outputs (S*). S* measured a 3B model beating GPT-4o-mini, and R1-Distill-32B reaching 85.7% on LiveCodeBench.

---

## 9. Part 2: long agent jobs on 8 GB (Tier C)

### 9.1 Why small models fail long jobs

Usually not a lack of raw brains per step. They fail because they:
- **lose track** — the context fills with junk (context rot);
- **loop** — they repeat the same failed move;
- **can't recover** — one bad step poisons the run;
- **don't know when they're done.**

These are system problems, and architecture can fix them. Seven ways follow; they combine.

### 9.2 Way 1: the MoE brain, with the 27B as a rare expert

**Main brain: Qwen3.6-35B-A3B** (or Gemma 26B-A4B, which is already proven):
- Published at SWE-bench Pro 49.5 and Terminal-Bench 2.0 51.5 [measured: Qwen card]. That is the starting point for long jobs.
- **Serve it the way Gemma is served** [method: project evidence]:
  - keep attention and DeltaNet layers on the GPU;
  - send the expert layers past a certain depth to the CPU with `--n-cpu-moe`;
  - draft with the built-in MTP head at depth 2;
  - sweep placement for the context length needed.
- **Size:** IQ2_M ~11–12 GB, IQ3_XXS ~13–14 GB [estimate]. A mixed quant (higher bits for attention, DeltaNet, embeddings and output; lower bits for experts) is worth testing. My inference: MoE experts tolerate low bits better than dense layers, because each expert is used on only a fraction of tokens.
- **Speed:** only 3B parameters are active per token, fewer than Gemma's ~4B. So I expect ~30–45 tok/s, similar to Gemma's measured 39.1 [estimate].
- **Turn cost:** prefill of a 2k-token turn delta ~3–6 s, plus a 200-token action at ~35 tok/s ≈ 6 s. That is ~10–15 s per turn, and ~10–15 min for a 60-turn task [estimate]. Thinking at planning steps only, with a bounded budget (Gemma: 1,536 was best).
- **Context:** only 10 of 40 layers keep a growing KV cache; the DeltaNet state is fixed size. Long contexts are cheap — Gemma held 33.8 tok/s at 64k in its LongCtx profile.

**Rare expert: the dense Qwen3.8-27B, split across GPU and RAM** [all estimates]:
- Text-only Q3-class GGUF, ~13 GB: ~6 GB on the GPU, ~7 GB in RAM.
- Decode: ~5–8 tok/s without speculation, ~12–20 tok/s with MTP or n-gram drafting.
- Drafts must fit beside the 27B's GPU share: its own MTP head, n-gram lookup, or a sub-1B model with the same vocabulary. The 9B does not fit.
- Prefill relies on llama.cpp's op offload (streaming RAM-held weights to the GPU for big batches). Verify on the CUDA and Vulkan builds.
- **Use it only for short hints when the MoE is stuck.** Its published SWE-bench Pro is 61.7 vs the MoE's 49.5. That 12-point gap is what rare 27B calls are for.

### 9.3 Way 2: short-memory steps

Code — not the model — keeps the world state. Each step, the driver sees a fresh **situation report** of 2–4k tokens. It never sees the full transcript.

```
GOAL:            task statement, verbatim (≤300 tokens)
PLAN:            subgoal tree: done (check passed) | active | blocked | todo
ACTIVE SUBGOAL:  text + check command + last check result
FACTS:           verified observations with source (command + line); capped
WORKING SET:     relevant file spans (path:lines), chosen by Laya L1
TRIED & FAILED:  last K failed actions for this subgoal, one-line reason each
LAST ACTION:     command or edit + trimmed result (head, tail, Laya C3-selected lines)
BUDGET:          turns used/left, time used/left
```

- **Actions:** the driver answers with one grammar-constrained action: `run`, `edit` (line ops), `read`, `add_fact`, `propose_subgoal`, `mark_done` or `ask_expert`.
- **Observation trimming (Laya C3):** split long output into chunks; Laya picks the ones that matter; keep those plus head and tail. Nothing is summarised in free text, so nothing can be invented.
- **Loop detector:** hash each normalised action with the active subgoal. On a repeat:
  1. mark the action failed;
  2. add it to TRIED & FAILED;
  3. force a branch (Way 4) or an expert call (Way 5).

### 9.4 Way 3: a check for every step

- Every subgoal carries a **check**: a command that proves it is done.
- Validate each check:
  1. run it before the work — it must fail now;
  2. Laya/Jev C4 — "would this check pass only if the subgoal were truly achieved?";
  3. Laya/Jev C5 — "could it be satisfied trivially?"
- Final acceptance checks are written from the task statement. Given tests are never edited.
- **Done** = all checks green **and** C6 agrees.
- **Why it matters:** inside each subgoal, the driver retries until the check passes. Tier C becomes a chain of Tier A problems.

### 9.5 Way 4: fork and rewind

**Sandbox snapshots, cheapest first:**
1. git commit of the working directory;
2. a copy of the overlay filesystem's upper directory;
3. `docker commit` (filesystem only);
4. CRIU (processes; fragile).

Laya picks the level: "does this task depend on running processes?"

**Model-side snapshots:** llama-server slot save/restore for the cache and recurrent state. Verify it works for the hybrid architectures.

**Branching:**
- When: on Laya C2 (risky step) — destructive commands, low-confidence choices, the first attempt at a hard subgoal.
- How wide: 2–3 branches.
- Keep the branch whose check passes; break ties with Laya C7 (state value).

**Optional experimental arm:** Qwen-AgentWorld-35B-A3B as a simulator that predicts a risky command's outcome before running it.

### 9.6 Way 5: rare expert calls (Hands mode)

- **Brain mode:** the MoE drives.
- **Hands mode:** the 9B drives with the `step` head and calls the MoE on Laya C1 (stuck), or calls the 27B when the MoE is also stuck.
- **Each expert call:** save slot state → swap model → feed the short situation report → get a hint of 300 tokens or less → swap back.
- **Evidence:** SWE-Protégé took a 7B to 42.4% on SWE-bench Verified with ~4 expert calls per task (11% of tokens) [measured].
- **Relay supports it:** the Collaboration Gap paper found that a stronger agent leading and then handing off closes much of the gap [measured, on maze tasks].

### 9.7 Way 6: skill library

- Save procedures that passed their checks — environment setup, dependency install, build–fix loops — as named tools with their checks attached (Voyager precedent, from memory).
- A procedure is promoted only after passing on two or more tasks.
- Fewer steps per task means fewer failures and fewer slow turns.

### 9.8 Way 7: distil the stepping style

1. Successful MoE runs (local, overnight) are rewritten into situation-report steps.
2. Those steps train the 9B's `step` head.
3. A stronger `step` head means fewer expert calls.

The MoE and the 27B cannot be fine-tuned on 8 GB; they stay frozen.

### 9.9 How the pieces fit

```
 task ─▶ planner step (MoE; 27B if stuck)
          │  subgoals, each with a validated check (Way 3)
          ▼
   ┌─▶ situation report (Way 2) ─▶ driver (MoE Brain mode | 9B Hands mode) ─▶ one typed action
   │        │
   │   [Laya C2 risky?] ─yes─▶ snapshot + 2–3 branches (Way 4) ─▶ keep the branch whose check passes
   │        │
   │   sandbox runs ─▶ Laya C3 trims output ─▶ facts / working set updated
   │        │
   │   check green? ─yes─▶ next subgoal (procedure → skill candidate, Way 6)
   │        │no
   │   loop detector / Laya C1 stuck? ─yes─▶ expert call (Way 5) or replan
   └────────┘
          │ all checks green + C6 done
          ▼
       submit ─▶ Ledger ─▶ nightly: Laya, 9B step head, skill library
```

---

## 10. The decision plane: Jev and Laya do every pick

### 10.1 The rule

**If the answer is one of a list the code can enumerate, a generator must not produce it.** Jev or Laya picks it, with a calibrated probability. Generators only write text that cannot be enumerated (fix bodies, new code, commands with free arguments).

Why this matters on 8 GB:
- **Fewer jobs per generator.** Every pick moved off a generator shrinks its job, keeping it under the size threshold where small models still work.
- **Cheap.** Picks cost milliseconds and no VRAM (Laya on CPU).
- **Calibrated.** Picks come with probabilities, so code can route, stop and escalate on evidence.
- **Proven.** The project's one banked win (+48 points) was exactly this shape: a tiny typed output under a grammar.

### 10.2 Division of labour

**Laya:**
- local, high-frequency, inner loop;
- ONNX on CPU (no VRAM), or on GPU only when the 7,168 MiB budget allows;
- fine-tuned on this project's labels.

**Jev:**
- wide choices (more than ~30 options, where it is measured far better);
- rare, high-stakes and last-resort questions;
- audits of Laya;
- labelling training data;
- off the hot path. The system must run offline on Laya alone, degrading only on wide choices.

**Neither overrules execution.**

### 10.3 The questions

**Repair (Tier A/B)**

| ID | Question | Type | Answerer | Free label source |
|---|---|---|---|---|
| L1 | Is this span needed to write the fix? (context shrinker) | noul per span | Laya | Spans containing or referenced by the gold change |
| L2 | Which function → block → line range must change? (location picker) | hierarchical choice, includes "none of these" | Laya; Jev for wide lists | Gold diff hunks (exact line ranges) |
| L3 | Does the fix need new code rather than edits to existing code? | noul | Rules on error class, then Laya | Gold diff (added vs modified) |
| L4 | Does the fix need more than one place? In what order? (task splitter) | noul + choice | Laya | Gold op count and order |
| P1 | Which fix pattern applies here? (~30 patterns + "none") | choice | Laya; Jev if confidence is low | Gold diffs classified by pattern |
| P2 | Which parameter for that pattern (which variable, which type, which constant)? | choice over code-enumerated candidates | Laya | Gold diff |
| R1 | Chance that rung k solves this (route to the cheapest likely rung) | score / noul per rung | Laya | Ledger outcomes per rung |
| R2 | After a failure: escalate, re-locate, or (off floor only) repair? | choice | Rules, then Laya (act/escalate head) | Logged counterfactuals |
| V1 | How promising is this candidate? (order of testing) | score | Laya + logprob features | Execution outcome |
| V2 | Does this passing patch special-case the test? | noul | Rules + Laya; Jev audits ~5% | Synthesised hacks; hidden-test failures |
| V3 | Does this repro test reproduce the issue? (Tier B) | noul | Laya / Jev | Fails before, passes after the gold fix |

**Long jobs (Tier C)**

| ID | Question | Type | Answerer | Free label source |
|---|---|---|---|---|
| C1 | Is the agent stuck? | noul | Laya + loop-detector features | Later outcome |
| C2 | Is this step risky enough to branch? | noul | Rules (destructive commands) + Laya | Branches that would have saved a run |
| C3 | Which output chunks matter for the active subgoal? | noul per chunk | Laya | Chunks later cited in facts or used by successful actions |
| C4 | Does this check really test the subgoal? | noul | Laya; Jev audits | Subgoals whose check passed but the task failed |
| C5 | Can this check be satisfied trivially? | noul | Laya / Jev | Synthesised trivial satisfiers |
| C6 | Is the task done? | noul | Laya; Jev for the final call | Final grader verdict |
| C7 | How promising is this state? (branch choice) | score | Laya | Outcome of runs through that state |

**Data and last resort**

| ID | Question | Type | Answerer | Use |
|---|---|---|---|---|
| T1 | Does this commit's code diff contain only what the tests need, or is it mixed with refactors or style changes? | noul | Jev (labelling pass), spot-checked | Filter or flag gold labels (section 11.3, cause 3) |
| T2 | Is this teacher-written fix minimal and idiomatic for this repo? | score | Jev / Laya | Rank teacher labels before training |
| D1 | Is the failing assertion about a return value, an exception, a side effect, or output format? | choice | Jev | Structured hint for the last attempt |
| D2 | Which of these variables or values at the failure point is wrong? | choice over code-enumerated values | Jev | Hint |
| D3 | Which branch should have run? | choice over code-enumerated branches | Jev | Hint |
| D4 | Is this task likely unsolvable within the budget? | noul | Jev | Stop rather than burn time |

### 10.4 The fix-pattern menu (rung 0), in detail

1. **Build the catalogue.**
   - Classify every gold diff in the training repos into edit patterns (AST-level edit classes), and keep the ~30 most frequent.
   - Seed list from the template-based program-repair literature (e.g. TBar's fix-pattern families, from memory): add None/empty guard, widen an isinstance or type check, flip or relax a comparison, off-by-one in a range or slice, add a missing import, add or forward a keyword argument, change a default value, add an exception type to a handler, wrap in str()/bytes(), add an early return.
2. **Each pattern is a code transformer** that takes a location plus parameters. Code enumerates the legal parameters at the location: variables in scope, types mentioned in the test, constants nearby.
3. **Laya picks** the pattern (P1) and the parameter (P2).
4. **Code renders the line ops; tests judge.** Try the top 3–5 instantiations in Laya's order; each costs only a test run.
5. **Roles:**
   - first try on T1-sized tasks;
   - last-resort fallback after every generator fails;
   - a source of verified labels for the small heads.

Ranking candidate patches with a learned model is an old idea in program repair (e.g. Prophet, from memory). What's new here is a calibrated, typed decision model as the ranker.

### 10.5 Rules for using the decision plane

1. **Shadow first.** A Laya question replaces a rule only after beating it end to end on non-reserved data.
2. **Calibrate.** Temperature-scale on calibration data; track ECE (expected calibration error); thresholds come from data.
3. **Compact states.** 512–1,024 tokens by default. Use `max_len` up to 8,192 only where it pays. Use hierarchy for wide choices.
4. **Neutral option labels and shuffle tests**, because `noul` can follow labels instead of content.
5. **Every question must pay rent.** It must improve solved-per-GPU-minute (or a fast-loop metric) on F, or it is removed.
6. **Header-exact is Laya's metric too.** L2 is a fast-loop arm: Laya's location pick vs the small heads' own headers.

---

## 11. Training: why it hasn't paid off, and the fixed recipe

### 11.1 Starting position

- **Owner's view:** training and fine-tuning are proven to help in general; small models have a size threshold that training moves considerably; this project has not seen the payoff yet, which suggests the method is wrong.
- **I agree.** The project's own evidence points at method problems, not at training being useless.

### 11.2 The size threshold, made measurable

Define a model's **threshold** as the largest tier (T1 < T2 < T3, by changed lines and ops) where it passes ≥50% — or, in the fast loop, reaches a set header-exact and body-NLL level.

- Measure it per rung, before and after every training change.
- Average pass rate hides threshold moves. The threshold shows them.
- The decision plane's job (L1, L4) is to shrink each job **below** the chosen rung's threshold.

### 11.3 Likely causes, most likely first, each with a check

| # | Cause | Evidence | Cheap check | Fix |
|---|---|---|---|---|
| 1 | **Train/serve mismatch** | Three different windows (gold-anchored eval, gold-free training, search-hit serving) | Diff the exact prompt bytes of a training row vs the served prompt for the same task | One window rule (adopted) |
| 2 | **Copy-heavy targets** | 0/86 labels >500 chars reproduced; 10–19% hit the token cap; "far" apply failures | Share of loss tokens that are copied text | Line ops; Laya-forced headers so the loss covers only the change |
| 3 | **Hard-to-imitate labels** | Commit diffs mix fixes with refactors and style | Jev T1 on a sample of labels: how many are mixed? | Teacher labels (11.4); drop or trim mixed gold labels |
| 4 | **Too little, too narrow data** | +23.5/+36.4 in-repo, no detected transfer | M1 tier counts; learning curve with 25/50/100% of the data | Teacher labels + synthetic tasks across many repos (11.5) |
| 5 | **One head doing too much** | Where + what + format in one stream | Fast-loop header exact vs body NLL separately | Laya does "where"; the head does "what" |
| 6 | **Pipeline bugs** (loss masking, chat template, nf4→GGUF) | The line-edits spec adds "answer-token parity" and a serve-parity step, hinting at past issues | **Overfit test:** train on 20 examples; must reproduce ≥95% in HF **and** in served GGUF | Fix before any more training |
| 7 | **Wrong yardstick** | Pass/fail at 0–8 of 78 can't detect change | — | Fast loop + threshold metric (adopted / 11.2) |
| 8 | **Cascade mismatch** (adapter heads) | Each head trained on perfect upstream inputs, served on real flawed ones | Compare a head on gold-upstream vs real-upstream inputs | Train each head on its predecessor's actual outputs |
| 9 | **Base too small for the job** | 0/32 even with location given | X1: do 9B / MoE clear it? | Ladder (section 7); small heads only for shrunk jobs |

### 11.4 Teacher labels: the main recipe change

1. **The teacher (rung 3 MoE; rung 2 9B as a cheaper second teacher) attempts every training task** in the line-op format, with a bounded thinking budget.
2. **The grader keeps only verified fixes:** fail-to-pass green, no regressions, no test edits, and the hidden-test split where available.
3. **Prefer minimal fixes.** Rank by size and by Jev/Laya T2 (minimal and idiomatic). Keep at most 2 per task.
4. **Train the small heads (and the 9B) on these labels**, with the same window rule and the same grammar as serving.
5. **Compare arms in the fast loop:** gold-label head vs teacher-label head vs both mixed. Paired CIs on F.

**Why it should work:**
- Teacher fixes are on-distribution: model-written, minimal, in the exact output format.
- They are verified by execution.
- This is the recipe behind SWE-Gym and SWE-smith: strong-model trajectories filtered by tests.
- The 0.5–3B heads learn to imitate something they can actually imitate.

**Distillation is permitted:** Qwen3.6-35B-A3B is Apache-2.0. Gemma's licence terms should be checked before using its outputs as training data.

### 11.5 Data scale

- **Unpark the synthetic generator now**, in parallel with step M1 (the tier count):
  - the history generator over more permissive repos (more repos matter more than more commits per repo, given no transfer);
  - **natural bugs, BugPilot-style:** the MoE implements small features; runs that break existing tests become bugs. BugPilot measured +2% with 1.2k such bugs vs 3k from other datasets [measured];
  - feature removal: blank a tested function body;
  - procedural mutations, capped.
- **Every new task passes a keep test on F** before it is admitted, as the line-edits spec requires for the synthetic generator.
- **Curriculum:** keep tasks whose current pass rate is roughly 5–60% for the rung being trained. RLVE measured that static difficulty loses signal (+3.37 vs +0.49 at 3× the compute) [measured].

### 11.6 Per-repo adaptation: turn the transfer finding into a feature

The project measured that training on a repo is worth +23.5 / +36.4 points on that repo.

- **In real use:** before working on repo R, train a small adapter on tasks generated from R's **own earlier commits**. Only commits older than the task, so nothing leaks. Nightly per active repo.
- **Evaluating it:** on F, split by time — older commits for adaptation, newer for evaluation. Register it as a separate arm ("repo-adapted"), so F's unseen-repo protocol stays intact for every other arm.
- This reverses r1's rejection of per-repo heads.

### 11.7 Adapter heads: what to train, and how

| Head | Base | Input → output | Labels |
|---|---|---|---|
| `body` | 0.5B / 1.5B / 3B, later 9B | Window + Laya-forced header → op body | Teacher + gold |
| `ops` | Same | Window → full line ops (header + body) | Teacher + gold (the line-edits spec's head) |
| `repair` | 9B | Failing candidate + test output → revised ops | Pairs from the population (off floor only) |
| `repro` | 9B | Issue text + code → failing test | Repro tests that fail before and pass after gold |
| `step` | 9B | Situation report → one action | Distilled MoE runs |
| repo-R | Any small base | Same as `ops`, R-specific | R's earlier commits |

Rules:
- **Pipeline-aware:** train each head on what serving feeds it. That means real Laya picks (including mistakes) and the real window, not gold.
- **Serve parity before every confirmation:** HF greedy vs served greedy on 20 tasks, as the line-edits spec requires.
- **Load all heads** with `--lora-init-without-apply` and pick per request. Waves are single-role, because llama.cpp does not batch requests with different LoRA configurations.
- **Laya is trained like a head:** full fine-tune (421M fits) on the L/P/R/V/C labels with a proper scoring rule (RLCD), then temperature calibration. Track recall@k, ECE and end-to-end effect.

### 11.8 Rhythm, cost, traps

- **Rhythm:** sampling and teacher labelling by day (llama.cpp), training by night (WSL PEFT). They cannot share 8 GB.
- **Cost [estimate]:**
  - small heads (0.5–3B): minutes to an hour per run;
  - 9B QLoRA at ~100–200 tok/s: ~4–8 h per 3M tokens;
  - Laya: under an hour;
  - teacher labelling at ~35 tok/s with bounded thinking: roughly 200–400 tasks per day, depending on thinking length.
- **Traps:**
  - Qwen3.5/3.6 DeltaNet layers need `flash-linear-attention` + `causal_conv1d` under WSL to train;
  - adapters trained on NF4 are served on Q4_K_M — always evaluate served;
  - confirm llama.cpp's LoRA converter supports each architecture;
  - train only on execution-verified labels; never on self-reported success.

---

## 12. Hardware budgets

All must respect the project's **7,168 MiB including Laya** rule. Running Laya on the CPU (ONNX) keeps every configuration inside it.

### Config S: small heads

- 0.5B–3B + LoRA heads: a few GB.
- Laya can sit on the GPU here if wanted (~0.85 GB at fp16 [estimate]).

### Config 9B

| Item | Size | Tag |
|---|---|---|
| 9B Q4_K_M | 5.5 GB | [on disk] |
| Buffers | ~0.4–0.7 GB | [estimate] |
| KV: 8 attention layers ≈ 17 KB/token at q8; 4 slots × 12k | ~0.8 GB | [estimate] |
| LoRA heads | ~0.1 GB each | [estimate] |

Tight; Laya on CPU.

### Config M: MoE brain

| Model | VRAM | Speed | Tag |
|---|---|---|---|
| Gemma 26B-A4B, Fast profile | 6,092 MiB | 39.1 tok/s at 16k | [project evidence] |
| Gemma 26B-A4B, LongCtx profile | 6,449 MiB | 33.8 tok/s at 64k | [project evidence] |
| Qwen3.6-35B-A3B | Placed to stay ≤ ~6.2 GB | ~30–45 tok/s | [estimate] |

- Qwen3.6 sizes: IQ2_M ~11–12 GB, IQ3_XXS ~13–14 GB; experts beyond `--n-cpu-moe` live in RAM [estimate].
- **RAM:** 5–8 GB of experts + Windows (~3–4 GB) + WSL/Docker sandbox (2–4 GB) ≈ 10–16 GB of 16 GB. Run llama-server and the sandbox inside WSL (one memory pool), and cap the container.

### Config 27B: rare expert

- ~6 GB GPU + ~7 GB RAM, plus an MTP or n-gram draft [estimate].
- Only one of Config 9B / M / 27B is resident at a time. Swaps cost ~10–30 s [estimate].

**Cheapest hardware upgrade:** 16 → 32 GB RAM. Higher-bit MoE quants, a roomier sandbox, and possibly the 9B and the MoE resident together (9B on GPU, MoE experts in RAM). Far cheaper than a new GPU.

---

## 13. Why this can reach the target, and the maximum capability

### 13.1 Accounting

**Tier A/B:** accepted rate = **C × S**.
- C (coverage) is the chance the ladder produces a correct candidate.
- S (selection precision) is the chance the shipped one is correct.
- Goal: C × S ≥ the 27B's one-shot rate.

**Tier C:** solved ≈ (brain quality per decision) × (how few decisions need the brain) × (how cheap recovery is) × (how strong the checks are).

### 13.2 Evidence, measured vs inferred

| Claim | Measured | Inference |
|---|---|---|
| An MoE brain fits this machine at good speed | Gemma 26B-A4B: 39.1 tok/s, 6,092 MiB, 105/117 tier2b [project evidence] | Qwen3.6-35B-A3B (3B active) serves similarly |
| A strong MoE is close to the target on agentic coding | Qwen3.6-35B-A3B: SWE-bench Verified 73.4, Pro 49.5, LiveCodeBench 80.4; the 27B: Pro 61.7, LiveCodeBench 90.3 [measured: Qwen cards] | The remaining gap is ~10–12 points, the size architecture can plausibly close |
| Typed small outputs under a grammar work here | +48 points for the 270M typed head [project evidence] | Laya-picked headers and pattern menus extend the pattern |
| Free-text copying is the small-model failure | "Far" apply failures, cap hits, no-ops, 0/86 long labels [project evidence] | Line ops + forced headers remove it |
| Training on test-verified strong-model outputs works | SWE-Gym, SWE-smith, Kimi-Dev; BugPilot natural bugs [measured] | Teacher labels from the MoE will train the small heads where gold diffs did not |
| Small models jump with sparse expert help | SWE-Protégé: 7B → 42.4% SWE-bench Verified, ~4 expert calls per task [measured] | MoE/27B rare calls do the same locally |
| More attempts help only above the floor | Large Language Monkeys: 15.9% → 56% with 250 samples [measured]; project: 1 task for 4× attempts at the floor [project evidence] | Unpark attempts per rung once its rate is off the floor |
| Chatty multi-agent setups hurt below 10B | Rethinking Scale; Collaboration Gap [measured] | Typed handoffs only |

### 13.3 Maximum capability per tier

**Tier A (failing test given):**
- **With the ladder:** rung 3 (MoE) sets the ceiling. A model published at 73.4 on issue-only SWE-bench Verified should do well when the failing test is handed to it.
- **Parity with the 27B: likely.** The test makes selection nearly free.
- **The small heads' role is cost, not ceiling:** solve the easy majority fast and leave the MoE for the rest.

**Tier B (issue only):**
- Ceiling set by repro-test quality and selection.
- Starting point: the MoE's own published 73.4 (at full precision; expect some quant loss).
- Expect a small gap to the 27B.

**Tier C (long jobs):**
- **Start:** the MoE's published 49.5 (SWE-bench Pro), minus quantisation loss.
- **Target:** the 27B's 61.7.
- **Levers to close ~12 points:** per-step checks, fork and rewind, short memory, rare 27B calls, skills, and Jev/Laya stuck/done/risky judgments.
- **Unlimited-time scores benefit most.** Within official timeouts, the speed of rung 3 matters.
- **Honest view:** a research bet, but far more plausible with the MoE than with the 9B or the dense 27B alone.

**LiveCodeBench:** MoE 80.4 → 27B 90.3. S*-style selection with public examples may close part of the gap.

### 13.4 Levers, ranked for this machine

1. MoE brain (rung 3) in the loop.
2. Line ops + Laya-forced headers.
3. Teacher labels for the small heads and the 9B.
4. Decision plane doing every pick (shrink, locate, pattern, route).
5. Per-step checks + fork and rewind (Tier C).
6. Short-memory steps (Tier C).
7. Data scale and curriculum.
8. Per-repo adaptation.
9. Rare 27B calls.
10. More attempts and repair, per rung, once off the floor.
11. Hardware: 32 GB RAM first.

### 13.5 Hard limits

- 16 GB of RAM has to hold MoE experts, the OS and the sandbox.
- One big model resident at a time.
- The MoE and the 27B cannot be fine-tuned here.
- Quantisation loss on long, error-compounding runs.
- Official timeouts on slow local runs.
- Laya's short context and weak zero-shot performance until it is trained.

---

## 14. Designs considered, rejected and reversed

| Design | Verdict | Why |
|---|---|---|
| Free search/replace with format as a diversity axis (r1) | **Replaced** | Project evidence: copying fails for small models. Line ops adopted. |
| More attempts as the main lever at the floor (r1 Bet 1) | **Parked per rung** | A multiplier on ~0 stays ~0. Return when a rung's per-attempt rate is off the floor. |
| Dense 27B split as the main long-job brain (r1) | **Demoted to rare expert** | The MoE is several times faster here at most of the quality |
| 27B at IQ1/IQ2 fully in VRAM | Rejected | 5.9–6.9 GB leaves no cache room; heavy expected quality loss |
| Per-repo adapters (rejected in r1) | **Reversed** | +23.5/+36.4 in-repo gains, measured |
| "Smallest base that ties" as the system's base rule | Narrowed | Fine for the cheap rung; the ladder needs bigger rungs above |
| Parking Laya until a second head exists | Disagree | Location, pattern and context are list-picks now; the banked +48 points was this shape |
| Chatty LLM roles | Rejected | Collaboration Gap; Rethinking Scale |
| Single 9B ReAct loop with full transcripts | Rejected | Context rot, loops, idle GPU |
| Online GRPO locally | Deferred | Rollouts and training can't share 8 GB; teacher labels + rejection sampling first |
| Learned routing among many LoRAs (Arrow) | Deferred | Until 10+ heads with paired evidence |
| Fine-tuning the MoE or 27B locally | Not possible on 8 GB | Frozen; distil into trainable rungs instead |

---

## 15. Experiments

Each experiment has a go / kill rule. All use non-reserved data and the ledger. Confirmations follow the line-edits spec's registration rule.

### 15.1 Phase 0: get off the floor (week 1–2)

**X1 — Bigger rungs on the 32 location-given tasks (1–2 days)**
- **Models:**
  - `deepseek-v4-pro-9b`;
  - Gemma 26B-A4B (Fast profile; thinking off and budget 1,536);
  - Qwen3.6-35B-A3B once X3 serves it.
- **Formats:** the old SEARCH/REPLACE, and line ops once step M2 lands.
- **Runs:** greedy k = 1, then k = 8.
- **Go:** any rung ≥5/32 → the floor is partly model size; that rung becomes teacher and ladder rung.
- **Kill:** every rung 0/32 in both formats → suspect the task setup itself (window, grader, environment). Audit before anything else.

**X2 — Overfit test of the training pipeline (hours)**
- Train the current `sft_patch.py` pipeline on 20 training examples.
- **Go:** ≥95% exact reproduction in HF **and** through the served GGUF + grammar.
- **Kill:** below that → a pipeline bug (masking, template, conversion). Fix before any other training.

**X3 — Qwen3.6-35B-A3B serving sweep (1–2 days)**
- **Grid:** quant (IQ2_M, IQ3_XXS, mixed) × `--n-cpu-moe` × MTP draft depth (1–3) × thinking budget (0, 512, 1,536).
- **Measure:**
  - tok/s;
  - VRAM (nvidia-smi delta);
  - RAM headroom with a sandbox running;
  - the tier2b suite vs Gemma's 105/117.
- **Go:** ≥25 tok/s and ≥ Gemma's tier2b score → it becomes rung 3.
- **Otherwise:** Gemma stays rung 3.

**X4 — Teacher labels vs gold labels (3–4 days)**
- The best rung from X1/X3 labels the training tasks (verified, minimal).
- Train the 1.5B / 3B `ops` heads on teacher labels, gold labels, and a mix.
- Compare in the fast loop on F (header exact, body NLL, by tier, paired CIs), then one registered confirmation.
- **Go:** teacher-label head beats the gold-label head with the CI lower bound above 0.

**X5 — Decision-plane arms (2–3 days)**
- **Laya L2 location picker** vs each head's own headers: header exact on F.
- **Fix-pattern menu (rung 0)** on T1 tasks: share solved with no generation.
- **Router R1** vs a fixed rung: tasks solved per GPU-minute.
- **Kill rule:** any question that does not beat its rule-based baseline is removed.

**X6 — Size-threshold curves (alongside X1–X5)**
- Per rung: pass rate (or fast-loop metrics) by tier T1/T2/T3.
- Re-measure after X4.
- **Go:** teacher-label training moves the threshold up at least one tier for at least one small base.

**X7 — Per-repo adaptation (2–3 days)**
- On F, split by time: adapter on older commits, evaluate on newer.
- Registered as a separate arm.
- **Go:** paired gain with the CI lower bound above 0.

### 15.2 Track A: Crucible to parity

| ID | What | Go / kill |
|---|---|---|
| A1 | Throughput per rung: candidates/min, swap times, Vulkan vs CUDA | Swap ≤30 s and rung-3 turns ≤30 s, else revisit placement |
| A2 | Coverage per rung on dev, solved vs GPU-minutes; fast-loop metrics while at the floor | Ladder coverage at budget ≥ the 27B's one-shot (cloud, same pipeline) → selection and cost problem; below after two training rounds → publish the gap |
| A3 | Selection precision (hidden-test split, hack checks) | ≥95% → selection solved for Tier A |
| A4 | Training rounds (teacher labels, pipeline-aware, curriculum) | Each round must move the threshold or fast-loop metrics on F |
| A5 | Showdown on the reserved sets, in the registered order | Pre-registered: margin, budget, strata, paired McNemar |

### 15.3 Track C: long jobs

| ID | What | Go / kill |
|---|---|---|
| C0 | Serve the MoE for agent turns: turn time at 2k-token deltas, slot save/restore, RAM with a Docker sandbox; also the dense-27B split as the rare expert | Turn ≤15 s (MoE); 27B ≥8 tok/s with speculation; no paging to disk |
| C1 | Quantisation loss: 20–30 SWE-bench Pro / Terminal-Bench tasks, local MoE vs cloud full-precision MoE, paired | Local ≥85% of cloud solved, else try other quant mixes |
| C2 | Short-memory harness vs full transcript | Equal or better solved with clearly fewer prefilled tokens |
| C3 | Checks + fork and rewind | More solved per hour, or the same solved in less time; low false "done" rate |
| C4 | Hands mode (9B + `step` head, MoE on stuck) vs Brain mode (MoE drives) | Per-task mode policy chosen by Laya, not one winner |
| C5 | Skill library | Turns per solved task fall over ~50 tasks, else drop |
| C6 | Showdown vs the cloud 27B in the same harness | Report within-timeout, unlimited-time and wall-clock |

### 15.4 Suggested first four weeks

| Week | Phase 0 / Track A | Track C |
|---|---|---|
| 1 | X2 (hours); X1 with the 9B and Gemma; line-edits steps M1–M2 proceed as planned | X3 (shares the serving work) |
| 2 | X1 with Qwen3.6; X4 teacher labelling starts; M3 fast loop | C0 |
| 3 | X4 training and comparison; X5; X6 curves | C1 (cloud baseline in parallel) |
| 4 | X7; first registered confirmation on the leader | C2 harness; decide month two |

### 15.5 Metrics and statistics

- **Fast loop (adopted):** header exact, body NLL/token, answer-token accuracy; per tier with n; paired task-clustered bootstrap CIs.
- **Threshold:** largest tier at ≥50% pass, or at the fast-loop criterion.
- **Confirmation:** accepted rate (grader + hidden test + hack check), end-to-end and per tier; solved per GPU-minute.
- **Tier C:** solved within timeout and unlimited; turns; prefilled tokens; expert calls; rewinds; wall-clock.
- **Decision plane:** recall@k, ECE, AUC, end-to-end effect.
- **Fast-loop kill criterion (adopted):** fast metrics must predict pass/fail at the first confirmation.

---

## 16. Risks

1. **Memorisation** of popular repos and benchmarks → freshness split.
2. **Test hacking, weak tests** → hidden-test split, V2, synthesised hacks as negative examples.
3. **Teacher bias:** small heads inherit the MoE's habits, including its mistakes → only verified labels; mix with trimmed gold labels.
4. **Teacher licence:** check Gemma's terms before using its outputs for training; Qwen3.6 is Apache-2.0.
5. **Adapter conversion and serve parity** → X2 overfit test, serve parity before every confirmation.
6. **llama.cpp gaps** for these architectures: MTP drafting for Qwen3.6, slot save/restore with recurrent state, op offload on Vulkan → test in X3/C0; CUDA build as the fallback.
7. **RAM pressure** with MoE experts + sandbox → one WSL memory pool, container caps, quant mix; 32 GB as the escape hatch.
8. **Swap costs** between rungs eat the budget → measure in A1; route to minimise swaps (batch tasks by rung).
9. **Benchmark timeouts** vs slow local runs → report both scores.
10. **Laya:** weak zero-shot, label-following, short context → shadow mode, fine-tuning, calibration, shuffle tests.
11. **Jev:** network dependency → off the hot path; offline mode on Laya alone.
12. **Reserved-set wear** from many arms → the fast loop reads only F; confirmations follow the registered sequence.
13. **Sandbox safety** for generated code → L3 sandbox, WSL/Docker, no network unless needed.
14. **Self-training poisoning** → labels only from execution and checks.

---

## 17. Open questions

- Does Qwen3.6-35B-A3B's MTP head convert to GGUF and give Gemma-like gains at depth 2?
- How much do IQ2/IQ3 expert quants cost the MoE on long agentic runs?
- How many of the gold commit diffs are "mixed" (Jev T1)? Is that a large share of the training problem?
- Can Laya pick exact line ranges within 1,024 tokens, or does L2 need `max_len` up to 8,192 or a deeper hierarchy?
- What are Terminal-Bench's per-task timeouts, and will its harness tolerate slower local runs?
- Is a 16 → 32 GB RAM upgrade available? It changes Config M and the swap story.
- Are cloud calls allowed for baselines (the 27B and the full-precision MoE)?

---

## 18. Sources

**Project files (read for r2):**
- Line-edits spec: `D:\qwen3-forge\jev-swarm\jev-swarm\.claude\worktrees\line-edits-fastloop\docs\superpowers\specs\2026-10-02-line-edits-fastloop-design.md`
- Gemma serving script and measurements: `D:\qwen3-forge\scripts\serve-gemma4-26b.ps1`
- jev-swarm runtime: `D:\qwen3-forge\jev-swarm\jev-swarm\runtime\` (`types.ts`, `pipeline.ts`, `ladder-types.ts`, `ladder-oracle.ts`, `providers.ts`)

**Model cards and docs:**
- Qwen3.8-27B: https://huggingface.co/Qwen/Qwen3.8-27B
- Qwen3.8-27B LiveCodeBench summary: https://www.qubrid.com/blog/qwen38-27b-benchmarks-official-and-independent-results
- Qwen3.6-35B-A3B: https://huggingface.co/Qwen/Qwen3.6-35B-A3B
- Qwen3.5-35B-A3B: https://huggingface.co/Qwen/Qwen3.5-35B-A3B
- Qwen-AgentWorld-35B-A3B: https://huggingface.co/Qwen/Qwen-AgentWorld-35B-A3B
- Qwen3.5-9B: https://huggingface.co/Qwen/Qwen3.5-9B
- Qwen3.8-9B-Distill: https://huggingface.co/empero-ai/Qwen3.8-9B-Distill
- Qwen3.8-Flash-Next (too big here): https://huggingface.co/Qwen/Qwen3.8-Flash-Next
- Laya: https://huggingface.co/convaiinnovations/laya
- Laya ONNX: https://huggingface.co/tozp/laya-onnx
- TypeSafe confidence: https://docs.typesafe.ai/confidence.md
- TypeSafe docs index: https://docs.typesafe.ai/llms.txt
- TypeSafe cascade cookbook (pattern for the router; not read): https://docs.typesafe.ai/cookbooks/sde_cascade.md
- llama.cpp server README: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md

**Papers (abstracts read):**
- Large Language Monkeys: https://arxiv.org/abs/2407.21787
- CodeMonkeys: https://arxiv.org/abs/2501.14723
- S*: https://arxiv.org/abs/2502.14382
- SWE-Protégé: https://arxiv.org/abs/2602.22124
- The Collaboration Gap: https://arxiv.org/abs/2511.02687
- Rethinking Scale: https://arxiv.org/abs/2604.19299
- Diffs vs. Whole Files: https://arxiv.org/abs/2609.05779
- SWE-RM: https://arxiv.org/abs/2512.21919
- BugPilot: https://arxiv.org/abs/2510.19898
- SWE-Universe: https://arxiv.org/abs/2602.02361
- Kimi-Dev: https://arxiv.org/abs/2509.23045
- RLVE: https://arxiv.org/abs/2511.07317
- Satori-SWE: https://arxiv.org/abs/2505.23604

**Not re-read (from memory or the brief's summary):**
- Diff-XYZ: https://arxiv.org/abs/2510.12487
- Arrow / modular LoRAs: https://arxiv.org/abs/2405.11157
- Voyager: https://arxiv.org/abs/2305.16291
- TBar (template-based program repair, ISSTA 2019)
- Prophet (learned patch ranking, POPL 2016)
- RTX 4060 specs

---

## 19. Glossary

- **Rung / ladder:** models ordered by cost and ability; each job goes to the cheapest rung likely to solve it.
- **MoE (mixture of experts):** a model with many expert sub-networks, of which only a few run per token. "35B-A3B" means 35B total, 3B active.
- **`--n-cpu-moe`:** a llama.cpp setting that keeps the expert weights of a chosen number of layers in RAM, while the rest of the model stays on the GPU.
- **MTP (multi-token prediction):** built-in heads that draft several tokens ahead, verified in one pass. Same output, fewer slow passes.
- **Thinking budget:** a cap on reasoning tokens before the answer.
- **Line ops:** `REPLACE a-b`, `INSERT_AFTER n`, `DELETE a-b` against numbered lines.
- **Header / body:** the op type and line numbers / the new lines written.
- **Header exact:** every header token right, given the gold prefix (teacher-forced).
- **Body NLL:** how likely the model finds the gold body text (lower is better).
- **Fast loop:** teacher-forced evaluation with no decoding or tests; minutes per arm.
- **Threshold:** the largest fix-size tier a model handles at a set success level.
- **Teacher labels:** fixes written by a strong model, kept only if tests prove them correct.
- **Coverage / pass@k:** chance that at least one of k tries is correct.
- **Selection precision:** chance the shipped answer is correct, given a correct one exists.
- **F2P / P2P:** fail-to-pass tests (must turn green) / pass-to-pass tests (must stay green).
- **SBFL:** rank code by how much more often failing tests run it than passing tests.
- **LoRA / adapter head:** a small add-on weight file that specialises a base model; swappable per request.
- **Situation report:** the short, code-kept state the agent sees each step instead of a transcript.
- **Check:** a command whose result proves a subgoal is done.
- **Brain mode / Hands mode:** the MoE drives / the 9B drives and calls the MoE (or 27B) only when stuck.
- **Fix-pattern menu (rung 0):** code templates for common fixes; Laya picks pattern and parameters; tests judge.
