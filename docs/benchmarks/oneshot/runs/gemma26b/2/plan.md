## Plan

**Data Model**
- **State:** `tick` (int), `idCounter` (int), `rand` (function), `history` (array of objects), `params` (object), `grid` (2D array of cells).
- **Cell:** `{ grass: int, rabbit: {id, energy} | null, fox: {id, energy} | null }`.
- **Animals:** Handled as objects within the grid cells.
- **Parameters:** A flat object containing all 13 simulation constants.

**Tick Order**
1. **Grass:** Increment every cell's grass up to `grassMax`.
2. **Rabbits:** 
   - Get list of rabbits alive at start of phase, sorted by ID.
   - For each: Move (to empty neighbor), Eat (gain energy from grass), Lose energy, Breed (if energy $\ge$ threshold, create child in empty neighbor), Die (if energy $\le$ 0).
3. **Foxes:**
   - Get list of foxes alive at start of phase, sorted by ID.
   - For each: Move (prefer rabbit, then empty), Eat (remove rabbit, gain energy), Lose energy, Breed (if energy $\ge$ threshold, create child in empty neighbor), Die (if energy $\le$ 0).
4. **Record:** Push `{tick, rabbits, foxes, grass}` to history.

**Components**
- **Simulation Engine:** Manages the `window.lab` API, the `mulberry32` generator, and the core loop.
- **Renderer:** Canvas drawing logic for the grid and animals.
- **Chart Component:** SVG-based line charts for population and ODE trajectories.
- **Control Panel:** UI for sliders, buttons, and the `announcer`.
- **ODE Solver:** RK4 implementation for the Lotka–Volterra equations.
- **Scenario Manager:** Handles JSON export/import and `localStorage` presets.