## Plan

The simulation uses a 2D grid where each cell stores grass level, an optional rabbit, and an optional fox. A global `idCounter` ensures every animal has a unique ID. The simulation follows a fixed order: grass grows, rabbits move/eat/breed/die, then foxes move/eat/breed/die. All random choices use the required `mulberry32` generator seeded at reset.

The UI is split into two panels: `panel-world` (canvas, counters, parameters) and `panel-side` (population chart, Lotka–Volterra ODE analysis, scenario tools, presets). The ODE panel uses RK4 integration to compare the simulation against the Lotka–Volterra model.

The `window.lab` API exposes the simulation state and controls, including `ode` for the ODE trajectory, `exportCSV` for data export, and `loadScenario`/`exportScenario` for JSON-based scene sharing. Presets are persisted in `localStorage`.

## Ecosystem Lab