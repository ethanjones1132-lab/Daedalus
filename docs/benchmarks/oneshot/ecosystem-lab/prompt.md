Build **Ecosystem Lab**: a single-page web app where grass, rabbits and foxes live on a grid. It shows the simulation, charts the populations, compares them with the Lotka–Volterra equations, and lets the user save and share scenarios.

Respond with exactly two things, in this order:
1. A section headed `## Plan`, at most 400 words: your data model, the tick order, and the list of components.
2. The complete app as **one** ```html code block: a single self-contained file with inline CSS and JavaScript. No libraries, CDNs, fonts, images or network requests of any kind. Write nothing after the code block.

Follow every rule below exactly. An automated test suite checks the app through the `window.lab` API and the `data-testid` attributes named here.

---

## 1. Parameters

| Name | Default | Meaning |
|---|---|---|
| `width` | 40 | Grid columns |
| `height` | 30 | Grid rows |
| `grassMax` | 5 | Maximum grass level of a cell |
| `rabbits0` | 60 | Rabbits placed at reset |
| `foxes0` | 8 | Foxes placed at reset |
| `rabbitStart` | 6 | Energy of each rabbit placed at reset |
| `rabbitGain` | 1 | Energy a rabbit gains per grass unit eaten |
| `rabbitCost` | 1 | Energy a rabbit loses per tick |
| `rabbitBreed` | 12 | Energy at which a rabbit breeds |
| `foxStart` | 12 | Energy of each fox placed at reset |
| `foxGain` | 8 | Energy a fox gains per rabbit eaten |
| `foxCost` | 1 | Energy a fox loses per tick |
| `foxBreed` | 20 | Energy at which a fox breeds |

Any parameter object passed to the app is merged over these **defaults**, not over the current values.

## 2. Randomness

Use exactly this generator, and only this one. Do not use `Math.random` anywhere in the simulation.

```js
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- `reset` creates one generator, `rand = mulberry32(seed)`. Every random choice in the world, from that reset on, draws from this single stream, in the order the rules below describe.
- `pick(list)` means `list[Math.floor(rand() * list.length)]`. It draws exactly one number **only if the list is non-empty**. With an empty list it draws nothing.

## 3. The world

- **Grid:** `width` × `height` cells. `x` runs from 0 (left) to `width - 1`, and `y` from 0 (top) to `height - 1`.
- **Cell contents:** each cell has an integer grass level from 0 to `grassMax`. A cell holds **at most one rabbit and at most one fox**. A rabbit and a fox may share a cell.
- **Animals:** every animal has an `id`, a position and an integer `energy`. Ids come from **one counter shared by rabbits and foxes**, starting at 1 and increasing by 1 for every animal created, including children.
- **Neighbours:** the neighbours of cell (x, y) are, **in this order**: up (x, y−1), right (x+1, y), down (x, y+1), left (x−1, y). Only cells inside the grid count; the grid does not wrap. Every list of neighbours below is this list, filtered and in this order.
- **Row-major order:** for `y` from 0 up, and within each row for `x` from 0 up.

### Reset: `reset(seed, params)`

1. Merge the params over the defaults. Set `rand = mulberry32(seed)`, `tick = 0`, the id counter to 1, and empty the history.
2. **Grass:** in row-major order, set each cell's grass to `Math.floor(rand() * (grassMax + 1))`.
3. **Rabbits:** repeat `rabbits0` times:
   - list every cell with no rabbit, in row-major order;
   - `pick` one;
   - create a rabbit there with the next id and energy `rabbitStart`.
4. **Foxes:** repeat `foxes0` times:
   - list every cell with no fox, in row-major order;
   - `pick` one;
   - create a fox there with the next id and energy `foxStart`.
5. Record the history point for tick 0 (see section 3, the end of the tick), then redraw.

### One tick

1. **Grass:** every cell's grass becomes `min(grassMax, grass + 1)`.
2. **Rabbits.** Take the rabbits alive at the start of this phase, sorted by ascending id. Rabbits born during this phase are not in the list and don't act this tick. For each rabbit:
   1. **Move:** take the neighbours with no rabbit. If there are any, move to `pick(those)`. Otherwise stay.
   2. **Eat:** `energy += rabbitGain * grass` of its cell, then set that cell's grass to 0.
   3. `energy -= rabbitCost`.
   4. **Breed:** if `energy >= rabbitBreed`, take the neighbours (of its current cell) with no rabbit. If there are any:
      - `spot = pick(those)`;
      - `child = Math.floor(energy / 2)`;
      - the parent's energy drops by `child`;
      - a new rabbit with the next id and energy `child` is placed at `spot`.

      With no free neighbour, nothing happens and nothing is drawn.
   5. **Die:** if `energy <= 0`, the rabbit is removed.
3. **Foxes.** Take the foxes alive at the start of this phase, sorted by ascending id. Foxes born during this phase don't act this tick. For each fox:
   1. **Move:**
      - take the neighbours that contain a rabbit and no fox. If there are any, move to `pick(those)`;
      - otherwise take the neighbours with no fox. If there are any, move to `pick(those)`;
      - otherwise stay.
   2. **Eat:** if the fox's cell now contains a rabbit, remove that rabbit and `energy += foxGain`.
   3. `energy -= foxCost`.
   4. **Breed:** if `energy >= foxBreed`, take the neighbours with no fox. If there are any:
      - `spot = pick(those)`;
      - `child = Math.floor(energy / 2)`;
      - the parent's energy drops by `child`;
      - a new fox with the next id and energy `child` is placed at `spot`.
   5. **Die:** if `energy <= 0`, the fox is removed.
4. `tick += 1`. Record a history point `{tick, rabbits, foxes, grass}`, where `grass` is the **sum** of all cells' grass levels and the others are the numbers alive.

## 4. The `window.lab` API

Expose exactly these methods on `window.lab`. The UI must use the same simulation, so the API and the UI never disagree.

| Method | Behaviour |
|---|---|
| `reset(seed, params = {})` | As in section 3. Clears the chart, redraws, returns `counts()`. |
| `step(n = 1)` | Runs `n` ticks synchronously, then updates the canvas, chart and counters once. Returns `counts()`. |
| `counts()` | `{rabbits, foxes, grass}` for the current tick (grass = sum of levels). |
| `tick()` | The current tick number. |
| `cell(x, y)` | `{grass, rabbit, fox}`, where `rabbit` and `fox` are each `{id, energy}` or `null`. |
| `history()` | An array of `{tick, rabbits, foxes, grass}`, one per recorded tick, starting with tick 0. |
| `ode(p, t, dt)` | `p = {alpha, beta, gamma, delta, x0, y0}`. Integrate the Lotka–Volterra equations from (x0, y0) with `n = Math.round(t / dt)` classic RK4 steps of size `dt`. Returns `{x, y}` after the last step. |
| `exportCSV()` | The population history as CSV (section 7). |
| `exportScenario()` | A JSON **string** of `{"version": 1, "seed": <current seed>, "params": <all 13 current parameters>}`. |
| `loadScenario(text)` | Parses the JSON string. **Valid:** `version === 1` and `seed` is an integer. Then reset with that seed and params, where missing params use the defaults, clear the error message, and return `true`. **Invalid** (bad JSON, wrong version, or missing or non-integer seed): show an error message, change nothing, and return `false`. |

When the page loads, call `reset(42, {})` and show 42 in the seed input.

## 5. Rendering (`<canvas data-testid="world">`)

- **Backing size:** set the canvas's backing size to exactly `width * 10` by `height * 10` pixels. Do not scale it for `devicePixelRatio`. CSS may scale how it is displayed.
- **Grass:** each cell (x, y) is a 10 × 10 square at (x·10, y·10), filled `rgb(30, G, 30)` where `G = 60 + Math.round(160 * grass / grassMax)`.
- **Rabbit:** a filled shape centred in its cell, covering at least the cell's central 4 × 4 pixels, in `rgb(240, 240, 240)`.
- **Fox:** the same, in `rgb(220, 80, 20)`, drawn **over** a rabbit in the same cell.
- **When to redraw:** after every reset, after every `step`, and on every tick while playing.

## 6. Controls and counters

All of these are native elements, with the given `data-testid`s.

**Buttons:**

| `data-testid` | Action |
|---|---|
| `play` | Start playing |
| `pause` | Stop playing |
| `step` | Run exactly one tick |
| `reset` | Reset with the seed input's value and the current slider values; other parameters take their defaults |

**Inputs:**
- `seed`: a number input.
- `speed`: a range, 1–60 ticks per second, default 10.
- **Parameter sliders.** Each is a range input with a visible `<label for>` and its current value shown beside it. They take effect at the next reset.

  | `data-testid` | Range |
  |---|---|
  | `param-rabbits0` | 0–300 |
  | `param-foxes0` | 0–60 |
  | `param-rabbitBreed` | 2–40 |
  | `param-foxBreed` | 2–60 |
  | `param-foxGain` | 1–30 |
  | `param-grassMax` | 1–10 |

**Counters** (text is the plain integer): `tick`, `count-rabbits`, `count-foxes`, `count-grass`. They always show the current state.

**Timing.**
- While playing, the simulation advances `speed` ticks per second of **elapsed time**: after T seconds of play, about `T × speed` ticks have run.
- Measure elapsed time with timers or `requestAnimationFrame` plus timestamps. Don't assume a frame rate.
- Changing the speed while playing takes effect immediately.
- Pausing stops ticks completely.

## 7. Population chart and data

**Chart:** `<svg data-testid="chart">` contains:
- `<polyline data-testid="series-rabbits">` and `<polyline data-testid="series-foxes">`, each with **exactly one point per history entry**, in tick order;
- x increasing with tick, and a larger count drawn higher;
- axis labels with the text `tick` (x axis) and `count` (y axis).

A reset leaves one point per series.

**CSV:**
- `exportCSV()` returns the header line `tick,rabbits,foxes,grass`, then one line per history entry (for example `12,57,9,2810`).
- Lines are joined with `\n`, and the text ends with a single `\n`.
- The button `csv-export` downloads that exact text as `ecolab.csv`.

**Scenario:**

| `data-testid` | Element | Behaviour |
|---|---|---|
| `scenario-json` | textarea | Holds a scenario's JSON |
| `scenario-export` | button | Fills the textarea with `exportScenario()` |
| `scenario-load` | button | Calls `loadScenario` on the textarea's text |
| `scenario-error` | message | Shows the error text when loading fails; empty otherwise |

## 8. Lotka–Volterra panel

- **Equations:** dx/dt = αx − βxy, dy/dt = δxy − γy.
- **Inputs:** `ode-alpha` (1.1), `ode-beta` (0.4), `ode-gamma` (0.4), `ode-delta` (0.1), `ode-x0` (10), `ode-y0` (10), `ode-t` (50), `ode-dt` (0.01).
- **The button `ode-run`:**
  - computes the trajectory with the same RK4 as `lab.ode`;
  - shows `ode-x` and `ode-y`, the final values, with at least 8 significant digits;
  - shows `ode-eq-x` = γ/δ and `ode-eq-y` = α/β;
  - shows `ode-drift` = |V(end) − V(start)|, where V(x, y) = δx − γ ln x + βy − α ln y, as a number `parseFloat` can read;
  - draws `<svg data-testid="ode-chart">`, containing `<polyline data-testid="ode-series-x">` and `<polyline data-testid="ode-series-y">`.

## 9. Presets

- **Saving:** an input `preset-name` and a button `preset-save`. Saving stores the current scenario object under that name in `localStorage["ecolab.presets"]`, a JSON object mapping each name to a scenario.
- **The list:** `preset-list` holds one `preset-item` per saved preset. Each item shows the preset's name, plus a `preset-load` button (loads that scenario) and a `preset-delete` button (removes it from the list and from storage).
- **On page load,** show the saved presets. If the stored value is missing or isn't valid JSON, start with an empty list and don't crash.

## 10. Accessibility and keyboard

- Every control can be reached with Tab and operated from the keyboard. Buttons are `<button>` elements.
- Focus is clearly visible: an outline or ring on the focused control.
- **The announcer:** an element `announcer` with `aria-live="polite"`. When play is paused, set its text to exactly `Tick N: R rabbits, F foxes`, for example `Tick 37: 52 rabbits, 7 foxes`.
- **Shortcuts,** active when focus is **not** in a text input, number input or textarea:
  - Space toggles play and pause;
  - `s` runs one tick;
  - `r` resets the way the `reset` button does.

## 11. Layout

- **Regions:** `panel-world` holds the canvas, controls and counters. `panel-side` holds the chart, the Lotka–Volterra panel, the scenario tools and the presets.
- **Viewport 1000 px wide or more:** the two regions sit side by side, with `panel-side` to the right and their tops within 40 px of each other.
- **Viewport under 700 px:** `panel-side` sits below `panel-world`.
- **No horizontal scrolling at any width down to 360 px.** The canvas scales down with CSS to fit.

Make it look and work like a polished small tool: clear grouping, readable labels, sensible spacing.
