## Plan

**Data Model:**
The application maintains a central state object containing:
1.  **Simulation State:** `tick` (integer), `seed` (integer), `params` (object of 13 parameters), `history` (array of `{tick, rabbits, foxes, grass}`), `rng` (generator function), `animals` (array of objects `{id, type, x, y, energy}`).
2.  **World State:** A 2D array `grid` of size `width` x `height`. Each cell holds `{grass: int, rabbit: null|{id, energy}, fox: null|{id, energy}}`.
3.  **UI State:** `isPlaying` (boolean), `speed` (int), `announcerText` (string).

**Tick Order:**
1.  **Grass:** Iterate all cells, increment grass, cap at `grassMax`.
2.  **Rabbits:** Iterate alive rabbits (sorted by ID). For each: Move (to empty neighbor), Eat (gain energy, clear grass), Lose Energy, Breed (if energy high, place child in empty neighbor), Die (if energy <= 0).
3.  **Foxes:** Iterate alive foxes (sorted by ID). For each: Move (prioritize rabbit-containing neighbors, then empty), Eat (if rabbit present, remove rabbit, gain energy), Lose Energy, Breed (if energy high, place child in empty neighbor), Die (if energy <= 0).
4.  **History:** Increment tick, calculate totals, push to history.

**Components:**
1.  **Canvas (`#world`):** Renders grid, rabbits, and foxes.
2.  **Controls:** Play/Pause/Step/Reset buttons, Speed slider, Parameter sliders.
3.  **Counters:** Display current tick and population counts.
4.  **Chart (`#chart`):** SVG with polylines for Rabbit/Fox history.
5.  **Lotka-Volterra Panel:** Inputs for ODE parameters, Run button, Results display, ODE Chart.
6.  **Scenario Tools:** JSON export/import, Error message.
7.  **Presets:** Save/Load/Delete functionality using `localStorage`.