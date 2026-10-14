## Plan

**Data Model**: A `world` object holds the grid (grass level per cell), a `history` of past ticks, the `idCounter`, the `seed`, and the `params`. Each cell may hold at most one rabbit and one fox, each with `id` and `energy`.

**Tick Order**:
1. **Grass**: Increment all cells toward `grassMax`.
2. **Rabbits**: Sort by ID; for each rabbit: move to a neighbor with no rabbit; consume grass; lose energy; breed if energy ≥ `rabbitBreed`; remove if energy ≤ 0.
3. **Foxes**: Sort by ID; for each fox: move to a rabbit-containing neighbor without a fox, else a fox-free neighbor; consume rabbit if present; lose energy; breed if energy ≥ `foxBreed`; remove if energy ≤ 0.
4. **Record**: Append `{tick, rabbits, foxes, grass}`.

**Components**:
- **World**: Canvas rendering grass (color from grass level), rabbits (white), foxes (orange).
- **Chart**: SVG polyline for rabbit/fox populations over time.
- **ODE**: RK4 integrator for Lotka–Volter; calculates trajectory, equilibrium points, and drift.
- **Scenario**: JSON export/load with validation; preset list from `localStorage`.
- **UI**: Counters, parameter sliders, play/pause/step/reset, CSV export, announcer, keyboard shortcuts.