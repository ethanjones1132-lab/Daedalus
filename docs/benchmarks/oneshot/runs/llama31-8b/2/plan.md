## Plan

The Ecosystem Lab is a single-page web app that simulates the interactions between grass, rabbits, and foxes on a grid. The simulation is based on the Lotka-Volterra equations and allows users to save and share scenarios.

### Data Model

The data model consists of the following components:

* **Grid:** A 2D array of cells, where each cell has a grass level, a rabbit, and a fox.
* **Rabbits:** Each rabbit has an ID, a position, and an energy level.
* **Foxes:** Each fox has an ID, a position, and an energy level.
* **History:** An array of objects, where each object represents a tick in the simulation and contains the number of rabbits, foxes, and grass.

### Tick Order

The tick order is as follows:

1. Grass: Each cell's grass level increases by 1.
2. Rabbits: Each rabbit moves to a neighboring cell, eats grass, breeds, or dies.
3. Foxes: Each fox moves to a neighboring cell, eats a rabbit, breeds, or dies.

### Components

The app consists of the following components:

* **Canvas:** A canvas element that displays the grid and the animals.
* **Chart:** An SVG element that displays the population chart.
* **Lotka-Volterra panel:** A panel that displays the Lotka-Volterra equations and allows users to input parameters.
* **Scenario tools:** A panel that allows users to save and load scenarios.
* **Preset list:** A list of saved presets.
* **Announcer:** An element that announces the current tick and population numbers.

### API

The app exposes the following API methods:

* `reset(seed, params)`: Resets the simulation with the given seed and parameters.
* `step(n)`: Runs `n` ticks synchronously.
* `counts()`: Returns the current population numbers.
* `tick()`: Returns the current tick number.
* `cell(x, y)`: Returns the contents of the cell at position (x, y).
* `history()`: Returns the history of the simulation.
* `ode(p, t, dt)`: Integrates the Lotka-Volterra equations with the given parameters.
* `exportCSV()`: Returns the population history as CSV.
* `exportScenario()`: Returns the current scenario as JSON.
* `loadScenario(text)`: Loads a scenario from the given JSON string.

### Rendering

The app uses the following rendering techniques:

* **Canvas:** The canvas element is used to display the grid and the animals.
* **SVG:** The SVG element is used to display the population chart.
* **CSS:** CSS is used to style the app and make it look polished.

### Controls and Counters

The app has the following controls and counters:

* **Buttons:** Play, pause, step, reset, and load scenario.
* **Inputs:** Seed, speed, and parameter sliders.
* **Counters:** Tick, rabbits, foxes, and grass.

### Lotka-Volterra Panel

The Lotka-Volterra panel allows users to input parameters and run the simulation.

### Presets

The app allows users to save and load presets.

### Accessibility and Keyboard

The app is designed to be accessible and can be operated from the keyboard.

### Layout

The app has a responsive layout that adapts to different screen sizes.

## Ecosystem Lab