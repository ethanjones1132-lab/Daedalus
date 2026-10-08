## Plan

1.  **Data Model**:
    *   `State`: Holds `grid` (2D array of objects), `rabbits` (Map of id -> {id, x, y, energy}), `foxes` (Map), `tick`, `seed`, `params`, `history` (array of snapshots).
    *   `Params`: Defaults merged with user inputs.
    *   `Randomness`: `mulberry32` seeded on reset.

2.  **Tick Order**:
    *   **Reset**: Init RNG, Grid (random grass), Rabbits (random spots), Foxes (random spots), Record history.
    *   **Step**:
        1.  **Grass**: Increment all cells to `grassMax`.
        2.  **Rabbits**: Sort by ID. Move (to empty neighbor), Eat (grass -> 0), Cost, Breed (split energy), Die (energy <= 0).
        3.  **Foxes**: Sort by ID. Move (prefer rabbit, else empty), Eat (remove rabbit), Cost, Breed, Die.
        4.  **Record**: Snapshot counts and total grass.

3.  **Components**:
    *   **World**: Canvas element, 10px/cell backing size.
    *   **Chart**: SVG element, polyline for populations.
    *   **ODE Panel**: SVG for Lotka-Volterra trajectory.
    *   **Controls**: Inputs for params, seed, speed. Buttons for play, pause, step, reset.
    *   **Scenario/Presets**: Textarea, buttons, localStorage integration.
    *   **Announcer**: Live region for accessibility.

4.  **API**: `window.lab` exposes `reset`, `step`, `counts`, `tick`, `cell`, `history`, `ode`, `exportCSV`, `exportScenario`, `loadScenario`.