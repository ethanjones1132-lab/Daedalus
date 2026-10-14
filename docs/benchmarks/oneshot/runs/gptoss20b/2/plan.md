## Plan

**Data model**  
- `grid`: 2‑D array of cells `{grass, rabbit, fox}`.  
- `animals`: two maps `rabbits` and `foxes` keyed by id → `{id, x, y, energy}`.  
- `idCounter`: next id.  
- `rand`: mulberry32 generator.  
- `params`: merged defaults + user overrides.  
- `history`: array of `{tick, rabbits, foxes, grass}`.  
- `tickCount`: current tick.  

**Tick order**  
1. Grow grass.  
2. Rabbits phase: sorted by id, each moves, eats, loses cost, breeds, dies.  
3. Foxes phase: sorted by id, each moves (prefers rabbit cells), eats, loses cost, breeds, dies.  
4. Increment tick, record history.  

**Components**  
- `WorldCanvas`: `<canvas data-testid="world">` draws grid, grass, rabbits, foxes.  
- `Controls`: play/pause, step, reset, seed, speed, sliders.  
- `Counters`: tick, rabbits, foxes, grass.  
- `Chart`: `<svg data-testid="chart">` with two polylines.  
- `CSVExport`: button `csv-export`.  
- `ScenarioPanel`: textarea, export/load buttons, error message.  
- `ODEPanel`: inputs, run button, outputs, chart.  
- `PresetsPanel`: name input, save button, list of presets with load/delete.  
- `Announcer`: live region for accessibility.  

All components are plain DOM elements; state is kept in the global `lab` object. Event listeners update state, then call `render()` which updates canvas, counters, charts, and history. Playback uses `requestAnimationFrame` with timestamps to schedule ticks at the user‑selected speed. Keyboard shortcuts are handled on `document` when no form control is focused.  

The `window.lab` API exposes the required methods, all delegating to the internal simulation functions. Reset clears history, re‑initialises grid, animals, and id counter, then records tick 0. `step(n)` runs `n` ticks synchronously. `ode(p,t,dt)` implements RK4 on the Lotka–Volterra equations. CSV and scenario export/import use `JSON.stringify`/`JSON.parse`. Presets are stored in `localStorage["ecolab.presets"]`.  

The layout uses CSS grid/flex to place `panel-world` and `panel-side`. Media queries switch to column layout below 700 px. The canvas backing size is `width*10 × height*10`; CSS scales it to fit the container. All controls have `data-testid` attributes as specified.  

---