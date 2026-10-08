## Plan

**Data model**  
- `grid`: 2‑D array of cells `{grass, rabbit, fox}`.  
- `animals`: two maps `rabbits` and `foxes` keyed by id → `{id, x, y, energy}`.  
- `idCounter`: next id.  
- `rand`: mulberry32 generator.  
- `history`: array of `{tick, rabbits, foxes, grass}`.  
- `params`: merged defaults + user overrides.  
- `tickCount`: current tick.  

**Tick order**  
1. Grow grass.  
2. Rabbits (sorted by id): move → eat → cost → breed → die.  
3. Foxes (sorted by id): move → eat → cost → breed → die.  
4. Increment tick, record history.  

**Components**  
- `WorldCanvas`: `<canvas data-testid="world">` renders grid.  
- `Controls`: play/pause, step, reset, speed slider, seed input, parameter sliders.  
- `Counters`: tick, rabbits, foxes, grass.  
- `Chart`: `<svg data-testid="chart">` with two polylines.  
- `CSVExport`: button `csv-export`.  
- `ScenarioPanel`: textarea, export/load buttons, error message.  
- `ODEPanel`: inputs, run button, outputs, chart.  
- `PresetPanel`: name input, save button, list of presets with load/delete.  
- `Announcer`: live region.  

All UI elements use `data-testid` for tests. The simulation logic is encapsulated in `window.lab` exposing the required API. Rendering is triggered after each reset or step. The play loop uses `requestAnimationFrame` to schedule ticks at the user‑selected speed, measuring elapsed time. Keyboard shortcuts are added on `keydown` when no form control is focused. Presets are stored in `localStorage["ecolab.presets"]`. The layout uses CSS flexbox with media queries to switch between side‑by‑side and stacked layouts. All styles are inline in the single HTML file.