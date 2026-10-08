## Plan

**Data model**  
- `grid`: 2‑dimensional array of cells `{grass, rabbit, fox}`.  
- `animals`: Map `id → {type, x, y, energy}`.  
- `nextId`: integer counter for new animals.  
- `rand`: mulberry32 generator.  
- `tick`: current tick number.  
- `history`: array of `{tick, rabbits, foxes, grass}`.  
- `params`: merged defaults + user overrides.  

**Tick order**  
1. Grass growth.  
2. Rabbits phase (sorted by id).  
3. Foxes phase (sorted by id).  
4. Increment tick and record history.  

**Components**  
- `WorldCanvas` – `<canvas data-testid="world">`.  
- `Controls` – play/pause/step/reset, seed, speed, sliders.  
- `Counters` – tick, rabbits, foxes, grass.  
- `Chart` – `<svg data-testid="chart">` with two polylines.  
- `CSVExport` – button to download CSV.  
- `ScenarioPanel` – textarea, export/load buttons, error message.  
- `ODEPanel` – inputs, run button, outputs, chart.  
- `PresetPanel` – name input, save button, list of presets.  
- `Announcer` – live region for pause status.  

All components are plain DOM elements; state is kept in the global `lab` object and updated via helper functions that re‑render only the affected parts.  

---