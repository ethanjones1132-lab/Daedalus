## Plan

**Data Model**
- Simulation state: grid (width×height cells, each with grass 0–grassMax), rabbits array (id, x, y, energy), foxes array (id, x, y, energy), shared id counter, seed, params (merged defaults), tick counter, history array.
- Params: 13 named parameters with defaults; updates merge over current values.
- RNG: single `mulberry32(seed)` generator; `pick(list)` uses `rand()` only when list non-empty.

**Tick Order**
1. Grass regrows: `grass = min(grassMax, grass + 1)` for every cell.
2. Rabbits act (sorted by ascending id): move to random empty-rabbit neighbour or stay; eat grass (set cell grass to 0, gain energy); lose cost; breed if energy ≥ threshold (place child in random empty-rabbit neighbour, reduce parent energy); die if energy ≤ 0.
3. Foxes act (sorted by ascending id): move to random rabbit-containing-no-fox neighbour, else random empty-fox neighbour, else stay; eat rabbit in current cell (remove rabbit, gain energy); lose cost; breed if energy ≥ threshold; die if energy ≤ 0.
4. Increment tick; record history point `{tick, rabbits, foxes, grass}` (grass = sum of all cell grass).

**Components**
- `reset(seed, params)`: merge params, init RNG/grid/animals/history, redraw.
- `step(n)`: run n ticks synchronously, update UI/chart/counters.
- `counts()`, `tick()`, `cell(x,y)`, `history()`, `ode(p,t,dt)`, `exportCSV()`, `exportScenario()`, `loadScenario()`: `window.lab` API methods.
- Canvas renderer (`data-testid="world"`): 10px cells, grass color, rabbit/fox shapes.
- Controls: play/pause/step/reset buttons, seed/speed/param sliders, counters.
- Chart (`data-testid="chart"`): SVG polyline series for rabbits/foxes.
- Lotka–Volterra panel (`data-testid="ode-chart"`): RK4 integration, trajectory polyline, derived values.
- Scenario tools: export/load JSON, error display, preset save/load/delete with localStorage.
- Presets UI: list of saved scenarios with load/delete buttons.
- Accessibility: keyboard shortcuts (Space toggle play, 's' step, 'r' reset), live announcer, visible focus rings.
- Responsive layout: two-column (≥1000px), stacked (<700px), no horizontal scroll below 360px.