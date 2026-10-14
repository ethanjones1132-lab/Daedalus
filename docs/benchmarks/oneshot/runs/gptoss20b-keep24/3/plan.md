## Plan

**Data model**  
- `grid`: 2‑dimensional array of cells `{grass, rabbit, fox}`.  
- `animals`: map `id → {type:'rabbit'|'fox', x, y, energy}`.  
- `params`: merged defaults + user overrides.  
- `rand`: single mulberry32 stream.  
- `tick`: current tick number.  
- `history`: array of `{tick, rabbits, foxes, grass}`.  
- `idCounter`: next id to assign.

**Tick order**  
1. **Grass**: increment all cells, clamp to `grassMax`.  
2. **Rabbits**: snapshot alive ids sorted ascending. For each: move → eat → energy change → breed → die.  
3. **Foxes**: snapshot alive ids sorted ascending. For each: move → eat → energy change → breed → die.  
4. `tick++`, record history point.

**Components**  
- `WorldCanvas` (`<canvas data-testid="world">`) – draws grid, grass, rabbits, foxes.  
- `Controls` – play/pause, step, reset, seed, speed, sliders.  
- `Counters` – tick, rabbits, foxes, grass.  
- `Chart` – SVG with two polyline series.  
- `CSVExport` – button that triggers download.  
- `ScenarioPanel` – textarea, export, load, error.  
- `ODEPanel` – inputs, run button, outputs, chart.  
- `PresetPanel` – list, load, delete, save.  
- `Announcer` – live region for pause status.  

All are plain DOM elements; event listeners update the shared state and call `redraw()` and `updateCounters()`.

**Rendering**  
- Canvas backing size `width*10 × height*10`.  
- Grass color `rgb(30, G, 30)` with `G = 60 + round(160*grass/grassMax)`.  
- Rabbit shape: 4×4 white square centered.  
- Fox shape: 4×4 orange square drawn over rabbit if present.

**API**  
`window.lab` exposes the required methods, all operating on the shared state.  
`reset`, `step`, `counts`, `tick`, `cell`, `history`, `ode`, `exportCSV`, `exportScenario`, `loadScenario`.

**Timing**  
When playing, use `requestAnimationFrame` to accumulate elapsed time and run `step` with the computed number of ticks. Speed change updates the target ticks per second immediately.

**Accessibility**  
All controls are focusable; `announcer` updates on pause. Global key listeners handle shortcuts when no control is focused.

**Presets**  
Persisted in `localStorage["ecolab.presets"]` as a JSON object. On load, populate the list; actions modify storage and the DOM.

**Layout**  
CSS flex/grid places `panel-world` and `panel-side` side‑by‑side or stacked depending on viewport width, with no horizontal scrolling.

---