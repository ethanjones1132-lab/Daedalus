# One-shot build benchmark: Ecosystem Lab

- **Date:** 2026-10-07. **Status:** design approved by the owner in conversation, section by section. Nothing has been built yet.
- **Why:** every score so far comes from small Python bug fixes (tier2b, the calibration pool, the judge sets), and keep96's experts were chosen on Python standard-library code. The goal now is **general capability**: can a model one-shot a real, many-sided build? This benchmark measures that.
- **Shape** (owner): **one** substantial build, graded on its reasoning, its output and its final product. It is not a battery of small tasks.
- **Round one** (owner): keep96 and DeepSeek v4.1 Flash on OpenCode Go, the latter as the ceiling. Full Qwen3.6, gpt-oss-20b and Gemma 4 26B come later. The last two aren't on disk, and C: is at 95% full.

## 1. The build

Every model gets the same prompt, `docs/benchmarks/oneshot/ecosystem-lab/prompt.md`. It asks for:

1. **A short design plan:** the data model, the tick order, and a list of components.
2. **One self-contained HTML file:** inline JS and CSS, no network, no libraries.

The app is a predator–prey lab. Everything below is stated exactly in the prompt.

**The world:**
- A W×H grid. Each cell holds a grass level from 0 to `grassMax`.
- Rabbits and foxes each have an id, a position and an energy. A cell holds at most one rabbit and at most one fox.
- **Tick order:**
  1. All grass grows +1, up to the maximum.
  2. Rabbits act in ascending id order:
     - move to a uniformly random neighbouring cell (4-neighbourhood, within the grid) that has no rabbit, or stay if none;
     - eat the grass there (gain `rabbitGain × grass`; the grass goes to 0);
     - lose `rabbitCost` energy;
     - if energy ≥ `rabbitBreed`, place a child with half the energy (rounded down) in a random free neighbouring cell. The parent keeps the rest, and the child gets the next id and doesn't act this tick;
     - if energy ≤ 0, die.
  3. Foxes act in the same way, with these differences:
     - a fox moves to a neighbouring cell holding a rabbit if there is one (chosen at random among them), otherwise to a random cell with no fox;
     - eating a rabbit removes it and gives `foxGain`;
     - a fox loses `foxCost`, breeds at `foxBreed` and dies at zero.
- **Randomness.** The random-number generator, mulberry32, is given verbatim (about 10 lines). One stream drives everything, in the stated call order. The checks therefore test the rules, not a guess at the generator.
- **Initial placement** after `reset(seed, params)`:
  - grass levels are drawn per cell in row-major order;
  - then `rabbits0` rabbits, then `foxes0` foxes, are placed at random free cells.

**The UI:**
- Canvas rendering with the colours given in the prompt.
- Play, pause and step controls, and a speed control (ticks per second).
- A live SVG population chart with labelled axes and one point per tick.
- Parameter sliders, each with a visible label and value.
- **An equations panel:**
  - solves the Lotka–Volterra equations with RK4, from user α, β, γ, δ, initial values, t and dt;
  - plots them;
  - shows the equilibrium (γ/δ, α/β);
  - shows the drift of the conserved quantity V = δx − γ ln x + βy − α ln y.
- Scenario save and load as JSON, to a schema given in the prompt. Malformed JSON produces a visible message and leaves the state unchanged.
- CSV export of the population history, in the format given: header `tick,rabbits,foxes,grass`.
- Presets kept in localStorage, which can be listed and deleted.
- Full keyboard operation, with an ARIA live region that announces the counts on pause.
- A layout that puts the panels side by side at 1,280 px and stacks them below 700 px, with no horizontal scrolling.

**The test interface the prompt requires:**
- **`window.lab`**, with these methods:
  - `reset(seed, params)`;
  - `step(n)`;
  - `counts()`, returning `{rabbits, foxes, grass}`;
  - `cell(x, y)`;
  - `ode(params, t, dt)`, returning `{x, y}`;
  - `exportCSV()`;
  - `loadScenario(json)`;
  - `history()`.
- Named `data-testid`s on the controls.
- Exposing an interface is ordinary feature work. It lets the checks test the logic exactly and also drive the real UI.

**Output budget:** 32k tokens, in a 64k window for keep96.

## 2. Hidden checks

`checks.mjs` runs Playwright through the installed Chrome (`channel: 'chrome'`, so there is no browser download).
- Each check gets a fresh page and a 10-second timeout.
- Network requests are blocked and counted.
- Timing checks use Playwright's fake clock.

**About 90 checks across the ten areas,** 8–10 per area:

| Area | Checks |
|---|---|
| 1. Logic and state | Initial placement after `reset`; parameters take effect; invariants such as one animal per cell, energy never negative, grass within bounds |
| 2. Time | Play advances at the set speed under the fake clock, pause stops, step advances exactly one tick, speed changes apply mid-run |
| 3. Canvas | Pixel colours at sampled cells match the state; it redraws after a step and after a reset |
| 4. SVG chart | One point per tick; the last point's position matches the count; axes are labelled; the chart resets |
| 5. Text and data | Exact CSV export; JSON save/load round trip; malformed JSON gets a message and leaves the state unchanged; the schema's defaults apply |
| 6. Algorithms | Exact populations after 100 and 500 steps on hidden seeds; breeding placement and id order; extinction |
| 7. Layout | Side by side at 1,280 px, stacked at 600 px, no horizontal scroll, the canvas fits its panel |
| 8. Accessibility | Every control reachable by Tab and operable by keyboard; labelled sliders; the live region announces on pause; focus is visible |
| 9. Persistence | Presets survive a reload; listing and deleting presets; state isn't corrupted by a missing key |
| 10. Domain | RK4 values against the reference (tolerance 1e-6); equilibrium shown correctly; conserved-quantity drift under 1e-4 over the stated run |

**Scoring:**
- area score = the share of its checks passed;
- build score = the mean of the 10 area scores;
- a model's score is the mean ± spread over its builds, with the per-area breakdown.

**Hidden parameters:**
- The checks use seeds, grid sizes and equation parameters that don't appear in the prompt.
- **Dev set:** in the repo, used freely while tuning.
- **Sealed set:** kept *out of the public repo*, at `C:\qwen3-forge-stage\oneshot-sealed\`. Only its sha256 is committed.
- The sealed set is opened only for verdicts, and every opening is logged in `docs/benchmarks/oneshot/sealed-log.md`.

**Validating the benchmark before any model sees it:**
1. My reference app (`reference.html`) passes 100% on both sets.
2. An empty page scores 0 on every check.
3. **Deliberate-bug test.** Five planted bugs in the reference must each be caught by at least one check. The bugs:
   - the wrong tick order;
   - an off-by-one in breeding;
   - RK4 replaced by Euler;
   - a missing ARIA label;
   - CSV written without its header.
4. **Ambiguity audit** (owner-approved subagent):
   - A fresh subagent implements the app from `prompt.md` alone, without seeing the reference or the checks.
   - Any exact-check failure that comes from the prompt's wording gets the wording fixed, never the check. The audit is then repeated until its implementation passes the exact checks.
   - The audit implementation is never shown to a model under test.
5. **Determinism:** every check runs 3 times on the reference, and the results must be identical.

## 3. Harness and runs

`scripts/oneshot/oneshot_bench.py` (new folder, so it stays clear of the Laya v3 run's files):

| Subcommand | Job |
|---|---|
| `run` | Generate builds |
| `check` | Extract and run the checks |
| `shots` | Take screenshots |
| `report` | Write the report |

**keep96:**
- llama-server 836d571 with `-c 65536 -b 512 -ub 512`, the q8_0 cache, MTP 2 + n-gram speculation, and `--load-mode none`. The window and batch come from today's long-context check.
- Thinking off, temperature 0.2, top_p 0.95, seeds 1–5: **5 builds**.

**DeepSeek v4.1 Flash:**
- Through OpenCode Go's chat API (`https://opencode.ai/zen/go/v1`), with the model id confirmed from `/models` at run time.
- The key is read from OpenCode's `auth.json` and is never printed or logged.
- Temperature 0.2: **5 builds**. Its reasoning trace, if the API returns one, is stored and reported but not scored.
- A small client inside `scripts/oneshot/`, separate from the Laya v3 plan's `opencode_go.py`, which that run creates tonight.

**Extraction:**
- the plan is the text before the HTML;
- the app is the largest HTML block;
- a truncated build (no `</html>`) is still checked, and flagged.

**Static report:** one file or not; external URLs; console errors on load; output tokens; generation speed; wall time.

**Screenshots,** taken for judging:
- on load;
- after 200 steps;
- at 390 px width;
- with the equations panel open.

**Artifacts:** `docs/benchmarks/oneshot/runs/<model>/<seed>/` holds `response.md`, `plan.md`, `app.html`, `checks-dev.json` and `shots/*.png`.

**Timing:**
- keep96 takes about 15 GPU minutes, so its runs finish before 01:00 tonight. The Laya v3 run takes the GPU at 01:30.
- DeepSeek needs no GPU.

**Other models later:** the harness takes any model config. Full Qwen3.6, gpt-oss-20b and Gemma join once there is space on C:.

## 4. Blind judging and the report

**The rubric is committed before any build is generated** (`rubric.md`). Each item scores 0–5:
- **Plan:** rules stated correctly; everything the spec asks for covered; the code actually follows the plan.
- **Code:** structure; readability; robustness to invalid input and edge states.
- **Product, from the screenshots:** clarity of layout; visual quality; usability; the phone-width view.

**Blinding:**
- every build gets a random id and the order is shuffled (`blind-map.json`, written by the harness);
- I judge from the anonymised builds and commit all scores before opening the map.

**Judged scores are reported beside the check score, never mixed into it.**

**The report** (`docs/superpowers/specs/<run date>-oneshot-results.md`):
- the check score per model, overall and per area;
- the judged scores;
- the static report;
- a screenshot gallery of every build.

**Contamination rules:**
1. Neither the prompt nor the checks ever go into a DeepSeek teacher prompt for training data.
2. **DeepSeek's builds from this benchmark never become training data.**
3. Training and tuning decisions use the dev set only.
4. The sealed set is opened only for verdicts.

## 5. Components

| File | Role |
|---|---|
| `docs/benchmarks/oneshot/ecosystem-lab/prompt.md` | The build prompt, including the PRNG and the schema |
| `docs/benchmarks/oneshot/ecosystem-lab/reference.html` | The reference app; never shown to a model |
| `docs/benchmarks/oneshot/ecosystem-lab/checks.mjs` | The hidden checks, given a check-parameter file |
| `docs/benchmarks/oneshot/ecosystem-lab/params-dev.json` | Dev check parameters |
| `C:\qwen3-forge-stage\oneshot-sealed\params-sealed.json` | Sealed check parameters (sha256 in the repo) |
| `docs/benchmarks/oneshot/ecosystem-lab/rubric.md` | The judging rubric |
| `docs/benchmarks/oneshot/ecosystem-lab/bugs/` | The five planted-bug variants of the reference |
| `scripts/oneshot/oneshot_bench.py`, `deepseek.py`, `package.json` | Harness, API client, Playwright dependency (installed with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) |
| `scripts/oneshot/test_oneshot_bench.py` | unittest for extraction, scoring and blinding |

## 6. Risks

- **One build is a noisy sample.** Five builds per model and about 90 checks soften this. The report shows the spread.
- **The test interface leaks some structure.** It names the functions to write. That is ordinary for feature work, and it keeps the checks honest.
- **The exact-count checks are strict.** The ambiguity audit is the guard: a reasonable implementation of the prompt must pass them.
- **The judge is also the author of the spec and the reference.** Blinding hides which model built what, but not my own taste. Judged scores stay separate for that reason.
- **The API may not honour seeds,** so DeepSeek's 5 builds are 5 independent samples, not seed-reproducible.
- **Playwright's npm package is a new dependency** (no browser download). If the installed Chrome is too new or too old for it, I'll stop and ask before fetching a browser.
