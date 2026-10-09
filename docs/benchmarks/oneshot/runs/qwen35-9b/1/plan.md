## Plan

**Data Model:**
The app maintains a central state object containing:
1.  **Simulation State:** `tick`, `seed`, `params` (merged defaults), `history` (array of `{tick, rabbits, foxes, grass}`), `animals` (array of objects `{id, type, x, y, energy}`).
2.  **Grid State:** A 2D array representing cells, storing `grass` (0-4), `rabbit` (null or `{id, energy}`), and `fox` (null or `{id, energy}`).
3.  **UI State:** `isPlaying`, `speed`, `seedInput`, `sliderValues`.

**Tick Order:**
1.  **Grass:** Grow (`min(max, grass + 1)`).
2.  **Rabbits:** Iterate by ascending ID. For each: Move (pick neighbor without rabbit), Eat (gain energy, clear grass), Cost (lose energy), Breed (if energy high, pick neighbor without rabbit, spawn child), Die (if energy <= 0).
3.  **Foxes:** Iterate by ascending ID. For each: Move (prioritize neighbors with rabbit, then empty), Eat (if rabbit present, remove rabbit, gain energy), Cost (lose energy), Breed (if energy high, pick neighbor without fox, spawn child), Die (if energy <= 0).
4.  **History:** Record `{tick, count, sum}`.

**Components:**
1.  **Canvas:** Renders grid, rabbits (white), foxes (red).
2.  **Controls:** Play/Pause/Step/Reset buttons, Seed input, Speed slider, Parameter sliders.
3.  **Counters:** Display current tick and population counts.
4.  **Chart:** SVG polyline for Rabbit/Fox history.
5.  **Lotka-Volterra Panel:** Inputs for ODE parameters, Run button, Result display, ODE Chart.
6.  **Scenario Tools:** JSON textarea, Export/Load buttons, Error message.
7.  **Presets:** List of saved scenarios, Save/Delete buttons.