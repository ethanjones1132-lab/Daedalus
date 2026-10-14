## Plan

We will implement the Ecosystem Lab as a single-page web app. The simulation will run on a grid, where grass, rabbits, and foxes live. The app will chart the populations, compare them with the Lotka–Volterra equations, and let the user save and share scenarios.

### Data Model

The data model consists of the following components:

*   **Grid:** A 2D array of cells, where each cell has a grass level and can hold at most one rabbit and one fox.
*   **Animals:** Each animal has an ID, a position, and an energy level. IDs are shared between rabbits and foxes.
*   **History:** An array of history points, each containing the tick number, rabbit count, fox count, and total grass level.

### Tick Order

The simulation runs in the following order:

1.  **Grass:** Each cell's grass level increases by 1.
2.  **Rabbits:** Each rabbit moves to a random neighboring cell, eats grass, and possibly breeds or dies.
3.  **Foxes:** Each fox moves to a random neighboring cell, eats a rabbit, and possibly breeds or dies.
4.  **History:** A new history point is recorded with the current tick number, rabbit count, fox count, and total grass level.

### Components

The app will consist of the following components:

*   **Canvas:** A canvas element to display the simulation.
*   **Chart:** An SVG element to display the population chart.
*   **Lotka–Volterra panel:** A panel to display the Lotka–Volterra equations and their solutions.
*   **Scenario tools:** A panel to display the scenario tools, including the scenario JSON, export, and load buttons.
*   **Presets:** A panel to display the saved presets.
*   **Controls and counters:** A panel to display the controls and counters, including the play, pause, step, reset, and speed buttons.

## Code