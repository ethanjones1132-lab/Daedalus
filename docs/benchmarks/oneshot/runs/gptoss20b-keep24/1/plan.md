## Plan

**Data model**  
- `grid` is a 2‑array `[height][width]` of cells.  
  Each cell: `{grass, rabbit: null|{id,energy}, fox: null|{id,energy}}`.  
- `animals` is a `Map` from id to `{type:'rabbit'|'fox',x,y,energy}`.  
- `idCounter` starts at 1.  
- `rand` is the mulberry32 stream.  
- `history` is an array of `{tick,rabbits,foxes,grass}`.  
- `params` holds all 13 parameters, merged over defaults on reset.  

**Tick order**  
1. Grow grass.  
2. Rabbits phase: sorted by id, move → eat → cost → breed → die.  
3. Foxes phase: sorted by id, move → eat → cost → breed → die.  
4. Increment tick, record history.  

**Components**  
- `<canvas data-testid="world">` – draws grid, grass, rabbits, foxes.  
- `<svg data-testid="chart">` – two `<polyline>` for rabbits/foxes.  
- Controls panel (`panel-world`) with buttons, inputs, counters, announcer.  
- Lotka–Volterra panel (`panel-side`) with inputs, run button, outputs, chart.  
- Scenario panel with textarea, export/load buttons, error message.  
- Presets list (`preset-list`) with load/delete buttons.  

All state changes go through the `window.lab` API; UI reads from it.  
The simulation loop uses `requestAnimationFrame` to advance ticks at the selected speed, measuring elapsed time.  
Randomness is only via `rand()`; `pick(list)` uses it only when list non‑empty.  
The UI updates counters, chart, canvas, and announcer after each tick or step.  
Presets are stored in `localStorage["ecolab.presets"]` as a JSON object.  
Keyboard shortcuts are handled on `keydown` when no form control has focus.