## Plan

**Data model**  
- `world` object: `grid` (2‑D array of cells), `rabbits` & `foxes` maps (id → animal), `idCounter`, `tick`, `rand`, `params`, `history`.  
- Cell: `{grass, rabbitId, foxId}`.  
- Animal: `{id, x, y, energy}`.  
- `params` holds all 13 parameters.  

**Tick order**  
1. Grow grass.  
2. Rabbits phase: sorted by id, move → eat → cost → breed → die.  
3. Foxes phase: sorted by id, move → eat → cost → breed → die.  
4. Increment `tick`, push history point.  

**Components**  
- `<canvas data-testid="world">` – renders grid, grass, rabbits, foxes.  
- Controls panel (`panel-world`): play/pause, step, reset, seed, speed, sliders, counters.  
- Chart panel (`panel-side`): population chart (`svg`), Lotka–Volterra panel, scenario tools, presets list.  
- Accessibility: `announcer`, keyboard shortcuts.  
- API: expose `window.lab` with methods `reset`, `step`, `counts`, `tick`, `cell`, `history`, `ode`, `exportCSV`, `exportScenario`, `loadScenario`.  

All logic is in vanilla JS; no external libraries. The random generator is used exclusively. Rendering uses a 10×10 pixel cell grid; canvas backing size is `width*10 × height*10`. The chart uses `polyline` points; axes are simple text labels. The Lotka–Volterra panel computes RK4 steps and displays final values, equilibrium, drift, and a chart. Presets are stored in `localStorage["ecolab.presets"]`. The layout adapts with CSS media queries. Shortcuts are handled via `keydown` on `document.body` when no form control is focused. The announcer updates on pause. All controls have `data-testid` attributes as required. The app starts with `reset(42,{})` on load.