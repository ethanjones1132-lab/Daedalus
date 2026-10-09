## Plan

**Data Model:**
- `grid`: A 2D array of objects containing `grass` (0-grassMax) and `rabbit`/`fox` objects (or `null`).
- `animals`: A flat array of objects `{id, x, y, energy, type}`.
- `history`: An array of `{tick, rabbits, foxes, grass}`.
- `params`: A central object holding all 13 simulation parameters.
- `rand`: A `mulberry32` generator instance.

**Tick Order:**
1. **Grass Growth:** Increment all cells by 1, cap at `grassMax`.
2. **Rabbit Phase:** Sort by ID. For each:
   - Move to random neighbor with no rabbit.
   - Eat grass (gain energy, set cell grass to 0).
   - Deduct `rabbitCost`.
   - Breed: If energy $\ge$ `rabbitBreed`, place child in random neighbor with no rabbit.
   - Die: Remove if energy $\le$ 0.
3. **Fox Phase:** Sort by ID. For each:
   - Move to neighbor with rabbit and no fox (priority), else neighbor with no fox.
   - Eat: If cell has rabbit, remove rabbit and gain `foxGain`.
   - Deduct `foxCost`.
   - Breed: If energy $\ge$ `foxBreed`, place child in random neighbor with no fox.
   - Die: Remove if energy $\le$ 0.
4. **Record:** Update `tick` and push history.

**Components:**
- **World Canvas:** Renders grid, rabbits (white), and foxes (orange).
- **Population Chart:** SVG polyline for rabbits and foxes over time.
- **Lotka-Volterra Panel:** Inputs for ODE params, RK4 solver, and a secondary SVG chart.
- **Scenario/Preset Tools:** JSON text area, CSV export, and LocalStorage-backed preset management.
- **Controls:** Play/Pause/Step/Reset, Speed slider, and 6 parameter sliders.
- **Announcer:** ARIA-live region for status updates.