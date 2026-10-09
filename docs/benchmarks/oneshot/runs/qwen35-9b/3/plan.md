## Plan

**Data Model:**
The application maintains a central state object containing:
- `grid`: A 2D array of objects `{grass: int, rabbit: null|{id, energy}, fox: null|{id, energy}}`.
- `rabbits`: Array of `{id, x, y, energy}`.
- `foxes`: Array of `{id, x, y, energy}`.
- `history`: Array of `{tick, rabbits, foxes, grass}`.
- `seed`: Integer.
- `tick`: Integer.
- `params`: Object holding the 13 simulation parameters.
- `rng`: The `mulberry32` generator function.
- `isPlaying`: Boolean.
- `speed`: Integer (ticks per second).
- `presets`: Object stored in `localStorage`.

**Tick Order:**
1. **Grass Growth:** Iterate grid, increment grass, cap at `grassMax`.
2. **Rabbits:** Sort by ID. For each rabbit: Move (to empty neighbor), Eat (gain energy, clear grass), Cost (lose energy), Breed (if energy high, spawn child), Die (if energy <= 0).
3. **Foxes:** Sort by ID. For each fox: Move (prioritize rabbit cells), Eat (if rabbit present), Cost (lose energy), Breed (if energy high, spawn child), Die (if energy <= 0).
4. **History:** Record current counts and total grass.

**Components:**
- **Canvas:** Renders the grid, grass levels, rabbits (white), and foxes (red).
- **Controls:** Play/Pause/Step/Reset buttons, Seed input, Speed slider, Parameter sliders.
- **Counters:** Display current tick and population counts.
- **Chart:** SVG polyline for Rabbit/Fox history.
- **Lotka-Volterra Panel:** Inputs for ODE parameters, Run button, Result display, ODE chart.
- **Scenario Tools:** JSON textarea, Export/Load buttons, Error message.
- **Presets:** List of saved scenarios with Load/Delete buttons.
- **Announcer:** `aria-live` region for keyboard accessibility.