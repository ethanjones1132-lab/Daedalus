## Plan

**Data Model:**
- **Grid:** 2D array of size `width × height`. Each cell stores `{grass: int, rabbit: {id, energy} | null, fox: {id, energy} | null}`.
- **Animals:** Array of objects `{id, x, y, energy, type}`. Ids are unique integers starting from 1, shared across both species.
- **State:** `{tick, seed, params, animals, grid, history}`.
- **History:** Array of `{tick, rabbits, foxes, grass}` snapshots recorded at the end of each tick.

**Tick Order:**
1. **Grass Growth:** Iterate all cells, increment grass, cap at `grassMax`.
2. **Rabbits:** Get sorted list of rabbits alive at start of phase. For each: Move → Eat → Cost → Breed → Die.
3. **Foxes:** Get sorted list of foxes alive at start of phase. For each: Move → Eat → Cost → Breed → Die.
4. **Record:** Increment tick, record history point.

**Components:**
- **Canvas (`data-testid="world"`):** Renders the grid with grass colors, rabbit shapes, and fox shapes.
- **Controls:** Play/Pause/Step/Reset buttons, speed slider, parameter sliders (rabbits0, foxes0, rabbitBreed, foxBreed, foxGain, grassMax), seed input.
- **Counters:** Live tick count, rabbit count, fox count, grass sum.
- **Chart (`data-testid="chart"`):** SVG polyline for rabbit and fox populations over time.
- **Lotka-Volterra Panel:** Inputs for ODE parameters, Run button, results display, and an SVG chart for the ODE trajectory.
- **Scenario Tools:** JSON textarea, Export/Load buttons, error message display.
- **Presets:** Save/Load/Delete functionality using `localStorage`.
- **Announcer:** `aria-live="polite"` element for keyboard shortcuts and state changes.

---