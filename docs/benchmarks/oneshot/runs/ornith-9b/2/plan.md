## Plan

**Data Model:**
- **Grid:** 2D array of cells. Each cell has `grass` (0..grassMax), and optional `rabbit`/`fox` objects `{id, energy}`.
- **Animals:** Array of objects `{id, x, y, energy, type}`. IDs are unique, shared counter.
- **State:** `tick`, `seed`, `params` (merged defaults), `history` array, `counts` object.
- **Randomness:** Single `mulberry32` generator instance, created on reset.

**Tick Order:**
1. **Grass:** All cells grow.
2. **Rabbits:** Sort by ID. For each: Move (pick empty neighbor), Eat (gain energy, clear grass), Cost (lose energy), Breed (if energy >= threshold, pick empty neighbor, spawn child), Die (if energy <= 0).
3. **Foxes:** Sort by ID. For each: Move (prefer rabbit-containing cells, then empty), Eat (if rabbit present, remove, gain energy), Cost, Breed, Die.
4. **Record:** Increment tick, push history point.

**Components:**
- **World Canvas:** Renders grid, rabbits, foxes.
- **Controls:** Play/Pause/Step/Reset buttons, speed slider, parameter sliders.
- **Counters:** Live tick, rabbit, fox, grass counts.
- **Chart:** SVG polyline for rabbit/fox populations over time.
- **Lotka-Volterra Panel:** RK4 integration, equations, drift calculation, mini chart.
- **Scenario Tools:** Export/Load JSON, error display.
- **Presets:** Save/Load/Delete from localStorage.
- **Announcer:** ARIA live region for keyboard users.

---