# One-shot build benchmark, round one: results, 2026-10-07

- **Spec:** `2026-10-07-oneshot-bench-design.md` (4ef10dc). **Plan:** `../plans/2026-10-07-oneshot-bench.md`.
- **Benchmark:** `docs/benchmarks/oneshot/ecosystem-lab/`.
  - `prompt.md`;
  - `reference.html`;
  - 70 hidden checks in `checks.mjs`;
  - the rubric;
  - the validation record in `validation.md`.
- **Runs:** `docs/benchmarks/oneshot/runs/`, with local paths scrubbed. **Gallery:** `docs/benchmarks/oneshot/gallery.md`.
- **Round one** (owner's lineup): Qwen3.6 keep96, local, against DeepSeek v4.1 Flash on OpenCode Go as the ceiling. Five builds each.

## Outcome

**DeepSeek one-shots the whole app every time. keep96 can't produce a working app at all.**

| | DeepSeek v4.1 Flash | Qwen3.6 keep96 |
|---|---|---|
| Hidden checks, dev set | **70/70 on all 5 builds** (score 1.000) | 0–4/70 (mean 0.031, sd 0.034) |
| Hidden checks, sealed set (opened once, logged) | 70/70 on all 5 | the same as dev, on every build |
| Builds that run at all | 5/5 | **0/5** |
| Judged plan (/15), mean | 14.6 | 4.2 |
| Judged code (/15) | 14.6 | 2.8 |
| Judged product (/20) | 19.4 | 1.2 |
| Output tokens per build | 34–39k, about 20–25k of it reasoning | 3.7k–32.8k, no reasoning |
| Wall time per build | 2.6–3.3 min (API) | 0.6–3.8 min (local, 120–290 tok/s) |

**What DeepSeek built:** five independent, polished, working tools. Each one:
- reproduces the exact simulation, so all five show 521 rabbits and 106 foxes at tick 200 on seed 42;
- integrates the equations with RK4, with a drift of 2.3e-8;
- passes every UI, persistence, accessibility and layout check;
- reflows cleanly at phone width.

**What keep96 produced:** no build reached a running simulation. These are failures of coherence over a long output, not wrong simulation logic. The code never ran.

| Build | Tokens | What happened |
|---|---|---|
| 1 | 3,731 | Complete but short. The script looks up elements by `id`, while its own HTML only has `data-testid`, so it crashes on load (`null.width`). |
| 2 | 32,768 (cap) | An HTML skeleton plus a separate JS block, with that pair repeated 5 times until the cap. The assembled JS fails: `tick` is declared twice. |
| 3 | 23,891 | An HTML skeleton plus 5 identical JS blocks, and no plan. The assembled JS fails: HTML sits inside the JS block. |
| 4 | 27,206 | A degenerate CSS loop (`input[type="ps1215"]`, `"ps1216"`, …) for 67 KB. No script. |
| 5 | 32,768 (cap) | One 452-line HTML block repeated 6 times. Its script reads elements its HTML lacks, so it crashes on load. |

**Forgiving the format doesn't rescue keep96.** The exploratory assembled score inlines the first JS and CSS blocks into the skeleton. It is the same as the strict score on every build, because the assembled scripts crash too.

## What it means

1. **tier2b hid this.** keep96 solves 107/117 small single-file Python fixes with the recipe. It cannot hold a ~1,000-line, many-part artifact together: it loses the HTML/JS contract, repeats itself, and doesn't stop. For the owner's goal of one-shotting a feature or build, this is the gap that matters most, and no benchmark until now measured it.
2. **The failure modes point at specific levers.** These are untested ideas, in rough order of cost:
   - **Sampling against loops.** Qwen's model-card settings (temperature 0.7, top_p 0.8, top-k 20, presence 1.5), or llama.cpp's DRY sampler. Both cost points on tier2b, but may stop the loops. This is cheap: about 15 GPU minutes per setting.
   - **Thinking on.** Thinking never helped on tier2b. A build with an upfront plan is where it might.
   - **The full 256-expert model, and a higher-bit quant.** This separates what pruning and 2-bit cost from what the base model can do. The full model also needs space on C:.
   - **The training rebuild.** DeepSeek is the teacher, and long, coherent, format-compliant builds are its most obvious target. DeepSeek's builds from *this* benchmark must never become training data (spec §4).
3. **The benchmark saturates at the top.** DeepSeek scores 100%, so it can't rank strong models against each other. For local models it spans the whole range, from 0 to 1.

## Validation (before any model saw the prompt)

The full record is in `ecosystem-lab/validation.md`.
- **The reference** passes 70/70 on both sets, 3 times in a row with identical results.
- **An empty page** scores 0/70.
- **All five planted bugs** were caught in their areas.
- **An independent implementation** written from `prompt.md` alone by a fresh subagent passes 70/70.
- **Prompt changes made during validation:**
  - **Shortcut wording.** A focused button keeps its own Space key.
  - **Defaults.** The first set had every population extinct by tick 50, which made long-run checks trivial.

## Deviations from the spec

1. **DeepSeek's output budget was raised to 65,536 tokens.**
   - At the spec's 32,768, it spent 77–93k characters reasoning, and all four finished builds were cut off before `</html>`. They are kept in `runs-deepseek-32k/`.
   - At 64k it finished every build on its own, at 34–39k tokens. keep96 has no reasoning, so its 32k budget is all answer.
2. **The OpenCode Go client sends a user agent and a stable `x-opencode-session`,** which the endpoint requires (HTTP 400 `MissingSessionID` without them). The same fix went into the Laya v3 plan's client before tonight's run.
3. **The check suite's action timeout is 4 s** (Playwright's default is 30 s), so that missing elements fail quickly. The reference and the independent implementation still pass 70/70.
4. **Exploratory assembled score,** reported beside the strict score as defined above, not instead of it. The **plan** is extracted from wherever its `## Plan` heading appears: keep96 build 2 put it after the first HTML block.
5. **Blinding was weak in practice.** The id-to-build map was opened only after the judged scores were committed (cb0af83). But working and broken builds are obvious from their screenshots. The judged scores add detail; they don't confirm the ranking independently.
6. **The opencode.ai outage.** opencode.ai was unreachable from this machine for about 15 minutes around 18:15 (TCP timeouts to its Cloudflare IPs). It recovered on its own.

## Files

| Path | Contents |
|---|---|
| `docs/benchmarks/oneshot/runs/<model>/<seed>/` | `response.md`, `plan.md`, `app.html`, `app-assembled.html`, `meta.json`, `static.json`, `checks-dev.json`, `checks-dev-assembled.json`, `checks-sealed.json`, `shots/` (DeepSeek also has `reasoning.md`) |
| `judge.json` | Blind scores |
| `blind-map.json` | The id-to-build map, published after judging |
| `sealed-log.md` | Each opening of the sealed set |
| `gallery.md` | Screenshots of every build |
| `runs-deepseek-32k/` | The truncated first DeepSeek attempt |
