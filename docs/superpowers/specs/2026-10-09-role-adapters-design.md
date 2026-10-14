# Role adapters, Step 2: method proof on Qwen3.5-9B and 4B (design, 2026-10-09)

Roadmap step 2 (`2026-10-08-roadmap-draft.md`), after the owner confirmed the two picks of `2026-10-09-base-selection.md` on 2026-10-09. Design agreed section by section with the owner the same day.

## 1. Purpose and scope

**Question:** does specializing one resident base into three role adapters (plan, build, check/fix), distilled from DeepSeek v4.1 Flash on execution-verified data, make the base better at its roles without costing it general capability, and does the effect grow with model size?

**In scope:** teacher data, a local QLoRA recipe, role gates, a retention gate, an end-to-end headline on two builds, on Qwen3.5-9B and Qwen3.5-4B (2B as an optional quick check), two data arms.
**Out of scope (later steps):** training the final role adapters on pick A (Qwen3.6-35B-A3B, dequantized IQ3_XXS weights, rented GPU, `distill/reverse_map.py`), the Laya relationship (roadmap step 3), serving the adapters in Jarvis. The decision to go to the rented stage is made from this step's results.

**Standing rules that bind every choice below** (memory `measure-not-target-rules`): benchmarks are instruments, never targets; no training or tuning on a benchmark, its task families or its rubric; few fitted parameters; a gain counts only on unseen measures; selection happens only on data that never enters a final score. Teacher: DeepSeek v4.1 Flash through OpenCode Go only, never Grok. Nothing big on C:, never D:, no API key in any file.

**Success bar (owner, 2026-10-09): per-role gates are the gate; the end-to-end result is the headline.**

## 2. Data

**Seeds** (`scripts/teacher/teacher_gen.py seeds`, started 2026-10-09): 280 cells of (language, kind, field), 3 tasks per cell, about 840 tasks. Languages: Python (standard library), Node (no dependencies), single-file web app. 20 broad fields. Each seed is a feature request with an exact interface plus an acceptance test file written by DeepSeek. Seeds are dropped if their request is within Jaccard 0.5 of any scored spec (tier2b, the pool, both judge sets) or names a benchmark topic. The Ecosystem Lab's topics (ecosystem simulation, predator/prey, Lotka-Volterra) are added to the exclusion list before `gen` runs.

**Splits by whole field** (seeded shuffle, `random.Random(20261009)` over the 20 fields, fixed now, before any data is looked at):
- **test (4):** developer tooling, accessibility, small business operations, security and privacy
- **dev (2):** media and libraries, team collaboration
- **train (14):** casual games and puzzles, hobbies and crafts, personal productivity, open-source maintenance, system administration, documentation and writing, health and fitness, home and family organisation, data analysis, education and study, science and mathematics, creative tools, travel and maps, networking and the web

Test is touched once per final model and arm. Dev is used only for stopping and for choosing the checkpoint and the instruct-versus-base weights.

**Generation** (`teacher_gen.py gen`): for each seed, DeepSeek writes a plan, then a build from the plan, the seed's tests run, and on failure one fix round. Only code that passes the tests counts. Test and dev seeds are generated too (they supply the held-out evaluation tasks and the teacher plans for the build gate); their samples are never in training.

**Three sample types** (chat format, loss on the assistant tokens only, non-thinking; prompts are the ones the staged harness will use: `PLAN_PROMPT`, `BUILD_FROM_PLAN_PROMPT`, `FIX_PROMPT` in `scripts/teacher`):

| Role | Input | Target | Kept if |
|---|---|---|---|
| plan | request | plan | a build made from it passed |
| build | request + plan | all files | the first build passed |
| fix | request + files + failing test output | all files, fixed | the fixed files pass |

**Fix data, arm S:** teacher-authored faults. DeepSeek is asked to introduce one realistic bug into a passing build; the fault is kept only if the seed's tests then fail (the failure output is recorded); the target is the original passing code. Real first-build failures and their DeepSeek fixes are added when they exist.

**Two arms** (owner's choice, 2026-10-09):
- **Arm S:** teacher data only (the three tables above).
- **Arm O:** arm S plus on-policy data from the base student: about 300 train seeds built twice by the base (served as a GGUF, temperature 0.7, the staged prompts); its passing builds are added to the build set; its failing builds go to DeepSeek for a fix, and verified fixes are added to the fix set as real failure-to-fix pairs. Plan data stays teacher-only.

**Volumes (targets, stop when reached):** at least 600 verified samples per role in arm S. A 9B epoch at about 2.4M tokens per role is expected to take 20 to 30 minutes if the smoke test hits its throughput bar.

## 3. Training

**Bases:** `Qwen/Qwen3.5-9B` and `Qwen/Qwen3.5-4B` (instruct), with `Qwen/Qwen3.5-2B` as an optional quick method check. Whether the instruct or the `-Base` weights train better is decided on dev with one comparison at the smallest size; the choice is fixed before test.
**Adapters:** three per base per arm (plan, build, fix): 12 trainings for two sizes.
**Recipe (fixed, no sweeps):** QLoRA 4-bit NF4; LoRA rank 16, alpha 32, dropout 0.05, on every linear layer of the attention and MLP blocks and the gated-delta-net projections; learning rate 1e-4 with cosine decay (raised to 2e-4 once if the first dev run underfits, recorded either way); 2 epochs; sequence length at most 4,096 (longer samples are dropped, not truncated); effective batch 16 samples; gradient checkpointing; the stopping point and checkpoint are chosen on dev loss and dev role pass rate.
**Stack:** a new environment on E: (the benchmark venv has no torch). The first choice is plain torch (CUDA), transformers, peft, bitsandbytes and trl; Unsloth Studio (`E:\Unsloth`) is the fallback. Qwen3.5's gated-delta-net layers may need `flash-linear-attention` and `causal-conv1d` to train at a usable speed on Windows.
**Smoke test (gates everything else):** one 9B QLoRA step at sequence length 4,096 must fit about 7.5 GB of VRAM and reach at least 400 tokens/s; the 4B must fit comfortably. If the 9B misses the bar, the ladder becomes 4B, 2B and 0.8B (two sizes or more kept), stated in the results.
**Where the adapters run:** trained and evaluated locally; evaluation serves the base and one adapter at a time (GGUF base plus converted LoRA in llama-server, checked against transformers outputs by `served_lora_check.py`'s method).

## 4. Evaluation (pre-registered here; no adapter is scored before this spec is committed)

**Role gates** (test fields, about 170 seeds, same seeds for adapter and base, 1 sample per seed at temperature 0.2):
1. **Build:** pass@1 on the acceptance tests, given the teacher plan.
2. **Plan:** a fixed builder (the plain base, no adapter) builds from the adapter's plan versus from the plain base's own plan; compare pass@1.
3. **Fix:** fix pass rate after one round on the base student's own failing builds on the test seeds.
**Pass rule per role:** adapter minus base at least +5 points absolute and exact one-sided McNemar p < 0.10 on paired seeds. The effect size and a 90% interval are reported for every role whether or not it passes.

**Retention gate** (non-inferiority, adapters loaded versus the plain base, within 3 points):
- tier2b single-shot (117 samples; coding, adjacent to the fix role, so it also catches over-specialization);
- a 200-question public multiple-choice general-knowledge subset scored by exact letter (a small public dataset, used to measure only, never trained on; the subset is drawn with a fixed seed and listed in the data folder before any adapter runs).

**Headline, end to end:** plan adapter, then build adapter, then run the task's checks, then fix adapter for up to 2 rounds, versus the plain base with the same staged prompts, and versus base single-shot; 3 runs each at the smallest and largest size.
- **Build 1:** the Ecosystem Lab (dev checks; never trained on; it informed the base pick, which is disclosed).
- **Build 2, B2:** a new build never used or looked at before this step. DeepSeek writes the spec, the reference page and 70 hidden checks, validated as the Lab was (reference 70/70, empty page 0, planted bugs caught, an independent implementation of the prompt alone passes), then the check parameters are sealed by hash before any adapter runs. B2 is its own sub-project, scheduled last (section 6); the headline is reported on Build 1 alone until B2 is sealed, and says so.
- **Headline pass:** the staged pipeline with adapters has a higher mean check score than the staged plain base on both builds and no fewer apps that run. At 3 runs this is a direction, not a significance claim, and is reported with the spread.

**Scaling:** role effect sizes at 4B and 9B side by side. "The effect grows with capability" is an observation if the 9B effect is at least the 4B effect on each passing role; it is not a gate.
**Arms:** S versus O per role, on dev and test; the arm carried forward is the one with the larger test gain on the roles it passes (ties go to S, the cheaper).

## 5. Compute, cost and storage

Local only (RTX 4060 8 GB, 16 GB RAM). The Versutus gate is paused and the WSL guard kept up for every GPU session, as in Step 1; the 64k/RAM findings of Step 1 apply (one server at a time, apps closed for 9B training). DeepSeek spend: about 840 seeds x (plan, build, fix) plus fault injection plus arm O fixes, roughly 4,000 API calls at about 100 s with 6 parallel workers (about 12 hours of wall time, in the background). Data under `E:/AI/teacher-data/gen-v0`; models and adapters under `E:/AI/role-adapters`; the public repo gets scrubbed results, the splits, the spec and the eval code, not the teacher text.

## 6. Sequence and deliverables

1. **2a Data:** seeds (running), exclusion update, `gen` for all splits, fault injection, split manifest committed.
2. **2b Environment and smoke test:** weights to E: (about 28 GB), the training environment, the smoke test and its verdict.
3. **2c Arm S:** train 3 adapters x 2 sizes, run the role and retention gates on dev, then test once.
4. **2d Arm O:** student sampling, DeepSeek fixes, train, gates.
5. **2e Headline:** Build 1 first; then B2 (its own spec, validation and seal), then both.
6. **2f Report and the decision** on the rented final stage on pick A.
Each of 2c to 2f ends with a results document and the owner's sign-off before the next starts.

## 7. Risks and fallbacks

- **Floor effects:** the bases score 0.0 to 0.11 on the Lab. The role gates (small, executable tasks) are the sensitive instrument; the headline may show nothing, and that is a result.
- **Low power:** about 170 test seeds and 3 runs per build. Effects are reported with intervals; the pass rule is deliberately modest.
- **Training speed or memory on Windows:** the smoke test gate, then the smaller ladder; WSL is a last resort (it costs about 600 MB of RAM).
- **Teacher faults too easy or unlike real failures:** arm O exists to test that, using the student's real failures.
- **DeepSeek quota or rate limits:** the pipeline is resumable and retries empty cells.
- **Leakage:** field-level splits; the wording check against every scored set; the Lab's topics excluded; no benchmark text in prompts or data.
