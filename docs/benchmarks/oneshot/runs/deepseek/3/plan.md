## Plan

**Data model**
- `params`: merge of `DEFAULTS` (13 keys) with the object passed to `reset`; stored alongside `currentSeed`.
- World arrays sized `W*H` (index `y*W+x`): `grass` (ints), `rGrid`/`fGrid` (animal object or `null`, ≤1 of each per cell).
- Animals: `{id, x, y, energy, alive}` in `rabbits` / `foxes` arrays; one shared id counter starting at 1.
- `hist`: `{tick, rabbits, foxes, grass}` per recorded tick, starting at tick 0.
- Single `rand = mulberry32(seed)` stream, re-created per reset; `pick` draws one number only for non-empty lists.

**Tick order**
1. All grass `+1` capped at `grassMax`.
2. Rabbits (snapshot sorted by id): move to a random rabbit-free neighbour → eat `rabbitGain*grass`, zero the cell → `−rabbitCost` → breed if `energy ≥ rabbitBreed` (random fox/rabbit-free neighbour, child `floor(e/2)`) → die if `energy ≤ 0`.
3. Foxes (snapshot sorted by id): move to a neighbour with a rabbit else any fox-free neighbour → eat rabbit in cell (`+foxGain`) → `−foxCost` → breed if `energy ≥ foxBreed` → die if `energy ≤ 0`.
4. `tick++`, push history point, redraw.

**Components**
- Sim core: `resetSim`, `doTick`, helpers (`neighbours`, `pick`, `add/kill`), `counts`, `cell`, `history`, CSV/scenario export/import, `integrateODE` (classic RK4) + `lab.ode`.
- Render: canvas painter (grass `rgb(30,G,30)`, rabbit white, fox orange on top), population SVG chart (two polylines, one point per entry), ODE SVG chart.
- UI: play/pause/step/reset buttons, seed + speed inputs, 6 param sliders with value readouts, 4 counters, ODE input grid + readouts (x, y, equilibria, drift), scenario textarea/buttons/error, preset save/list/load/delete (localStorage `ecolab.presets`).
- Behaviour: rAF elapsed-time pacing, keyboard shortcuts (Space/`s`/`r`) suppressed while a form control is focused, `aria-live` announcer, responsive two-region flex layout (side-by-side ≥1000 px, stacked below 700 px).