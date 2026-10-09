## Plan

**Data Model:**
- **Grid:** 2D array of cells. Each cell holds `grass` (0–4), `rabbit` (object or null), `fox` (object or null).
- **Animals:** Objects with `id` (global counter), `x`, `y`, `energy`. Ids are unique and incrementing.
- **State:** `tick` (counter), `history` (array of `{tick, rabbits, foxes, grass}`), `playing` (boolean), `speed` (ticks per second), `seed` (integer).
- **Parameters:** 13 params stored in a single object, merged with defaults on reset.

**Tick Order:**
1. Grass grows.
2. Rabbits: move → eat → lose energy → breed (if energy ≥ threshold) → die (if energy ≤ 0).
3. Foxes: move (prefer rabbit cells) → eat → lose energy → breed → die.
4. Increment tick, record history point.

**Components:**
- **Canvas:** Renders grid, rabbits, foxes.
- **Controls:** Play/Pause/Step/Reset buttons, speed slider, parameter sliders, seed input.
- **Counters:** Live tick, rabbit, fox, grass counts.
- **Chart:** SVG polyline for rabbit/fox population history.
- **CSV Export:** Downloads history as CSV.
- **Scenario Tools:** JSON textarea, export/load buttons, error message.
- **Lotka–Volterra Panel:** RK4 integrator with inputs, results display, and trajectory chart.
- **Presets:** localStorage-based save/load/delete list.
- **Announcer:** Live region for keyboard shortcuts and play state.

**Rendering:** Canvas backing size is `width*10` × `height*10`. Grass color scales with level. Rabbits are white, foxes are orange (drawn over rabbits).

**Timing:** `requestAnimationFrame` loop measures elapsed time. While playing, `speed` ticks are advanced per second of elapsed time.

**Accessibility:** All controls are keyboard-accessible. Shortcuts (Space, `s`, `r`) work when no input is focused. Focus outlines are visible.