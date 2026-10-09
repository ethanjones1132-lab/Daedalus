## Plan

### Data Model
- **World State**: A 2D grid of `Cell` objects. Each `Cell` contains `grass` (0-grassMax), a `rabbit` object `{id, energy}`, and a `fox` object `{id, energy}`.
- **Entities**: Rabbits and Foxes are objects with unique IDs (global counter).
- **History**: An array of objects `{tick, rabbits, foxes, grass}`.
- **Parameters**: A central object containing all 13 simulation and ODE variables.

### Tick Order
1. **Grass Growth**: All cells increment grass by 1 (capped at `grassMax`).
2. **Rabbit Phase**:
   - Sort alive rabbits by ID.
   - For each: Move (to empty neighbor), Eat (grass in current cell), Subtract cost, Breed (if energy $\ge$ threshold, place child in empty neighbor), Die (if energy $\le$ 0).
3. **Fox Phase**:
   - Sort alive foxes by ID.
   - For each: Move (prefer rabbit-occupied empty fox-free cells, else empty fox-free cells), Eat (if rabbit in current cell, remove it), Subtract cost, Breed (if energy $\ge$ threshold, place child in empty fox-free neighbor), Die (if energy $\le$ 0).
4. **Record**: Increment tick, calculate totals, push to history.

### Components
- **Simulation Engine**: Handles the logic, `mulberry32` RNG, and `lab` API.
- **Renderer**: Handles Canvas drawing (grass, rabbits, foxes) and SVG path generation for both population and ODE charts.
- **UI Controller**: Manages buttons, sliders, inputs, presets (localStorage), and the `announcer`.
- **ODE Solver**: Implements RK4 integration for the Lotka–Volterra equations.