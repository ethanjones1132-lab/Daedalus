## Plan

**Data Model:**
The app maintains a single global state object. The world is a 2D grid (`width` x `height`) where each cell holds an integer `grass` level (0 to `grassMax`). Animals are objects with `{id, x, y, energy, type}`. A single counter tracks IDs. The simulation state includes a `tick` counter, a `history` array of snapshots, and a `running` boolean.

**Tick Order:**
1.  **Grass:** Every cell grows grass by 1 (capped at `grassMax`).
2.  **Rabbits:** Iterate rabbits by ascending ID. For each: Move (pick random empty neighbor), Eat (gain energy, set grass to 0), Lose energy, Breed (if energy >= threshold, pick random empty neighbor, spawn child), Die (if energy <= 0).
3.  **Foxes:** Iterate foxes by ascending ID. For each: Move (prefer neighbor with rabbit, then empty neighbor), Eat (if rabbit present, remove it, gain energy), Lose energy, Breed (if energy >= threshold, pick random empty neighbor, spawn child), Die (if energy <= 0).
4.  **Advance:** Increment tick, record history point.

**Components:**
-   **Canvas:** Renders the grid, grass levels, rabbits (white), and foxes (red).
-   **Controls:** Seed input, speed slider, parameter sliders (rabbits0, foxes0, rabbitBreed, foxBreed, foxGain, grassMax), Play/Pause/Step/Reset buttons.
-   **Counters:** Display current tick, rabbit count, fox count, total grass.
-   **Chart:** SVG polyline chart showing population history.
-   **Lotka-Volterra Panel:** Inputs for ODE parameters, Run button, and SVG chart of the trajectory.
-   **Scenario Tools:** Textarea for JSON, Export/Load buttons, Error message.
-   **Presets:** List of saved scenarios with Load/Delete buttons.

The app is a single HTML file with embedded CSS and JS. It uses `mulberry32` for randomness and implements RK4 for the ODE solver.