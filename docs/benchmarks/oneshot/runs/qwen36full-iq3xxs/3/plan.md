## Plan

**Data Model:**
The state is encapsulated in a `Simulation` object.
- `grid`: A 1D array of size `width * height`. Each cell is an object `{ grass, rabbit: {id, energy}, fox: {id, energy} }`.
- `animals`: A Map of `id` to `{ type: 'rabbit'|'fox', energy, x, y }`. This allows O(1) lookup and removal.
- `params`: Merged configuration (defaults + user overrides).
- `history`: Array of `{tick, rabbits, foxes, grass}` snapshots.
- `rng`: The Mulberry32 generator instance.

**Tick Order:**
1. **Grass Growth:** Iterate all cells, increment grass level (capped at `grassMax`).
2. **Rabbits:**
   - Collect all rabbits sorted by ID.
   - For each: Move (pick empty neighbor), Eat (consume grass, gain energy), Reproduce (if energy high, spawn child in empty neighbor, split energy), Die (if energy <= 0).
3. **Foxes:**
   - Collect all foxes sorted by ID.
   - For each: Move (prefer rabbit neighbor, else empty neighbor), Eat (if rabbit present, kill and gain energy), Reproduce (if energy high), Die.
4. **Record:** Increment tick counter, push snapshot to history.

**Components:**
1. **`window.lab` API:** Exposes `reset`, `step`, `counts`, `tick`, `cell`, `history`, `ode`, `exportCSV`, `exportScenario`, `loadScenario`.
2. **`WorldView`:** Renders the grid on `<canvas data-testid="world">`.
3. **`ChartView`:** Renders population history on `<svg data-testid="chart">`.
4. **`OdeView`:** Renders Lotka-Volterra trajectory on `<svg data-testid="ode-chart">`.
5. **`Controls`:** Inputs for parameters, seed, speed, and buttons (Play, Pause, Step, Reset, Save, Load).
6. **`Announcer`:** Live region for accessibility updates.

---