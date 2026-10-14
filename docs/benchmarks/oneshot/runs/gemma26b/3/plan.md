## Plan

**Data Model**
- **State:** `tick` (int), `idCounter` (int), `rand` (function), `history` (array of objects), `params` (object).
- **Grid:** A 1D array of size `width * height`. Each cell contains `grass` (int), `rabbit` (object `{id, energy}` or `null`), and `fox` (object `{id, energy}` or `null`).
- **Parameters:** A flat object containing all 13 simulation constants.
- **Presets:** A `Map` stored in `localStorage` under `ecolab.presets`.

**Tick Order**
1. **Grass:** Increment every cell's grass level up to `grassMax`.
2. **Rabbits:** 
   - Identify rabbits alive at start of phase.
   - Sort by ID ascending.
   - For each: Move (to empty neighbor), Eat (gain energy from grass), Lose energy, Breed (if energy $\ge$ threshold, create child in empty neighbor), Die (if energy $\le$ 0).
3. **Foxes:**
   - Identify foxes alive at start of phase.
   - Sort by ID ascending.
   - For each: Move (prefer rabbit-containing neighbor, else empty), Eat (remove rabbit, gain energy), Lose energy, Breed (if energy $\ge$ threshold, create child in empty neighbor), Die (if energy $\le$ 0).
4. **Record:** Append `{tick, rabbits, foxes, grass}` to history.

**Components**
- **Simulation Engine:** Handles `reset`, `step`, and the `mulberry32` PRNG.
- **Renderer:** Canvas drawing logic for grass, rabbits, and foxes.
- **Chart Component:** SVG-based line charts for population history and ODE trajectories.
5. **UI Controller:** Manages DOM updates, sliders, playback loop (using `requestAnimationFrame`), and keyboard shortcuts.
6. **ODE Solver:** RK4 integrator for the Lotka–Volterra equations.
7. **Scenario/Preset Manager:** Handles JSON export/import and `localStorage` persistence.