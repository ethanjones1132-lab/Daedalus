

## Plan

### Data Model
The simulation is grid-based with `width` × `height` cells. Each cell tracks grass levels (0–`grassMax`) and may contain at most one rabbit and one fox. Animals (rabbits/foxes) have unique IDs, positions, and energy. Grass grows by 1 per tick (capped at `grassMax`). Rabbits move to empty cells, eat grass (gaining energy), breed if energy ≥ `rabbitBreed`, and die if energy ≤ 0. Foxes move to cells with rabbits or empty cells, eat rabbits (gaining energy), breed if energy ≥ `foxBreed`, and die if energy ≤ 0. The history records population counts (rabbits, foxes, total grass) per tick.

### Tick Order
1. **Grass Growth**: All cells increase grass by 1 (capped).
2. **Rabbit Actions**: Process rabbits in ID order: move, eat, breed, die.
3. **Fox Actions**: Process foxes in ID order: move, eat, breed, die.
Each tick updates the grid and records population counts.

### Components
1. **Canvas (`<canvas data-testid="world">`)**: Renders the grid with grass, rabbits, and foxes.
2. **Population Chart (`<svg data-testid="chart">`)**: Plots rabbit/fox counts over ticks.
3. **Parameter Sliders**: Adjust `rabbits0`, `foxes0`, `rabbitBreed`, etc.
4. **Controls**: Play/Pause, Step, Reset buttons.
5. **Scenario Tools**: Save/load scenarios as JSON.
6. **Lotka-Volterra Panel**: Inputs for equations and trajectory visualization.
7. **Counters**: Display current tick and population counts.

---

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Ecosystem Lab</title>
  <style>
    body { font-family: sans-serif; margin: 0; }
    #panel-world, #panel-side { display: flex; flex-direction: column; }
    canvas { border: 1px solid #000; }
    .controls { margin: 10px 0; }
    input, button { margin: 5px 0; }
    svg { width: 100%; height: 300px; }
    .preset-list { list-style: none; padding: 0; }
    .preset-item { margin: 5px 0; }
  </style>
</head>
<body>
  <div id="panel-world">
    <canvas data-testid="world"></canvas>
    <div class="controls">
      <input type="number" id="seed" data-testid="seed" value="42">
      <button data-testid="play">Play</button>
      <button data-testid="pause">Pause</button>
      <button data-testid="step">Step</button>
      <button data-testid="reset">Reset</button>
    </div>
    <div id="counters">
      <div>Tick: <span id="tick">0</span></div>
      <div>Rabbits: <span id="count-rabbits">0</span></div>
      <div>Foxes: <span id="count-foxes">0</span></div>
      <div>Grass: <span id="count-grass">0</span></div>
    </div>
  </div>
  <div id="panel-side">
    <svg data-testid="chart"></svg>
    <div id="ode-panel">
      <div>α: <input type="number" id="ode-alpha" value="1.1"></div>
      <div>β: <input type="number" id="ode-beta" value="0.4"></div>
      <div>γ: <input type="number" id="ode-gamma" value="0.4"></div>
      <div>δ: <input type="number" id="ode-delta" value="0.1"></div>
      <div>x0: <input type="number" id="ode-x0" value="10"></div>
      <div>y0: <input type="number" id="ode-y0" value="10"></div>
      <div>t: <input type="number" id="ode-t" value="50"></div>
      <div>dt: <input type="number" id="ode-dt" value="0.01"></div>
      <button data-testid="ode-run">Run</button>
      <div>x: <span id="ode-x">0</span></div>
      <div>y: <span id="ode-y">0</span></div>
      <div>eq-x: <span id="ode-eq-x">0</span></div>
      <div>eq-y: <span id="ode-eq-y">0</span></div>
      <div>drift: <span id="ode-drift">0</span></div>
      <svg data-testid="ode-chart"></svg>
    </div>
    <div id="scenario">
      <textarea id="scenario-json" data-testid="scenario-json"></textarea>
      <button data-testid="scenario-export">Export</button>
      <button data-testid="scenario-load">Load</button>
      <div id="scenario-error"></div>
    </div>
    <div id="preset-list"></div>
  </div>
  <script>
    // JavaScript implementation here
  </script>
</body>
</html>
```
