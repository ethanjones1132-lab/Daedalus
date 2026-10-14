## Plan

**Data Model:**
- `grid`: A 2D array of objects containing `grass` (0-grassMax) and `rabbit`/`fox` objects (or null).
- `animals`: A flat array of objects `{id, x, y, energy, type}`.
- `history`: An array of `{tick, rabbits, foxes, grass}`.
- `params`: A central object holding all 13 simulation parameters.
- `rand`: A `mulberry32` generator instance.

**Tick Order:**
1. **Grass Growth:** Increment all cells by 1, cap at `grassMax`.
2. **Rabbit Phase:** Sort by ID. For each:
   - Move to random empty neighbor (or stay).
   - Eat grass at current cell (set to 0, gain energy).
   - Subtract `rabbitCost`.
   - Breed: If energy $\ge$ `rabbitBreed`, find empty neighbor, split energy, create child.
   - Die: Remove if energy $\le$ 0.
3. **Fox Phase:** Sort by ID. For each:
   - Move to neighbor with rabbit and no fox (priority), else neighbor with no fox (priority), else stay.
   - Eat: If cell has rabbit, remove rabbit, gain `foxGain`.
   - Subtract `foxCost`.
   - Breed: If energy $\ge$ `foxBreed`, find empty neighbor, split energy, create child.
   - Die: Remove if energy $\le$ 0.
4. **Record:** Update `tick` and push to `history`.

**Components:**
- **World Canvas:** Renders grass (rects), rabbits (circles/shapes), and foxes (overlaid).
- **Stats Bar:** Real-time counters for tick, rabbits, foxes, grass.
- **Simulation Controls:** Play/Pause, Step, Reset, Seed input, Speed slider.
- **Parameter Panel:** Sliders for all 13 variables.
- **Population Chart:** SVG polyline for rabbits and foxes.
- **Lotka-Volterra Panel:** Inputs for ODE constants, RK4 solver, and a secondary SVG chart.
- **Scenario/Preset Tools:** JSON editor, CSV export, and LocalStorage-backed preset list.
- **Announcer:** ARIA-live region for status updates.