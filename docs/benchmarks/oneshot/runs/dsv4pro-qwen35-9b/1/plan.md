## Plan

The app is a single HTML file containing a grid-based ecosystem simulation. The state consists of a grid of cells, each holding grass, an optional rabbit, and an optional fox. Animals have IDs, positions, and energy. The simulation runs in discrete ticks, updating grass, moving and eating rabbits, moving and eating foxes, and breeding.

**Data Model:**
- `grid`: 2D array of objects `{grass, rabbit, fox}`.
- `rabbits`: Array of objects `{id, x, y, energy}`.
- `foxes`: Array of objects `{id, x, y, energy}`.
- `history`: Array of `{tick, rabbits, foxes, grass}`.
- `idCounter`: Integer starting at 1.
- `tick`: Integer starting at 0.
- `seed`: Integer.
- `params`: Object with 13 keys.

**Tick Order:**
1. Grass grows.
2. Rabbits move, eat, lose energy, breed, die.
3. Foxes move, eat, lose energy, breed, die.
4. Increment tick, record history.

**Components:**
- Canvas (`data-testid="world"`) for the grid.
- SVG (`data-testid="chart"`) for population history.
- SVG (`data-testid="ode-chart"`) for Lotka-Volterra.
- Buttons: `play`, `pause`, `step`, `reset`, `csv-export`, `scenario-export`, `scenario-load`, `ode-run`, `preset-save`, `preset-delete`.
- Inputs: `seed`, `speed`, `param-rabbits0`, `param-foxes0`, `param-rabbitBreed`, `param-foxBreed`, `param-foxGain`, `param-grassMax`, `preset-name`, `scenario-json`.
- Counters: `tick`, `count-rabbits`, `count-foxes`, `count-grass`.
- Textarea: `scenario-json`.
- Message: `scenario-error`.

The UI uses inline CSS for layout, scaling based on viewport width. The simulation logic is encapsulated in the `window.lab` API.