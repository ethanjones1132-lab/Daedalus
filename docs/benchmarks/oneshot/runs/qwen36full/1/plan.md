## Plan

**Data Model:**
- `Grid`: 2D array of objects `{grass, rabbit, fox}`.
- `Animals`: Objects `{id, energy}` stored in `Grid` cells.
- `State`: `seed`, `tick`, `params`, `history`, `rng`.
- `Params`: 13 configuration values with defaults.

**Tick Order:**
1. **Grass Growth:** Increment all grass levels up to `grassMax`.
2. **Rabbits:** Iterate sorted by ID. Move (to empty neighbor), Eat (grass), Cost, Breed (if energy high), Die (if energy <= 0).
3. **Foxes:** Iterate sorted by ID. Move (to rabbit neighbor, else empty), Eat (rabbit), Cost, Breed (if energy high), Die (if energy <= 0).
4. **Record:** Save state to history.

**Components:**
- `Panel World`: Canvas, Controls (Play, Pause, Step, Reset), Sliders, Counters.
- `Panel Side`: SVG Chart, Lotka-Volterra Panel, Scenario Tools, Presets.
- `Announcer`: Screen reader output.