## Plan

**Data Model**
- Simulation state: grid (width×height cells, each with grass 0–grassMax), rabbits array (id, x, y, energy), foxes array (id, x, y, energy), shared id counter, seed, RNG generator, tick counter, history array.
- Parameters: 13 defaults merged with user overrides.
- `window.lab` exposes all required API methods sharing this state.

**Tick Order**
1. Grass regrows (+1 capped at grassMax).
2. Rabbits act (sorted by id): move, eat grass, breed, die.
3. Foxes act (sorted by id): move, eat rabbits, breed, die.
4. Increment tick, record history point.

**Components**
- Canvas renderer (`data-testid="world"`) drawing grass/rabbit/fox per cell.
- Controls: play/pause/step/reset buttons, seed/speed sliders, parameter sliders with labels.
- Counters: tick, rabbits, foxes, grass.
- Chart (`data-testid="chart"`) with polyline series for rabbits/foxes.
- Lotka–Volterra panel (`data-testid="ode-chart"`) with RK4 integration and derived values.
- Scenario tools: export/load JSON textarea, error display.
- Presets: save/load/delete with localStorage.
- Announcer (`aria-live="polite"`) for keyboard feedback.
- Responsive layout: side-by-side ≥1000px, stacked <700px.

---