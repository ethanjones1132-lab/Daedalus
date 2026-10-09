## Plan

### Data Model

- The world is a grid of `width` × `height` cells.
- Each cell has an integer grass level from 0 to `grassMax`.
- A cell holds at most one rabbit and at most one fox.
- Every animal has an `id`, a position and an integer `energy`.
- Ids come from a shared counter, starting at 1 and increasing by 1 for every animal created.

### Tick Order

1. Grass: every cell's grass becomes `min(grassMax, grass + 1)`.
2. Rabbits: for each rabbit:
   - Move: take the neighbours with no rabbit. If there are any, move to `pick(those)`. Otherwise stay.
   - Eat: `energy += rabbitGain * grass` of its cell, then set that cell's grass to 0.
   - `energy -= rabbitCost`.
   - Breed: if `energy >= rabbitBreed`, take the neighbours (of its current cell) with no rabbit. If there are any:
      - `spot = pick(those)`;
      - `child = Math.floor(energy / 2)`;
      - the parent's energy drops by `child`;
      - a new rabbit with the next id and energy `child` is placed at `spot`.
   - Die: if `energy <= 0`, the rabbit is removed.
3. Foxes: for each fox:
   - Move: take the neighbours that contain a rabbit and no fox. If there are any, move to `pick(those)`;
      - otherwise take the neighbours with no fox. If there are any, move to `pick(those)`;
      - otherwise stay.
   - Eat: if the fox's cell now contains a rabbit, remove that rabbit and `energy += foxGain`.
   - `energy -= foxCost`.
   - Breed: if `energy >= foxBreed`, take the neighbours with no fox. If there are any:
      - `spot = pick(those)`;
      - `child = Math.floor(energy / 2)`;
      - the parent's energy drops by `child`;
      - a new fox with the next id and energy `child` is placed at `spot`.
   - Die: if `energy <= 0`, the fox is removed.
4. `tick += 1`. Record a history point `{tick, rabbits, foxes, grass}`, where `grass` is the **sum** of all cells' grass levels and the others are the numbers alive.

### Components

- `reset(seed, params = {})`: resets the world with the given seed and parameters.
- `step(n = 1)`: runs `n` ticks synchronously, then updates the canvas, chart and counters once.
- `counts()`: `{rabbits, foxes, grass}` for the current tick (grass = sum of levels).
- `tick()`: the current tick number.
- `cell(x, y)`: `{grass, rabbit, fox}`, where `rabbit` and `fox` are each `{id, energy}` or `null`.
- `history()`: an array of `{tick, rabbits, foxes, grass}`, one per recorded tick, starting with tick 0.
- `ode(p, t, dt)`: `p = {alpha, beta, gamma, delta, x0, y0}`. Integrate the Lotka–Volterra equations from (x0, y0) with `n = Math.round(t / dt)` classic RK4 steps of size `dt`. Returns `{x, y}` after the last step.
- `exportCSV()`: the population history as CSV.
- `exportScenario()`: a JSON **string** of `{"version": 1, "seed": <current seed>, "params": <all 13 current parameters>}`.
- `loadScenario(text)`: parses the JSON string. **Valid:** `version === 1` and `seed` is an integer. Then reset with that seed and params, where missing params use the defaults, clear the error message, and return `true`. **Invalid** (bad JSON, wrong version, or missing or non-integer seed): show an error message, change nothing, and return `false`.

## Ecosystem Lab