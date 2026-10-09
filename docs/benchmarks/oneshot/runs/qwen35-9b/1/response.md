## Plan

**Data Model:**
The app maintains a central state object containing:
1.  **Simulation State:** `tick`, `seed`, `params` (merged defaults), `history` (array of `{tick, rabbits, foxes, grass}`), `animals` (array of objects `{id, type, x, y, energy}`).
2.  **Grid State:** A 2D array representing cells, storing `grass` (0-4), `rabbit` (null or `{id, energy}`), and `fox` (null or `{id, energy}`).
3.  **UI State:** `isPlaying`, `speed`, `seedInput`, `sliderValues`.

**Tick Order:**
1.  **Grass:** Grow (`min(max, grass + 1)`).
2.  **Rabbits:** Iterate by ascending ID. For each: Move (pick neighbor without rabbit), Eat (gain energy, clear grass), Cost (lose energy), Breed (if energy high, pick neighbor without rabbit, spawn child), Die (if energy <= 0).
3.  **Foxes:** Iterate by ascending ID. For each: Move (prioritize neighbors with rabbit, then empty), Eat (if rabbit present, remove rabbit, gain energy), Cost (lose energy), Breed (if energy high, pick neighbor without fox, spawn child), Die (if energy <= 0).
4.  **History:** Record `{tick, count, sum}`.

**Components:**
1.  **Canvas:** Renders grid, rabbits (white), foxes (red).
2.  **Controls:** Play/Pause/Step/Reset buttons, Seed input, Speed slider, Parameter sliders.
3.  **Counters:** Display current tick and population counts.
4.  **Chart:** SVG polyline for Rabbit/Fox history.
5.  **Lotka-Volterra Panel:** Inputs for ODE parameters, Run button, Result display, ODE Chart.
6.  **Scenario Tools:** JSON textarea, Export/Load buttons, Error message.
7.  **Presets:** List of saved scenarios, Save/Delete buttons.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ecosystem Lab</title>
<style>
  :root {
    --bg: #f4f4f9;
    --panel: #ffffff;
    --border: #ccc;
    --text: #333;
    --accent: #4a90e2;
    --danger: #e74c3c;
    --success: #2ecc71;
  }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: var(--bg); color: var(--text); }
  h1, h2, h3 { margin: 0 0 10px 0; }
  
  .container { display: flex; flex-wrap: wrap; gap: 20px; max-width: 1400px; margin: 0 auto; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 15px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
  .panel-world { flex: 2; min-width: 360px; }
  .panel-side { flex: 1; min-width: 300px; }

  /* Canvas */
  canvas { border: 1px solid #ddd; background: #fff; display: block; margin: 0 auto; }

  /* Controls */
  .controls { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 15px; align-items: center; }
  button { padding: 6px 12px; cursor: pointer; border: 1px solid var(--border); background: #fff; border-radius: 4px; }
  button:hover { background: #eee; }
  button:active { background: #ddd; }
  button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  button.primary:hover { background: #357abd; }
  button.danger { background: var(--danger); color: white; border-color: var(--danger); }
  button.danger:hover { background: #c0392b; }

  .input-group { display: flex; align-items: center; gap: 5px; margin-bottom: 8px; }
  label { font-size: 0.9em; }
  input[type="number"], input[type="text"], textarea { padding: 4px; border: 1px solid var(--border); border-radius: 4px; }
  input[type="range"] { width: 100px; }
  
  /* Counters */
  .counters { display: flex; gap: 15px; margin-bottom: 15px; font-weight: bold; }
  .counter-item span { color: var(--accent); }

  /* Chart */
  .chart-container { height: 200px; border: 1px solid #eee; margin-top: 10px; position: relative; }
  svg { width: 100%; height: 100%; overflow: visible; }
  polyline { stroke-width: 2; fill: none; }
  .series-rabbits { stroke: var(--success); }
  .series-foxes { stroke: var(--danger); }
  .axis-label { font-size: 12px; fill: #666; }

  /* ODE Panel */
  .ode-panel { margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px; }
  .ode-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 10px; }
  .ode-result { font-size: 0.9em; margin-bottom: 5px; }
  .ode-result strong { color: var(--accent); }

  /* Presets */
  .preset-list { list-style: none; padding: 0; margin-top: 10px; }
  .preset-item { display: flex; justify-content: space-between; align-items: center; padding: 5px; border-bottom: 1px solid #eee; }
  .preset-item button { margin-left: 5px; font-size: 0.8em; }

  /* Utilities */
  .hidden { display: none; }
  .error { color: var(--danger); font-size: 0.9em; margin-top: 5px; }
  .announcer { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
</style>
</head>
<body>

<div class="container">
  <!-- Main Simulation Panel -->
  <div class="panel panel-world">
    <h1>Ecosystem Lab</h1>
    
    <div class="counters">
      <div class="counter-item">Tick: <span id="count-tick">0</span></div>
      <div class="counter-item">Rabbits: <span id="count-rabbits">0</span></div>
      <div class="counter-item">Foxes: <span id="count-foxes">0</span></div>
      <div class="counter-item">Grass: <span id="count-grass">0</span></div>
    </div>

    <div class="controls">
      <button id="play" class="primary">Play</button>
      <button id="pause">Pause</button>
      <button id="step">Step</button>
      <button id="reset">Reset</button>
      <div class="input-group">
        <label for="seed">Seed:</label>
        <input type="number" id="seed" value="42" style="width: 60px;">
      </div>
      <div class="input-group">
        <label for="speed">Speed:</label>
        <input type="range" id="speed" min="1" max="60" value="10">
        <span id="speed-val">10</span>
      </div>
    </div>

    <div class="controls">
      <div class="input-group">
        <label for="param-rabbits0">Rabbits Start:</label>
        <input type="range" id="param-rabbits0" min="0" max="300" value="100">
        <span id="val-rabbits0">100</span>
      </div>
      <div class="input-group">
        <label for="param-foxes0">Foxes Start:</label>
        <input type="range" id="param-foxes0" min="0" max="60" value="6">
        <span id="val-foxes0">6</span>
      </div>
      <div class="input-group">
        <label for="param-rabbitBreed">Rabbit Breed:</label>
        <input type="range" id="param-rabbitBreed" min="2" max="40" value="12">
        <span id="val-rabbitBreed">12</span>
      </div>
      <div class="input-group">
        <label for="param-foxBreed">Fox Breed:</label>
        <input type="range" id="param-foxBreed" min="2" max="60" value="40">
        <span id="val-foxBreed">40</span>
      </div>
      <div class="input-group">
        <label for="param-foxGain">Fox Gain:</label>
        <input type="range" id="param-foxGain" min="1" max="30" value="4">
        <span id="val-foxGain">4</span>
      </div>
      <div class="input-group">
        <label for="param-grassMax">Grass Max:</label>
        <input type="range" id="param-grassMax" min="1" max="10" value="4">
        <span id="val-grassMax">4</span>
      </div>
    </div>

    <canvas id="world" data-testid="world" width="400" height="300"></canvas>
  </div>

  <!-- Side Panel -->
  <div class="panel panel-side">
    <h2>Population Chart</h2>
    <div class="chart-container">
      <svg id="chart" data-testid="chart" viewBox="0 0 400 200">
        <text x="10" y="180" class="axis-label">tick</text>
        <text x="390" y="10" class="axis-label" transform="rotate(-90 390 10)">count</text>
        <polyline id="series-rabbits" data-testid="series-rabbits" points="" />
        <polyline id="series-foxes" data-testid="series-foxes" points="" />
      </svg>
    </div>

    <h2>Lotka–Volterra</h2>
    <div class="ode-panel">
      <div class="ode-grid">
        <div class="input-group"><label>α</label><input type="number" id="ode-alpha" value="1.1" step="0.1"></div>
        <div class="input-group"><label>β</label><input type="number" id="ode-beta" value="0.4" step="0.1"></div>
        <div class="input-group"><label>γ</label><input type="number" id="ode-gamma" value="0.4" step="0.1"></div>
        <div class="input-group"><label>δ</label><input type="number" id="ode-delta" value="0.1" step="0.1"></div>
        <div class="input-group"><label>x₀</label><input type="number" id="ode-x0" value="10"></div>
        <div class="input-group"><label>y₀</label><input type="number" id="ode-y0" value="10"></div>
        <div class="input-group"><label>t</label><input type="number" id="ode-t" value="50"></div>
        <div class="input-group"><label>dt</label><input type="number" id="ode-dt" value="0.01" step="0.001"></div>
      </div>
      <button id="ode-run">Run ODE</button>
      <div id="ode-results" class="ode-result"></div>
      <div class="chart-container" style="height: 150px;">
        <svg id="ode-chart" data-testid="ode-chart" viewBox="0 0 400 150">
           <polyline id="ode-series-x" data-testid="ode-series-x" points="" />
           <polyline id="ode-series-y" data-testid="ode-series-y" points="" />
        </svg>
      </div>
    </div>

    <h2>Scenario</h2>
    <div class="input-group">
      <button id="scenario-export">Export JSON</button>
      <button id="scenario-load">Load JSON</button>
    </div>
    <textarea id="scenario-json" rows="4" style="width: 100%; font-family: monospace; font-size: 0.8em;"></textarea>
    <div id="scenario-error" class="error"></div>

    <h2>Presets</h2>
    <div class="input-group">
      <input type="text" id="preset-name" placeholder="Preset Name">
      <button id="preset-save">Save</button>
    </div>
    <ul id="preset-list" class="preset-list"></ul>
  </div>
</div>

<div id="announcer" class="announcer" aria-live="polite"></div>

<script>
/* --- Constants & Defaults --- */
const DEFAULTS = {
  width: 40, height: 30, grassMax: 4,
  rabbits0: 100, foxes0: 6,
  rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
  foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
};

/* --- RNG --- */
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(list, rand) {
  if (list.length === 0) return null;
  return list[Math.floor(rand() * list.length)];
}

/* --- Simulation Logic --- */
const state = {
  tick: 0,
  seed: 42,
  params: {},
  history: [],
  animals: [], // {id, type, x, y, energy}
  grid: [],    // 2D array of {grass, rabbit, fox}
  rand: null,
  isPlaying: false,
  speed: 10,
  lastFrameTime: 0,
  tickAccumulator: 0
};

function init() {
  // Merge params
  state.params = {};
  for (const key in DEFAULTS) state.params[key] = DEFAULTS[key];
  
  // Setup RNG
  state.rand = mulberry32(state.seed);

  // Init Grid
  state.grid = [];
  for (let y = 0; y < state.params.height; y++) {
    const row = [];
    for (let x = 0; x < state.params.width; x++) {
      row.push({ grass: 0, rabbit: null, fox: null });
    }
    state.grid.push(row);
  }

  // Reset Animals
  state.animals = [];
  let idCounter = 1;

  // 1. Grass
  for (let y = 0; y < state.params.height; y++) {
    for (let x = 0; x < state.params.width; x++) {
      state.grid[y][x].grass = Math.floor(state.rand() * (state.params.grassMax + 1));
    }
  }

  // 2. Rabbits
  for (let i = 0; i < state.params.rabbits0; i++) {
    const emptyCells = [];
    for (let y = 0; y < state.params.height; y++) {
      for (let x = 0; x < state.params.width; x++) {
        if (!state.grid[y][x].rabbit) emptyCells.push({x, y});
      }
    }
    const spot = pick(emptyCells, state.rand);
    if (spot) {
      state.animals.push({ id: idCounter++, type: 'rabbit', x: spot.x, y: spot.y, energy: state.params.rabbitStart });
      state.grid[spot.y][spot.x].rabbit = { id: idCounter - 1, energy: state.params.rabbitStart };
    }
  }

  // 3. Foxes
  for (let i = 0; i < state.params.foxes0; i++) {
    const emptyCells = [];
    for (let y = 0; y < state.params.height; y++) {
      for (let x = 0; x < state.params.width; x++) {
        if (!state.grid[y][x].fox) emptyCells.push({x, y});
      }
    }
    const spot = pick(emptyCells, state.rand);
    if (spot) {
      state.animals.push({ id: idCounter++, type: 'fox', x: spot.x, y: spot.y, energy: state.params.foxStart });
      state.grid[spot.y][spot.x].fox = { id: idCounter - 1, energy: state.params.foxStart };
    }
  }

  // Record History
  state.history.push({ tick: 0, rabbits: state.animals.filter(a => a.type === 'rabbit').length, foxes: state.animals.filter(a => a.type === 'fox').length, grass: 0 });
  for (let y=0; y<state.params.height; y++) for (let x=0; x<state.params.width; x++) state.history[state.history.length-1].grass += state.grid[y][x].grass;

  // UI Reset
  updateUI();
  drawWorld();
  drawChart();
  drawODE();
}

function getNeighbors(x, y) {
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // Up, Right, Down, Left
  const neighbors = [];
  for (let d of dirs) {
    const nx = x + d[0];
    const ny = y + d[1];
    if (nx >= 0 && nx < state.params.width && ny >= 0 && ny < state.params.height) {
      neighbors.push({x: nx, y: ny});
    }
  }
  return neighbors;
}

function reset(seed, params) {
  state.seed = seed;
  state.tick = 0;
  state.history = [];
  state.animals = [];
  state.grid = [];
  state.params = {};
  for (const key in DEFAULTS) state.params[key] = DEFAULTS[key];
  
  // Merge params
  for (const k in params) {
    if (state.params.hasOwnProperty(k)) state.params[k] = params[k];
  }

  state.rand = mulberry32(seed);
  
  // Re-init world
  for (let y = 0; y < state.params.height; y++) {
    const row = [];
    for (let x = 0; x < state.params.width; x++) {
      row.push({ grass: 0, rabbit: null, fox: null });
    }
    state.grid.push(row);
  }

  let idCounter = 1;

  // Grass
  for (let y = 0; y < state.params.height; y++) {
    for (let x = 0; x < state.params.width; x++) {
      state.grid[y][x].grass = Math.floor(state.rand() * (state.params.grassMax + 1));
    }
  }

  // Rabbits
  for (let i = 0; i < state.params.rabbits0; i++) {
    const emptyCells = [];
    for (let y = 0; y < state.params.height; y++) {
      for (let x = 0; x < state.params.width; x++) {
        if (!state.grid[y][x].rabbit) emptyCells.push({x, y});
      }
    }
    const spot = pick(emptyCells, state.rand);
    if (spot) {
      state.animals.push({ id: idCounter++, type: 'rabbit', x: spot.x, y: spot.y, energy: state.params.rabbitStart });
      state.grid[spot.y][spot.x].rabbit = { id: idCounter - 1, energy: state.params.rabbitStart };
    }
  }

  // Foxes
  for (let i = 0; i < state.params.foxes0; i++) {
    const emptyCells = [];
    for (let y = 0; y < state.params.height; y++) {
      for (let x = 0; x < state.params.width; x++) {
        if (!state.grid[y][x].fox) emptyCells.push({x, y});
      }
    }
    const spot = pick(emptyCells, state.rand);
    if (spot) {
      state.animals.push({ id: idCounter++, type: 'fox', x: spot.x, y: spot.y, energy: state.params.foxStart });
      state.grid[spot.y][spot.x].fox = { id: idCounter - 1, energy: state.params.foxStart };
    }
  }

  // History
  let gSum = 0;
  for (let y=0; y<state.params.height; y++) for (let x=0; x<state.params.width; x++) gSum += state.grid[y][x].grass;
  state.history.push({ tick: 0, rabbits: state.animals.filter(a => a.type === 'rabbit').length, foxes: state.animals.filter(a => a.type === 'fox').length, grass: gSum });

  state.isPlaying = false;
  state.tickAccumulator = 0;
  
  updateUI();
  drawWorld();
  drawChart();
  drawODE();
  announce(`Tick 0: ${state.history[0].rabbits} rabbits, ${state.history[0].foxes} foxes`);
  return counts();
}

function step() {
  // 1. Grass
  for (let y = 0; y < state.params.height; y++) {
    for (let x = 0; x < state.params.width; x++) {
      state.grid[y][x].grass = Math.min(state.params.grassMax, state.grid[y][x].grass + 1);
    }
  }

  // 2. Rabbits
  // Sort by ID
  const rabbits = state.animals.filter(a => a.type === 'rabbit').sort((a, b) => a.id - b.id);
  for (const rabbit of rabbits) {
    // Move
    const neighbors = getNeighbors(rabbit.x, rabbit.y);
    const emptyNeighbors = neighbors.filter(n => !state.grid[n.y][n.x].rabbit);
    if (emptyNeighbors.length > 0) {
      const spot = pick(emptyNeighbors, state.rand);
      rabbit.x = spot.x; rabbit.y = spot.y;
      state.grid[rabbit.y][rabbit.x].rabbit = rabbit;
    }

    // Eat
    const cell = state.grid[rabbit.y][rabbit.x];
    rabbit.energy += state.params.rabbitGain * cell.grass;
    cell.grass = 0;

    // Cost
    rabbit.energy -= state.params.rabbitCost;

    // Breed
    if (rabbit.energy >= state.params.rabbitBreed) {
      const neighbors = getNeighbors(rabbit.x, rabbit.y);
      const emptyNeighbors = neighbors.filter(n => !state.grid[n.y][n.x].rabbit);
      if (emptyNeighbors.length > 0) {
        const spot = pick(emptyNeighbors, state.rand);
        const childEnergy = Math.floor(rabbit.energy / 2);
        rabbit.energy -= childEnergy;
        const newRabbit = { id: state.animals.length + 1, type: 'rabbit', x: spot.x, y: spot.y, energy: childEnergy };
        state.animals.push(newRabbit);
        state.grid[spot.y][spot.x].rabbit = newRabbit;
      }
    }

    // Die
    if (rabbit.energy <= 0) {
      state.grid[rabbit.y][rabbit.x].rabbit = null;
      // Remove from array
      const idx = state.animals.indexOf(rabbit);
      if (idx > -1) state.animals.splice(idx, 1);
    }
  }

  // 3. Foxes
  const foxes = state.animals.filter(a => a.type === 'fox').sort((a, b) => a.id - b.id);
  for (const fox of foxes) {
    // Move
    const neighbors = getNeighbors(fox.x, fox.y);
    // Prioritize rabbit neighbors
    const rabbitNeighbors = neighbors.filter(n => state.grid[n.y][n.x].rabbit && !state.grid[n.y][n.x].fox);
    if (rabbitNeighbors.length > 0) {
      const spot = pick(rabbitNeighbors, state.rand);
      fox.x = spot.x; fox.y = spot.y;
      state.grid[fox.y][fox.x].fox = fox;
    } else {
      const emptyNeighbors = neighbors.filter(n => !state.grid[n.y][n.x].fox);
      if (emptyNeighbors.length > 0) {
        const spot = pick(emptyNeighbors, state.rand);
        fox.x = spot.x; fox.y = spot.y;
        state.grid[fox.y][fox.x].fox = fox;
      }
    }

    // Eat
    const cell = state.grid[fox.y][fox.x];
    if (cell.rabbit) {
      const rabbit = cell.rabbit;
      fox.energy += state.params.foxGain;
      cell.rabbit = null;
      // Remove rabbit from animals
      const idx = state.animals.indexOf(rabbit);
      if (idx > -1) state.animals.splice(idx, 1);
    }

    // Cost
    fox.energy -= state.params.foxCost;

    // Breed
    if (fox.energy >= state.params.foxBreed) {
      const neighbors = getNeighbors(fox.x, fox.y);
      const emptyNeighbors = neighbors.filter(n => !state.grid[n.y][n.x].fox);
      if (emptyNeighbors.length > 0) {
        const spot = pick(emptyNeighbors, state.rand);
        const childEnergy = Math.floor(fox.energy / 2);
        fox.energy -= childEnergy;
        const newFox = { id: state.animals.length + 1, type: 'fox', x: spot.x, y: spot.y, energy: childEnergy };
        state.animals.push(newFox);
        state.grid[spot.y][spot.x].fox = newFox;
      }
    }

    // Die
    if (fox.energy <= 0) {
      state.grid[fox.y][fox.x].fox = null;
      const idx = state.animals.indexOf(fox);
      if (idx > -1) state.animals.splice(idx, 1);
    }
  }

  // 4. History
  state.tick++;
  let gSum = 0;
  for (let y=0; y<state.params.height; y++) for (let x=0; x<state.params.width; x++) gSum += state.grid[y][x].grass;
  state.history.push({ tick: state.tick, rabbits: state.animals.filter(a => a.type === 'rabbit').length, foxes: state.animals.filter(a => a.type === 'fox').length, grass: gSum });

  // Update UI
  updateUI();
  drawWorld();
  drawChart();
}

function counts() {
  return {
    rabbits: state.animals.filter(a => a.type === 'rabbit').length,
    foxes: state.animals.filter(a => a.type === 'fox').length,
    grass: 0
  };
}

function getGrass() {
  let sum = 0;
  for (let y=0; y<state.params.height; y++) for (let x=0; x<state.params.width; x++) sum += state.grid[y][x].grass;
  return sum;
}

function cell(x, y) {
  if (x < 0 || x >= state.params.width || y < 0 || y >= state.params.height) return { grass: 0, rabbit: null, fox: null };
  const g = state.grid[y][x].grass;
  const r = state.grid[y][x].rabbit;
  const f = state.grid[y][x].fox;
  return { grass: g, rabbit: r ? {id: r.id, energy: r.energy} : null, fox: f ? {id: f.id, energy: f.energy} : null };
}

function history() { return state.history; }

function ode(p, t, dt) {
  const { alpha, beta, gamma, delta, x0, y0 } = p;
  const steps = Math.round(t / dt);
  let x = x0, y = y0;
  
  for (let i = 0; i < steps; i++) {
    const k1x = alpha * x - beta * x * y;
    const k1y = delta * x * y - gamma * y;
    
    const k2x = alpha * (x + 0.5 * dt * k1x) - beta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y);
    const k2y = delta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y) - gamma * (y + 0.5 * dt * k1y);
    
    const k3x = alpha * (x + 0.5 * dt * k2x) - beta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y);
    const k3y = delta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y) - gamma * (y + 0.5 * dt * k2y);
    
    const k4x = alpha * (x + dt * k3x) - beta * (x + dt * k3x) * (y + dt * k3y);
    const k4y = delta * (x + dt * k3x) * (y + dt * k3y) - gamma * (y + dt * k3y);
    
    x += dt * (k1x + 2*k2x + 2*k3x + k4x) / 6;
    y += dt * (k1y + 2*k2y + 2*k3y + k4y) / 6;
  }
  return { x, y };
}

function exportCSV() {
  let csv = "tick,rabbits,foxes,grass\n";
  for (const h of state.history) {
    csv += `${h.tick},${h.rabbits},${h.foxes},${h.grass}\n`;
  }
  return csv;
}

function exportScenario() {
  const scenario = {
    version: 1,
    seed: state.seed,
    params: state.params
  };
  return JSON.stringify(scenario);
}

function loadScenario(text) {
  try {
    const data = JSON.parse(text);
    if (data.version !== 1) throw new Error("Invalid version");
    if (typeof data.seed !== 'number' || !Number.isInteger(data.seed)) throw new Error("Invalid seed");
    
    reset(data.seed, data.params);
    return true;
  } catch (e) {
    document.getElementById('scenario-error').textContent = e.message;
    return false;
  }
}

/* --- UI & Rendering --- */
const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const chartSvg = document.getElementById('chart');
const odeChartSvg = document.getElementById('ode-chart');

// Resize canvas backing
function resizeCanvas() {
  canvas.width = state.params.width * 10;
  canvas.height = state.params.height * 10;
  drawWorld();
}

function drawWorld() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Draw Grass
  for (let y = 0; y < state.params.height; y++) {
    for (let x = 0; x < state.params.width; x++) {
      const g = state.grid[y][x].grass;
      const G = 60 + Math.round(160 * g / state.params.grassMax);
      ctx.fillStyle = `rgb(30, ${G}, 30)`;
      ctx.fillRect(x * 10, y * 10, 10, 10);
    }
  }

  // Draw Animals
  // Sort by position then ID to ensure consistent layering (though fox over rabbit is rule)
  // Actually, just iterate animals. Foxes drawn after rabbits in same cell.
  
  // Draw Rabbits
  for (const a of state.animals) {
    if (a.type === 'rabbit') {
      ctx.fillStyle = 'rgb(240, 240, 240)';
      // Central 4x4 pixels. Cell is 10x10. Center is 5,5. 4x4 is 2,2 to 6,6.
      ctx.fillRect(a.x * 10 + 2, a.y * 10 + 2, 4, 4);
    }
  }

  // Draw Foxes
  for (const a of state.animals) {
    if (a.type === 'fox') {
      ctx.fillStyle = 'rgb(220, 80, 20)';
      ctx.fillRect(a.x * 10 + 2, a.y * 10 + 2, 4, 4);
    }
  }
}

function drawChart() {
  const rabHist = state.history.map(h => h.rabbits);
  const foxHist = state.history.map(h => h.foxes);
  
  const maxCount = Math.max(...rabHist, ...foxHist, 1);
  const width = 400;
  const height = 200;
  const padding = 20;

  const getX = (i) => padding + (i / Math.max(state.history.length - 1, 1)) * (width - 2 * padding);
  const getY = (val) => height - padding - (val / maxCount) * (height - 2 * padding);

  const rabPoints = state.history.map((h, i) => `${getX(i)},${getY(h.rabbits)}`).join(' ');
  const foxPoints = state.history.map((h, i) => `${getX(i)},${getY(h.foxes)}`).join(' ');

  document.getElementById('series-rabbits').setAttribute('points', rabPoints);
  document.getElementById('series-foxes').setAttribute('points', foxPoints);
}

function drawODE() {
  const alpha = parseFloat(document.getElementById('ode-alpha').value);
  const beta = parseFloat(document.getElementById('ode-beta').value);
  const gamma = parseFloat(document.getElementById('ode-gamma').value);
  const delta = parseFloat(document.getElementById('ode-delta').value);
  const x0 = parseFloat(document.getElementById('ode-x0').value);
  const y0 = parseFloat(document.getElementById('ode-y0').value);
  const t = parseFloat(document.getElementById('ode-t').value);
  const dt = parseFloat(document.getElementById('ode-dt').value);

  const p = { alpha, beta, gamma, delta, x0, y0 };
  const res = ode(p, t, dt);

  // Results
  const eqX = gamma / delta;
  const eqY = alpha / beta;
  const V = (x, y) => delta * x - gamma * Math.log(x) + beta * y - alpha * Math.log(y);
  const startV = V(x0, y0);
  const endV = V(res.x, res.y);
  const drift = Math.abs(endV - startV);

  document.getElementById('ode-results').innerHTML = `
    x: ${res.x.toFixed(8)}<br>
    y: ${res.y.toFixed(8)}<br>
    Eq X (γ/δ): ${eqX.toFixed(8)}<br>
    Eq Y (α/β): ${eqY.toFixed(8)}<br>
    Drift: ${parseFloat(drift).toFixed(8)}
  `;

  // Chart
  const steps = Math.round(t / dt);
  let x = x0, y = y0;
  const ptsX = [];
  const ptsY = [];
  
  // Add start
  ptsX.push(0);
  ptsY.push(0);

  for (let i = 0; i < steps; i++) {
    const k1x = alpha * x - beta * x * y;
    const k1y = delta * x * y - gamma * y;
    
    const k2x = alpha * (x + 0.5 * dt * k1x) - beta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y);
    const k2y = delta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y) - gamma * (y + 0.5 * dt * k1y);
    
    const k3x = alpha * (x + 0.5 * dt * k2x) - beta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y);
    const k3y = delta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y) - gamma * (y + 0.5 * dt * k2y);
    
    const k4x = alpha * (x + dt * k3x) - beta * (x + dt * k3x) * (y + dt * k3y);
    const k4y = delta * (x + dt * k3x) * (y + dt * k3y) - gamma * (y + dt * k3y);
    
    x += dt * (k1x + 2*k2x + 2*k3x + k4x) / 6;
    y += dt * (k1y + 2*k2y + 2*k3y + k4y) / 6;

    ptsX.push(i);
    ptsY.push(i);
  }

  // Map to SVG coords
  const w = 400, h = 150;
  const maxT = steps;
  const mapX = (t) => (t / maxT) * (w - 40) + 20;
  const mapY = (v) => h - 20 - (v / 20) * (h - 40); // Scale arbitrary

  const pX = ptsX.map(mapX).join(' ');
  const pY = ptsY.map(mapY).join(' ');

  document.getElementById('ode-series-x').setAttribute('points', pX);
  document.getElementById('ode-series-y').setAttribute('points', pY);
}

function updateUI() {
  document.getElementById('count-tick').textContent = state.tick;
  document.getElementById('count-rabbits').textContent = state.history[state.history.length-1].rabbits;
  document.getElementById('count-foxes').textContent = state.history[state.history.length-1].foxes;
  document.getElementById('count-grass').textContent = state.history[state.history.length-1].grass;
  
  document.getElementById('seed').value = state.seed;
  document.getElementById('speed').value = state.speed;
  document.getElementById('speed-val').textContent = state.speed;

  // Sliders
  const s = state.params;
  document.getElementById('param-rabbits0').value = s.rabbits0; document.getElementById('val-rabbits0').textContent = s.rabbits0;
  document.getElementById('param-foxes0').value = s.foxes0; document.getElementById('val-foxes0').textContent = s.foxes0;
  document.getElementById('param-rabbitBreed').value = s.rabbitBreed; document.getElementById('val-rabbitBreed').textContent = s.rabbitBreed;
  document.getElementById('param-foxBreed').value = s.foxBreed; document.getElementById('val-foxBreed').textContent = s.foxBreed;
  document.getElementById('param-foxGain').value = s.foxGain; document.getElementById('val-foxGain').textContent = s.foxGain;
  document.getElementById('param-grassMax').value = s.grassMax; document.getElementById('val-grassMax').textContent = s.grassMax;
}

function announce(msg) {
  document.getElementById('announcer').textContent = msg;
}

/* --- Event Listeners --- */

// Controls
document.getElementById('play').onclick = () => {
  state.isPlaying = true;
  state.lastFrameTime = performance.now();
  requestAnimationFrame(gameLoop);
};
document.getElementById('pause').onclick = () => {
  state.isPlaying = false;
  announce(`Paused at Tick ${state.tick}`);
};
document.getElementById('step').onclick = () => {
  step();
  announce(`Tick ${state.tick}: ${state.history[state.history.length-1].rabbits} rabbits, ${state.history[state.history.length-1].foxes} foxes`);
};
document.getElementById('reset').onclick = () => {
  const seed = parseInt(document.getElementById('seed').value) || 42;
  reset(seed, {});
};

// Sliders
['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax'].forEach(id => {
  const el = document.getElementById(`param-${id}`);
  const valEl = document.getElementById(`val-${id}`);
  el.oninput = () => { valEl.textContent = el.value; };
});
document.getElementById('speed').oninput = () => {
  state.speed = parseInt(document.getElementById('speed').value);
  document.getElementById('speed-val').textContent = state.speed;
};

// Chart
document.getElementById('scenario-export').onclick = () => {
  document.getElementById('scenario-json').value = exportScenario();
};
document.getElementById('scenario-load').onclick = () => {
  loadScenario(document.getElementById('scenario-json').value);
};

// Presets
document.getElementById('preset-save').onclick = () => {
  const name = document.getElementById('preset-name').value.trim();
  if (!name) return;
  const storage = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
  storage[name] = exportScenario();
  localStorage.setItem("ecolab.presets", JSON.stringify(storage));
  renderPresets();
  document.getElementById('preset-name').value = '';
};

function renderPresets() {
  const list = document.getElementById('preset-list');
  const storage = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
  list.innerHTML = '';
  for (const [name, json] of Object.entries(storage)) {
    const li = document.createElement('li');
    li.className = 'preset-item';
    li.innerHTML = `
      <span>${name}</span>
      <div>
        <button class="primary" onclick="loadPreset('${name}')">Load</button>
        <button class="danger" onclick="deletePreset('${name}')">Del</button>
      </div>
    `;
    list.appendChild(li);
  }
}

window.loadPreset = (name) => {
  const storage = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
  if (storage[name]) {
    const data = JSON.parse(storage[name]);
    reset(data.seed, data.params);
  }
};

window.deletePreset = (name) => {
  const storage = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
  delete storage[name];
  localStorage.setItem("ecolab.presets", JSON.stringify(storage));
  renderPresets();
};

// ODE
document.getElementById('ode-run').onclick = () => {
  drawODE();
};

// Game Loop
function gameLoop(timestamp) {
  if (!state.isPlaying) return;
  
  const elapsed = timestamp - state.lastFrameTime;
  state.lastFrameTime = timestamp;
  
  // Ticks per second
  const ticksToRun = Math.floor((elapsed / 1000) * state.speed);
  
  for (let i = 0; i < ticksToRun; i++) {
    step();
  }
  
  updateUI();
  drawWorld();
  drawChart();
  announce(`Tick ${state.tick}: ${state.history[state.history.length-1].rabbits} rabbits, ${state.history[state.history.length-1].foxes} foxes`);
  
  requestAnimationFrame(gameLoop);
}

// Keyboard
document.addEventListener('keydown', (e) => {
  const focusable = document.activeElement.tagName.toLowerCase();
  const isInput = ['input', 'textarea', 'select', 'button'].includes(focusable);
  
  if (isInput) return;

  if (e.code === 'Space') {
    if (state.isPlaying) {
      state.isPlaying = false;
      announce(`Paused at Tick ${state.tick}`);
    } else {
      state.isPlaying = true;
      state.lastFrameTime = performance.now();
      requestAnimationFrame(gameLoop);
    }
  } else if (e.key.toLowerCase() === 's') {
    step();
    announce(`Tick ${state.tick}: ${state.history[state.history.length-1].rabbits} rabbits, ${state.history[state.history.length-1].foxes} foxes`);
  } else if (e.key.toLowerCase() === 'r') {
    const seed = parseInt(document.getElementById('seed').value) || 42;
    reset(seed, {});
  }
});

// Init
window.lab = {
  reset, step, counts, tick: () => state.tick, cell, history, ode, exportCSV, exportScenario, loadScenario
};

resizeCanvas();
init();
renderPresets();

</script>
</body>
</html>
```