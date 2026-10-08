## Plan

**Data Model**
- **Grid:** A 1D array of `grass` levels (integers).
- **Animals:** Two arrays (`rabbits`, `foxes`) containing objects `{id, x, y, energy}`.
- **State:** `tick` (integer), `idCounter` (integer), `history` (array of snapshots), `rand` (the `mulberry32` generator).
- **Parameters:** A single object containing all 13 simulation constants.

**Tick Order**
1. **Grass:** Increment every cell's grass up to `grassMax`.
2. **Rabbits:** 
   - Get current rabbits, sort by ID.
   - For each: Move (to empty neighbor), Eat (gain energy from grass), Lose energy, Breed (if energy $\ge$ threshold, create child in empty neighbor), Die (if energy $\le$ 0).
3. **Foxes:**
   - Get current foxes, sort by ID.
   - For each: Move (prefer rabbit, else empty), Eat (remove rabbit, gain energy), Lose energy, Breed (if energy $\ge$ threshold, create child in empty neighbor), Die (if energy $\le$ 0).
4. **Record:** Push `{tick, rabbits, foxes, grass}` to history.

**Components**
- **Simulation Engine:** Handles `reset`, `step`, and the `window.lab` API.
- **Renderer:** Canvas drawing for the grid and animals.
1. **Chart Component:** SVG-based line charts for population history and ODE trajectories.
2. **Control Panel:** Sliders, buttons, and inputs for simulation parameters and playback.
3. **ODE Panel:** RK4 integrator and UI for the Lotka–Volterra equations.
4. **Scenario/Preset Manager:** LocalStorage interface for saving/loading JSON scenarios.
5. **Accessibility Layer:** Keyboard listeners and `aria-live` announcer.