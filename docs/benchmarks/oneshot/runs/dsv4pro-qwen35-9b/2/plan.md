## Plan

**Data Model:**
- **Grid:** 2D array of cells. Each cell holds `grass` (0 to `grassMax`), `rabbit` (object with `id`, `energy` or null), `fox` (object with `id`, `energy` or null).
- **Animals:** Array of objects `{id, x, y, energy}`. `id` is a global counter starting at 1.
- **State:** `tick` (current tick), `history` (array of `{tick, rabbits, foxes, grass}`), `rand` (Mulberry32 generator), `playing` (boolean), `speed` (ticks/sec).

**Tick Order:**
1. **Grass:** `grass = min(grassMax, grass + 1)` for all cells.
2. **Rabbits:** Iterate sorted by `id`. For each: Move (pick neighbor without rabbit), Eat (add `rabbitGain * grass`, set grass to 0), Cost (`energy -= rabbitCost`), Breed (if `energy >= rabbitBreed`, pick neighbor without rabbit, spawn child with `energy/2`, parent loses `child`), Die (if `energy <= 0`).
3. **Foxes:** Iterate sorted by `id`. For each: Move (prioritize neighbors with rabbit, then neighbors without fox), Eat (if cell has rabbit, remove it, add `foxGain`), Cost (`energy -= foxCost`), Breed (if `energy >= foxBreed`, pick neighbor without fox, spawn child, parent loses `child`), Die (if `energy <= 0`).
4. **Tick Increment:** `tick++`. Record history point.

**Components:**
- **Canvas:** Renders grid, grass, rabbits, foxes.
- **Chart:** SVG polyline for rabbit/fox populations over time.
- **Lotka-Volterra Panel:** RK4 integrator for ODEs, displaying trajectory and equilibrium points.
- **Controls:** Play/Pause/Step/Reset, Seed input, Speed slider, Parameter sliders.
- **Scenario Tools:** Export/Load JSON, CSV export.
- **Presets:** Save/Load/Delete from localStorage.