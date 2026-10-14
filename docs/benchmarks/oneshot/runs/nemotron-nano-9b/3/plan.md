## Plan

### Data Model
The simulation is grid-based with `width` × `height` cells. Each cell tracks grass levels (0–`grassMax`) and may contain at most one rabbit and one fox. Animals (rabbits/foxes) have unique IDs, positions, and energy. Grass grows by 1 per tick (capped at `grassMax`). Rabbits move to empty cells, eat grass (gaining energy), breed if energy ≥ `rabbitBreed`, and die if energy ≤ 0. Foxes move to cells with rabbits or empty cells, eat rabbits (gaining energy), breed if energy ≥ `foxBreed`, and die if energy ≤ 0. The history records population counts (rabbits, foxes, total grass) per tick.

### Tick Order
1. **Grass Growth**: All cells increase grass by 1 (capped).
2. **Rabbit Actions**: Process rabbits in ID order: move, eat, breed, die.
3. **Fox Actions**: Process foxes in ID order: move, eat, breed, die.
Each tick updates the grid and records population counts.

### Components
1. **Canvas (`<canvas data-testid="world">`)**: Renders the grid with grass, rabbits, and foxes.
2. **Population Chart (`<svg data-testid="chart">`)**: Plots rabbit/fox counts over ticks.
3. **Parameter Sliders**: Adjust `rabbits0`, `foxes0`, `rabbitBreed`, etc.
4. **Controls**: Play/Pause, Step, Reset buttons.
5. **Scenario Tools**: Save/load scenarios as JSON.
6. **Lotka-Volterra Panel**: Inputs for equations and trajectory visualization.
7. **Counters**: Display current tick and population counts.

---