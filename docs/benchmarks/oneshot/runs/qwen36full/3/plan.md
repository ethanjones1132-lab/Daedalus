## Plan

**Data Model:**
- **Grid:** A 1D array of size `width * height`. Each element is an object `{ grass: number, rabbit: object|null, fox: object|null }`.
- **Animals:** Objects `{ id: number, energy: number, x: number, y: number }`. Stored in `rabbits` and `foxes` arrays.
- **State:** `seed`, `tick`, `params` (merged defaults), `rand` (mulberry32), `history` (array of snapshots).

**Tick Order:**
1. **Grass Growth:** Increment grass in every cell, capped at `grassMax`.
2. **Rabbits:** Sort by ID. For each: Move (to empty neighbor), Eat (grass=0), Cost, Breed (if energy high), Die (if energy <= 0).
3. **Foxes:** Sort by ID. For each: Move (prefer rabbit, else empty), Eat (remove rabbit), Cost, Breed (if energy high), Die (if energy <= 0).
4. **Record:** Snapshot counts and total grass.

**Components:**
- **World:** Canvas rendering the grid, animals, and colors.
- **Controls:** Inputs for seed, speed, and parameters. Buttons for play, pause, step, reset.
- **Counters:** Display tick, rabbit count, fox count, grass sum.
- **Chart:** SVG line chart for population history.
- **ODE Panel:** Inputs for Lotka-Volterra parameters, RK4 solver, and result chart.
- **Scenario/Presets:** JSON export/import and local storage management.
- **Announcer:** Live region for accessibility.