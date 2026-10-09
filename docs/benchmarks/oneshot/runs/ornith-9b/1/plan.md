## Plan

The app is a single-page simulation of a grass-rabbit-fox ecosystem on a grid, with population tracking, Lotka-Volterra comparison, and scenario management.

**Data Model:**
- **Grid:** 2D array of cells, each holding a grass level (0 to grassMax).
- **Animals:** Array of objects `{id, x, y, energy, type}`. Ids are globally unique, assigned from a shared counter.
- **State:** `tick`, `seed`, `params` (merged over defaults), `history` array.
- **Randomness:** `mulberry32` generator seeded once at reset.

**Tick Order:**
1. **Grass:** Grow all cells.
2. **Rabbits:** Sort by id. For each: Move (to empty neighbor), Eat (gain energy, clear grass), Cost (lose energy), Breed (if energy >= threshold), Die (if energy <= 0).
3. **Foxes:** Sort by id. For each: Move (prefer rabbit-containing cells, then empty), Eat (remove rabbit, gain energy), Cost, Breed, Die.
4. **Record:** Increment tick, record history point.

**Components:**
- **Canvas (`data-testid="world"`):** Renders grid, rabbits, foxes.
- **Controls:** Play/Pause/Step/Reset buttons, speed slider, parameter sliders, seed input.
- **Counters:** Live tick, rabbit, fox, grass counts.
- **Chart (`data-testid="chart"`):** SVG polyline for rabbit/fox populations over time.
- **Lotka-Volterra Panel:** RK4 integration, equation equilibrium display, drift calculation, mini chart.
- **Scenario Tools:** Export/Load JSON, CSV export.
- **Presets:** Save/Load/Delete from localStorage.
- **Announcer:** `aria-live="polite"` for keyboard users.

**Timing:** `requestAnimationFrame` loop with `performance.now()` delta to drive tick accumulation based on speed.