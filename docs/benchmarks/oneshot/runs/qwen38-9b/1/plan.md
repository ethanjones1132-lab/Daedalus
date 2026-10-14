## Plan

The application is a single HTML file containing CSS and JavaScript. It implements a discrete grid-based ecosystem simulation (grass, rabbits, foxes) with a custom random number generator, a Lotka-Volterra ODE integrator, and a full API exposed via `window.lab`.

**Data Model:**
- **State:** A 2D grid of cells (grass level 0–4), a list of Rabbit objects, and a list of Fox objects.
- **Tick:** A discrete time step.
- **History:** An array of snapshots `{tick, rabbits, foxes, grass}`.
- **Ode:** A separate state object for the Lotka-Volterra integrator.

**Tick Order:**
1. **Grass:** Grows.
2. **Rabbits:** Move, Eat, Lose Energy, Breed, Die.
3. **Foxes:** Move, Eat, Lose Energy, Breed, Die.
4. **Tick Increment:** Increment tick counter, record history.

**Components:**
- **Canvas:** Renders the grid, grass, rabbits, and foxes.
- **Chart:** An SVG overlay showing population history.
- **Controls:** Buttons for Play/Pause/Step/Reset, inputs for Seed/Speed, sliders for parameters.
- **Ode Panel:** Inputs for the Lotka-Volterra parameters and a button to run the RK4 integration.
- **Presets:** LocalStorage management for saving/loading scenarios.

**Rendering:**
- The canvas is rendered at a fixed internal resolution (width * 10, height * 10) and scaled via CSS.
- Grass is colored by height. Rabbits are white shapes; foxes are red shapes drawn over rabbits.

**API:**
- `window.lab` exposes `reset`, `step`, `counts`, `tick`, `cell`, `history`, `ode`, `exportCSV`, `exportScenario`, `loadScenario`.