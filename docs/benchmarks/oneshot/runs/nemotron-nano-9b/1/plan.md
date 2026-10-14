## Plan

### Data Model
The simulation is built around a grid of cells (`width` × `height`), each containing grass levels (0–`grassMax`), and possibly a rabbit or fox. Animals (rabbits and foxes) have unique IDs, positions, and energy levels. The state is updated in ticks, following a strict order: grass grows first, then rabbits process (move, eat, breed, die), then foxes (move, eat, breed, die). History tracks population counts and grass levels per tick. Parameters like `rabbits0`, `foxes0`, and energy thresholds are stored and merged with defaults during reset.

### Tick Order
1. **Grass Growth**: All cells increase grass by 1 (capped at `grassMax`).
2. **Rabbits**: Process each rabbit in ID order:
   - Move to a random empty neighbor (or stay).
   - Eat grass from current cell, reducing it to 0.
   - Lose energy (`rabbitCost`).
   - Breed if energy ≥ `rabbitBreed`, creating a child rabbit in a random empty neighbor.
   - Die if energy ≤ 0.
3. **Foxes**: Process each fox in ID order:
   - Move to a rabbit-containing or empty neighbor (prioritizing rabbits).
   - Eat a rabbit if present, gaining energy.
   - Lose energy (`foxCost`).
   - Breed if energy ≥ `foxBreed`, creating a child fox in a random empty neighbor.
   - Die if energy ≤ 0.

### Components
- **Simulation Engine**: Manages grid, animals, history, and parameter merging.
- **UI Controls**: Buttons (play/pause/step/reset), sliders for parameters, seed input.
- **Chart**: SVG polylines for rabbit/fox populations vs. ticks.
- **Lotka-Volterra Panel**: Inputs for equations, trajectory visualization.
- **Scenario Manager**: Save/load JSON scenarios via textarea and buttons.
- **Counters**: Display current tick and population counts.

---