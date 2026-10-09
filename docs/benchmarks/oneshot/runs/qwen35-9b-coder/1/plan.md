## Plan

The app is a single HTML file with inline CSS and JS. It exposes a `window.lab` API that drives both the UI and the simulation.

**Data model:**
- **Grid:** `width` × `height` cells. Each cell stores `grass` (0–`grassMax`), and optional `rabbit` / `fox` objects `{id, energy}` or `null`.
- **Animals:** every animal has a unique `id` from a shared counter starting at 1.
- **State:** `tick`, `history` array of `{tick, rabbits, foxes, grass}`, `seed`, `params` object, `playing` boolean, `speed` ticks/sec, `elapsed` time, `lastTickTime`.
- **Randomness:** a single `mulberry32` generator seeded by the reset seed. `pick(list)` draws from it.

**Tick order (per section 3):**
1. Grass grows.
2. Rabbits move, eat, lose energy, breed, die.
3. Foxes move, eat, lose energy, breed, die.
4. Increment tick, record history.

**Components:**
- **World panel:** canvas (`data-testid="world"`), counters (`tick`, `count-rabbits`, `count-foxes`, `count-grass`), play/pause/step/reset buttons, seed input, speed slider, parameter sliders.
- **Side panel:** population chart (`data-testid="chart"`), Lotka–Volterra panel with RK4 integration and its own chart (`data-testid="ode-chart"`), scenario tools (textarea, export/load buttons, error message), presets list.
- **Announcer:** `aria-live="polite"` element for keyboard shortcuts.
- **Layout:** flexbox; side panel moves below world panel on narrow viewports.

**Rendering:**
- Canvas backing size is `width*10` × `height*10`. Grass cells are filled with green intensity based on grass level. Rabbits and foxes are drawn as filled shapes centered in their cells, fox over rabbit when sharing.
- SVG chart with polylines for rabbit and fox populations over ticks.
- ODE chart with polylines for x(t) and y(t).

**Persistence:**
- Presets saved to `localStorage` under `ecolab.presets`.
- Scenario export/parse via `exportScenario()` / `loadScenario()`.

**Keyboard:**
- Space toggles play/pause when no input is focused.
- `s` steps one tick.
- `r` resets.
- Focus is tracked to disable shortcuts when an input/button has focus.