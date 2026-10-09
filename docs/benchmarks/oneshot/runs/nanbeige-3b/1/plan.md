## Plan

**Data Model**
- Simulation state: grid (width×height cells, each with grass 0–grassMax), rabbits/foxes arrays (each with id, x, y, energy), shared id counter, seed, RNG generator, current tick, history array.
- Parameters: defaults object + user params merged (13 keys).
- History: array of {tick, rabbits, foxes, grass} (grass = sum of cell grass).
- Lotka–Volterra: separate ODE state with RK4 integration.

**Tick Order**
1. Grass regrows (min(grassMax, grass+1)).
2. Rabbits act (sorted by id): move, eat, breed, die.
3. Foxes act (sorted by id): move, eat, breed, die.
4. Tick increments, history recorded.

**Components**
- Canvas renderer (`panel-world`): grid cells with grass/rabbit/fox colors.
- Controls: play/pause/step/reset buttons, seed/speed inputs, parameter sliders.
- Counters: tick, rabbits, foxes, grass.
- Chart (`panel-side`): SVG polyline series for rabbits/foxes.
- Lotka–Volterra panel: ODE inputs, run button, results, ode-chart SVG.
- Scenario tools: export/load JSON, error display, presets list/save/delete.
- Announcer: live text updates on pause.
- Keyboard shortcuts (body focus): Space toggle, s step, r reset.

---