## Plan

**Data Model:**
- `Grid`: 2D array of cells, each with `grass`, `rabbit` (id, energy), `fox` (id, energy).
- `Animals`: Shared ID counter, lists of active rabbits/foxes.
- `History`: Array of `{tick, rabbits, foxes, grass}`.
- `Params`: Merged defaults with user overrides.
- `Rand`: Single `mulberry32` generator.

**Tick Order:**
1. Grass: increment all cells.
2. Rabbits: move, eat, breed, die (sorted by ID).
3. Foxes: move, eat, breed, die (sorted by ID).
4. Record history.

**Components:**
- `world` (canvas), `chart` (SVG), `ode-chart` (SVG), controls (buttons, inputs, sliders), counters, announcer, presets, scenario tools.