## Plan

The simulation uses a 2D grid where each cell holds grass, an optional rabbit, and an optional fox. A global `idCounter` ensures every animal has a unique ID. The `reset` function initializes the world from the seed and parameters, then records the initial state. Each tick processes rabbits and foxes in ascending ID order, with movement, eating, breeding, and death handled per animal.

The `lab` API exposes the simulation state and the `ode` function, which integrates the Lotka–Volterra equations using RK4. The UI is divided into two panels: `panel-world` for the canvas, simulation controls, and counters; `panel-side` for the population chart, the ODE panel, scenario tools, and presets. A `requestAnimationFrame`-based loop advances the simulation at the user-defined speed while playing.

## Ecosystem Lab