Here is the plan for the Ecosystem Lab application.

### Data Model
- **Grid**: A 2D array of cells, each containing `grass` (int), `rabbit` (obj/null), `fox` (obj/null).
- **Animals**: Rabbits and Foxes are stored in separate lists (`rabbits`, `foxes`) with `id`, `energy`, `x`, `y`.
- **Simulation State**: `seed`, `params`, `tick`, `rand` generator, `history` array.
- **Lotka-Volterra**: Uses RK4 integration for 4-point interpolation.

### Tick Order
1. Grass increases.
2. Rabbits move, eat, breed, die.
3. Foxes move, eat, breed, die.
4. Record history.

### Components
- **World Panel**: Canvas for grid, controls for simulation, counters.
- **Side Panel**: Chart for populations, Lotka-Volterra solver, Scenario/CSV export, Presets.
- **API**: Exposed via `window.lab`.