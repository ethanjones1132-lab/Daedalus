# One-shot benchmark (Ecosystem Lab) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** build the Ecosystem Lab one-shot benchmark, validate it, then run round one: 5 keep96 builds and 5 DeepSeek v4.1 Flash builds, checked, screenshotted, judged blind and reported.

**Architecture:**
- `prompt.md` is the contract.
- `reference.html` implements it.
- `checks.mjs` (Playwright + Chrome) scores any app against the reference, live, for a given parameter file.
- `oneshot_bench.py` generates builds (keep96 through llama-server, DeepSeek through OpenCode Go), extracts them, runs checks and screenshots, blinds them, and reports.

**Tech stack:**
- Python 3.12 (venv) with unittest;
- Node 24 with `playwright` (npm, installed with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, `channel: 'chrome'`);
- llama-server 836d571.

**Spec:** `docs/superpowers/specs/2026-10-07-oneshot-bench-design.md` (4ef10dc).

**On the plan's form.** `reference.html` and `checks.mjs` are several hundred lines each. Their behaviour is fixed by `prompt.md` (Task 1) and the check catalogue (Task 3). Those two texts are the contract, so this plan states it and the acceptance tests rather than repeating the full code here.

**Paths:**
- `B=docs/benchmarks/oneshot/ecosystem-lab`
- `S=scripts/oneshot`
- `PY=C:\qwen3-forge-stage\venv\Scripts\python.exe`
- the sealed folder `C:\qwen3-forge-stage\oneshot-sealed\` (never committed)

**Deadline:** keep96's GPU runs finish, and the worktree is clean and pushed, before 01:00 on 2026-10-08. The Laya v3 run starts in this worktree at 01:30. Judging and the report may follow after that run, in a separate checkout if it is still running.

---

### Task 1: The contract, `prompt.md` and `rubric.md`

**Files:** create `$B/prompt.md` and `$B/rubric.md`.

- [ ] **Step 1: Write `prompt.md`.** It must state, exactly:
  - the default parameters;
  - mulberry32, verbatim;
  - `pick(list)` = `list[Math.floor(rand() * list.length)]`, which draws only when the list is non-empty;
  - the neighbour order (up, right, down, left, inside the grid, no wrapping);
  - initial placement: grass row-major, then rabbits at random rabbit-free cells, then foxes at random fox-free cells, with ids from one shared counter starting at 1;
  - the tick order: grass, then rabbits by id (move, eat, cost, breed, die), then foxes by id (prey first, else a free move; eat a rabbit in its cell; cost; breed; die), then the history point;
  - the `window.lab` API, the `data-testid`s, the colours and canvas geometry, the timing rule, the scenario schema, the CSV format, the presets key, the live-region text, the keyboard shortcuts, and the layout breakpoints;
  - the output format: `## Plan` (at most 400 words), then one `html` block.
- [ ] **Step 2: Write `rubric.md`.** Each item scores 0–5, with anchors for 0, 3 and 5:
  - plan: correct / complete / followed;
  - code: structure / readability / robustness;
  - product: layout / visual / usability / phone view.
- [ ] **Step 3: Commit.** `docs(oneshot): Ecosystem Lab prompt and judging rubric`. The rubric is committed before any build exists.

### Task 2: `reference.html`

**Files:** create `$B/reference.html`.

- [ ] **Step 1: Implement every item of `prompt.md`** in one HTML file with no network access.
- [ ] **Step 2: Smoke test.** A one-off Playwright script loads it and checks:
  - `lab.reset(42, {})` gives `counts()` with 60 rabbits and 8 foxes;
  - `lab.step(100)` runs without error;
  - `lab.ode({alpha:1.1, beta:0.4, gamma:0.4, delta:0.1, x0:10, y0:10}, 50, 0.01)` drifts less than 1e-6 in V;
  - the console has no errors.
- [ ] **Step 3: Commit.**

### Task 3: `checks.mjs`, parameters, Playwright install

**Files:**
- create `$S/package.json`;
- create `$B/checks.mjs`;
- create `$B/params-dev.json`;
- create `C:\qwen3-forge-stage\oneshot-sealed\params-sealed.json`, plus its sha256 in `$B/params-sealed.sha256`.

**Runner.**
- `node checks.mjs --app APP.html --ref reference.html --params P.json --out OUT.json [--shots DIR]`.
- It serves both files from a local HTTP server on 127.0.0.1, gives each check a fresh browser context, aborts and counts any other request, and gives each check a 10-second timeout.
- Expected values come live from the reference, given the same inputs.
- **Output:** `{checks: [{id, area, pass, detail}], areas: {name: score}, score, console_errors, blocked_requests}`.

**Check catalogue** (ids are stable; `P` is the parameter file's `cases`):

| Area | Checks |
|---|---|
| **logic** | `api-present`; `reset-counts` (rabbits0 and foxes0 for each case); `params-apply` (rabbits0=10, foxes0=0); `grass-bounds` (grassMax=3, 200 steps); `one-per-cell` (cells with a rabbit = counts().rabbits, after 300 steps); `energy-positive`; `ids-initial` (rabbits 1..r0, foxes r0+1..); `ui-step` (clicking step makes the tick +1 and the DOM counts equal `counts()`) |
| **time** | `play-rate` (speed 10, 5 s of fake clock gives a tick in [49, 51]); `pause-stops`; `step-one`; `speed-change` (20 for 2 s gives +40±2); `speed-slider-dom`; `play-pause-toggle-keys` (Space) |
| **canvas** | `canvas-size` (W*10×H*10); `pixels-reset` (15 sampled cells match the state colours ±6); `pixels-after-step`; `pixels-after-reset-ui`; `fox-over-rabbit` |
| **chart** | `points-equal-history` (after 0, 50 and 120 steps); `monotone-y` (a higher count is drawn higher); `monotone-x`; `axes-labelled`; `chart-resets` |
| **data** | `csv-exact`; `csv-download` (the button's download equals `exportCSV()`); `scenario-roundtrip`; `scenario-defaults` (missing keys fall back); `scenario-bad-json` (returns false, the error is visible, the state is unchanged); `scenario-bad-version`; `scenario-ui-load` |
| **algo** | `state-50` (full cell hash for each case); `counts-100`; `counts-500`; `breed-ids` (the first child id is r0+f0+1); `extinction-foxes` (foxes0=0 stays 0); `extinction-all` (rabbitCost 99 gives 0 and 0, and stepping keeps working) |
| **layout** | `side-by-side-1280`; `stacked-600`; `no-hscroll-600`; `no-hscroll-390`; `canvas-fits-390` |
| **a11y** | `tab-reaches-controls` (play, pause, step, reset, speed and every param slider); `buttons-keyboard` (Enter on step); `sliders-labelled`; `announce-on-pause` ("Tick N: R rabbits, F foxes"); `shortcut-s`; `shortcut-r`; `focus-visible` |
| **persist** | `preset-save-reload`; `preset-list`; `preset-delete`; `preset-load-applies`; `corrupt-storage` (invalid JSON in the key, then the page loads with an empty list) |
| **domain** | `ode-values` (3 cases, rel tol 1e-6); `ode-steps-rounding` (t/dt not an integer); `eq-dom`; `drift-small` (V drift under 1e-4, t=50, dt=0.01); `ode-ui-run` (DOM outputs match `lab.ode`); `ode-chart` |

**Screenshots, with `--shots`:**
- `load.png` at 1280×900;
- `step200.png`;
- `phone.png` at 390×844;
- `ode.png` after `ode-run`.

- [ ] **Step 1: Install Playwright.** `npm init -y` in `$S`, then `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright`.
- [ ] **Step 2: Write `checks.mjs`, `params-dev.json` and the sealed parameters.**
  - **Dev:** seeds 7, 42, 2026; one 30×20 case; ODE cases (1.1, 0.4, 0.4, 0.1), (0.8, 0.2, 0.6, 0.15) and (1.5, 1.0, 3.0, 1.0).
  - **Sealed:** other seeds, sizes and ODE values.
- [ ] **Step 3: Reference passes 100% on both sets, 3 times in a row with identical results.** An empty page scores 0.
- [ ] **Step 4: Commit.** That covers `package.json`, the lock file, `checks.mjs`, `params-dev.json` and the sha256 file. `node_modules` is ignored.

### Task 4: Planted bugs

**Files:** `$S/make_bugs.py`, which writes `$B/bugs/{tick-order,breed-off-by-one,euler,no-label,csv-no-header}.html` from the reference by exact string replacement.

- [ ] **Step 1: Write `make_bugs.py`.** It fails if any target string isn't found exactly once.
- [ ] **Step 2: Run the checks on each variant.** Each must fail at least one check in its expected area (algo, algo, domain, a11y, data). Record the result in `$B/validation.md`.
- [ ] **Step 3: Commit.**

### Task 5: Ambiguity audit (owner-approved subagent)

- [ ] **Step 1: Dispatch one general-purpose subagent.**
  - It gets only `prompt.md`'s text, with the instruction to write the app to `C:\qwen3-forge-stage\oneshot-audit\audit.html`.
  - It must not read the repo, the reference or the checks.
- [ ] **Step 2: Run the dev checks on `audit.html`.**
  - For each exact-check failure, find the prompt wording that allows the audit's reading, and fix `prompt.md`.
  - Re-run on the reference (still 100%), then send the subagent the changed sentences and its failing behaviour. Repeat until the audit passes the algo, logic and domain checks.
- [ ] **Step 3: Log every wording change in `validation.md`, then commit.** The audit app is not committed.

### Task 6: Harness

**Files:**
- create `$S/oneshot_bench.py`;
- create `$S/deepseek.py`;
- create `$S/test_oneshot_bench.py`.

**`oneshot_bench.py` commands:**

| Command | Behaviour |
|---|---|
| `run --model keep96\|deepseek --seeds 1-5 --out RUNS` | Writes `RUNS/<model>/<seed>/response.md` and `meta.json` (tokens, seconds, model id, finish reason, reasoning) |
| `check --runs RUNS --params P [--shots]` | Extracts `plan.md` and `app.html` per build, runs `checks.mjs`, writes `checks-<set>.json` and the static report |
| `blind --runs RUNS --out BLIND --map MAP` | Copies each build's plan, app and screenshots to `BLIND/<random id>/`, writes the id→build map to `MAP` (kept outside the repo until judging is committed), shuffled |
| `report --runs RUNS --judge JUDGE.json --map MAP --out MD` | Writes the per-model and per-area check scores, the judged scores, the static report and the gallery |

**Details:**
- **keep96:**
  - `bestofn_tier2b.start_server` with `BON_EXTRA = ["--load-mode", "none", "-c", "65536"]` (the harness default is already b and ub 512);
  - `chat` with `max_tokens` 32768, temperature 0.2, top_p 0.95, the given seed, thinking off, and a timeout of 3,600 s.
- **DeepSeek:**
  - `deepseek.py` reads the key from `~/.local/share/opencode/auth.json` (`["opencode-go"]["key"]`) and never prints it;
  - it picks the model from `GET /models`, preferring an id containing `deepseek-v4.1-flash`, then `deepseek-v4-flash`;
  - it posts to `/chat/completions` with temperature 0.2 and `max_tokens` 32768, retrying once with 16384 on an HTTP 400 that mentions tokens. There are 3 retries with backoff on 429 and 5xx errors;
  - it stores `reasoning_content` if present.
- **Extraction:**
  - plan = the text from `## Plan` to the first code fence (or everything before the first fence);
  - app = the longest fenced block whose language is html or whose text contains `<html`;
  - otherwise, the text from `<!doctype`/`<html` to the end;
  - `truncated` = no `</html>`.
- **Tests:** extraction on 5 synthetic responses (fenced, unfenced, truncated, no plan, two blocks); area scoring (mean of areas); blinding (all ids unique, the map covers all builds, nothing in BLIND names a model).

- [ ] **Step 1: Write the tests and watch them fail.** **Step 2: Implement.** **Step 3: Run the tests and watch them pass.** **Step 4: Commit.**

### Task 7: Runs

- [ ] **Step 1: keep96.** Pause the Versutus gate and check that no llama-server is running, then run `run --model keep96 --seeds 1-5`. Restore the gate afterwards, even on failure.
- [ ] **Step 2: DeepSeek.** `run --model deepseek --seeds 1-5`; no GPU.
- [ ] **Step 3: Checks.** `check --params params-dev.json --shots` on all 10 builds. The sealed set waits for the verdict: it is run once after judging, and logged in `sealed-log.md`.
- [ ] **Step 4: Commit the runs** (local paths scrubbed) **and push before 01:00.**

### Task 8: Blind judging and the report

- [ ] **Step 1: Blind.** `blind`, with the map at `C:\qwen3-forge-stage\oneshot-sealed\blind-map.json`.
- [ ] **Step 2: Judge** each blinded build's plan, code and screenshots against `rubric.md`. Write `judge.json` with scores and a one-line reason per item, then commit it.
- [ ] **Step 3: Open the map,** run the sealed checks once (logged), then write the report.
  - The report is `docs/superpowers/specs/<date>-oneshot-results.md`, with its gallery in `docs/benchmarks/oneshot/gallery/`.
  - Then update the memory, and commit and push.
