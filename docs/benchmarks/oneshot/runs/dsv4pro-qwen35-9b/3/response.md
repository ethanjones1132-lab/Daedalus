## Plan

**Data Model:**
- **Grid:** 2D array of size `width` × `height`. Each cell holds `{grass: number, rabbit: object|null, fox: object|null}`.
- **Animals:** Objects `{id: number, x: number, y: number, energy: number}`.
- **State:** `tick`, `history` array, `idCounter`, `params` object, `isPlaying`, `speed`, `timerId`.
- **UI:** Canvas for the world, SVG for the chart, input elements for controls.

**Tick Order:**
1. **Grass Growth:** All cells `grass = min(grassMax, grass + 1)`.
2. **Rabbits:** Iterate sorted by ID. Move (to neighbor with no rabbit), Eat (gain energy, set grass to 0), Lose energy, Breed (if energy >= threshold, place child), Die (if energy <= 0).
3. **Foxes:** Iterate sorted by ID. Move (prioritize rabbit, then empty), Eat (if rabbit present, remove and gain energy), Lose energy, Breed, Die.
4. **Tick Increment:** `tick++`.
5. **History Record:** Push `{tick, rabbits, foxes, grassSum}`.

**Components:**
- **World Canvas:** Renders grid, grass, rabbits, foxes.
- **Chart SVG:** Polyline for rabbits and foxes over time.
- **Lotka-Volterra Panel:** Inputs for parameters, RK4 integration button, results display, trajectory chart.
- **Controls:** Play/Pause, Step, Reset, Speed slider, Parameter sliders.
- **Scenario Tools:** Export/Load JSON, CSV export.
- **Presets:** Save/Load/Delete from localStorage.
- **Announcer:** `aria-live` region for keyboard shortcuts.

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
    --panel-bg: #ffffff;
    --border: #ccc;
    --text: #333;
    --accent: #4a90e2;
    --grass: #2d8a2d;
    --rabbit: #f0f0f0;
    --fox: #dc5014;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding: 20px;
    height: 100vh;
    box-sizing: border-box;
    overflow: hidden;
  }
  * { box-sizing: border-box; }
  
  .container {
    display: flex;
    flex-direction: column;
    gap: 20px;
    height: 100%;
  }
  
  @media (min-width: 1000px) {
    .container {
      flex-direction: row;
    }
    .panel-world {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 15px;
    }
    .panel-side {
      width: 400px;
      display: flex;
      flex-direction: column;
      gap: 15px;
    }
  }
  
  @media (max-width: 700px) {
    .panel-side {
      flex: 1;
      width: 100%;
    }
  }

  .panel {
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 15px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
  }

  h1 { margin: 0 0 10px 0; font-size: 1.5rem; }
  h2 { margin: 0 0 10px 0; font-size: 1.1rem; border-bottom: 1px solid var(--border); padding-bottom: 5px; }

  .controls-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }

  button {
    background: var(--panel-bg);
    border: 1px solid var(--border);
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    transition: background 0.1s;
  }
  button:hover { background: #eee; }
  button:active { background: #ddd; }
  button.primary { background: var(--accent); color: white; border: none; }
  button.primary:hover { background: #357abd; }

  .counter {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    background: #eee;
    padding: 4px 8px;
    border-radius: 4px;
    min-width: 40px;
    text-align: center;
  }

  .input-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }
  .input-group label {
    font-size: 0.8rem;
    color: #666;
    display: flex;
    justify-content: space-between;
  }
  input[type="number"], input[type="text"], select {
    width: 100%;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 0.9rem;
  }
  input[type="range"] {
    width: 100%;
  }

  .canvas-wrapper {
    width: 100%;
    height: 300px;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
    background: #fafafa;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }

  .chart-container {
    height: 200px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: #fafafa;
  }
  svg {
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .axis-label { font-size: 0.7rem; fill: #666; }
  .series-line { stroke-width: 2; fill: none; }
  .series-rabbits { stroke: var(--accent); }
  .series-foxes { stroke: var(--fox); }

  .od-panel {
    background: #f9f9f9;
    padding: 10px;
    border-radius: 4px;
    font-size: 0.85rem;
  }
  .od-inputs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-bottom: 8px;
  }
  .od-results {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }
  .od-result {
    background: #eee;
    padding: 4px 6px;
    border-radius: 3px;
  }

  .preset-list {
    max-height: 150px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .preset-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    border-bottom: 1px solid #eee;
    font-size: 0.9rem;
  }
  .preset-item:last-child { border-bottom: none; }
  .preset-actions { display: flex; gap: 4px; }

  .error-msg {
    color: #d32f2f;
    font-size: 0.8rem;
    min-height: 1.2em;
    margin-top: 4px;
  }
</style>
</head>
<body>

<div class="container">
  <div class="panel panel-world">
    <h1>Ecosystem Lab</h1>
    
    <div class="controls-row">
      <button id="play" class="primary">Play</button>
      <button id="pause">Pause</button>
      <button id="step">Step</button>
      <button id="reset">Reset</button>
      <input type="number" id="seed" value="42" style="width: 60px; text-align: center;">
      <label for="speed">Speed: <span id="speed-val">10</span> t/s</label>
      <input type="range" id="speed" min="1" max="60" value="10">
    </div>

    <div class="controls-row">
      <div class="counter" data-testid="count-rabbits">Rabbits: 0</div>
      <div class="counter" data-testid="count-foxes">Foxes: 0</div>
      <div class="counter" data-testid="count-grass">Grass: 0</div>
      <div class="counter" id="tick-display">Tick: 0</div>
    </div>

    <div class="canvas-wrapper">
      <canvas data-testid="world" width="400" height="300"></canvas>
    </div>

    <div class="panel" style="flex: 1; display: flex; flex-direction: column; gap: 10px;">
      <h2>Parameters</h2>
      <div class="input-group">
        <label for="param-rabbits0">Rabbits 0</label>
        <input type="range" id="param-rabbits0" min="0" max="300" value="100">
      </div>
      <div class="input-group">
        <label for="param-foxes0">Foxes 0</label>
        <input type="range" id="param-foxes0" min="0" max="60" value="6">
      </div>
      <div class="input-group">
        <label for="param-rabbitBreed">Rabbit Breed</label>
        <input type="range" id="param-rabbitBreed" min="2" max="40" value="12">
      </div>
      <div class="input-group">
        <label for="param-foxBreed">Fox Breed</label>
        <input type="range" id="param-foxBreed" min="2" max="60" value="40">
      </div>
      <div class="input-group">
        <label for="param-foxGain">Fox Gain</label>
        <input type="range" id="param-foxGain" min="1" max="30" value="4">
      </div>
      <div class="input-group">
        <label for="param-grassMax">Grass Max</label>
        <input type="range" id="param-grassMax" min="1" max="10" value="4">
      </div>
    </div>
  </div>

  <div class="panel panel-side">
    <h2>Population Chart</h2>
    <div class="chart-container">
      <svg data-testid="chart" width="100%" height="100%">
        <!-- Axes and series will be drawn by JS -->
      </svg>
    </div>

    <h2>Lotka-Volterra</h2>
    <div class="od-panel">
      <div class="od-inputs">
        <div class="input-group">
          <label for="ode-alpha">α</label>
          <input type="number" id="ode-alpha" step="0.1" value="1.1">
        </div>
        <div class="input-group">
          <label for="ode-beta">β</label>
          <input type="number" id="ode-beta" step="0.1" value="0.4">
        </div>
        <div class="input-group">
          <label for="ode-gamma">γ</label>
          <input type="number" id="ode-gamma" step="0.1" value="0.4">
        </div>
        <div class="input-group">
          <label for="ode-delta">δ</label>
          <input type="number" id="ode-delta" step="0.1" value="0.1">
        </div>
        <div class="input-group">
          <label for="ode-x0">x₀</label>
          <input type="number" id="ode-x0" step="1" value="10">
        </div>
        <div class="input-group">
          <label for="ode-y0">y₀</label>
          <input type="number" id="ode-y0" step="1" value="10">
        </div>
        <div class="input-group">
          <label for="ode-t">t</label>
          <input type="number" id="ode-t" step="1" value="50">
        </div>
        <div class="input-group">
          <label for="ode-dt">dt</label>
          <input type="number" id="ode-dt" step="0.01" value="0.01">
        </div>
      </div>
      <button id="ode-run">Run ODE</button>
      <div class="od-results">
        <div class="od-result">x = <span id="ode-x">-</span></div>
        <div class="od-result">y = <span id="ode-y">-</span></div>
        <div class="od-result">Eq x = <span id="ode-eq-x">-</span></div>
        <div class="od-result">Eq y = <span id="ode-eq-y">-</span></div>
        <div class="od-result">Drift = <span id="ode-drift">-</span></div>
      </div>
      <div class="chart-container" style="height: 120px;">
        <svg data-testid="ode-chart" width="100%" height="100%">
          <!-- ODE series -->
        </svg>
      </div>
    </div>

    <h2>Scenario</h2>
    <div class="input-group">
      <label for="scenario-json">JSON</label>
      <textarea id="scenario-json" rows="3"></textarea>
    </div>
    <div class="controls-row">
      <button id="scenario-export">Export</button>
      <button id="scenario-load">Load</button>
    </div>
    <div class="error-msg" id="scenario-error"></div>

    <h2>Presets</h2>
    <div class="controls-row">
      <input type="text" id="preset-name" placeholder="Preset name" style="width: 120px;">
      <button id="preset-save">Save</button>
    </div>
    <div class="preset-list" id="preset-list">
      <!-- Preset items go here -->
    </div>
  </div>
</div>

<div id="announcer" aria-live="polite"></div>

<script>
(function() {
  // --- Constants & Defaults ---
  const DEFAULTS = {
    width: 40, height: 30, grassMax: 4,
    rabbits0: 100, foxes0: 6,
    rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
    foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
  };

  // --- State ---
  let state = {
    params: {},
    grid: [],
    rabbits: [],
    foxes: [],
    tick: 0,
    history: [],
    idCounter: 1,
    isPlaying: false,
    speed: 10,
    timerId: null,
    seed: 42,
    rand: null,
    chartData: { rabbits: [], foxes: [] },
    odeData: { x: [], y: [] }
  };

  // --- DOM Elements ---
  const canvas = document.querySelector('[data-testid="world"]');
  const ctx = canvas.getContext('2d');
  const chartSvg = document.querySelector('[data-testid="chart"]');
  const odeChartSvg = document.querySelector('[data-testid="ode-chart"]');
  const announcer = document.getElementById('announcer');

  // --- Helpers ---
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

  function pick(list) {
    if (list.length === 0) return null;
    return list[Math.floor(state.rand() * list.length)];
  }

  function getNeighbors(x, y) {
    const neighbors = [];
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // Up, Right, Down, Left
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < state.params.width && ny >= 0 && ny < state.params.height) {
        neighbors.push({x: nx, y: ny});
      }
    }
    return neighbors;
  }

  function getCell(x, y) {
    if (x < 0 || x >= state.params.width || y < 0 || y >= state.params.height) return null;
    return state.grid[y][x];
  }

  function getEmptyRabbitNeighbors(x, y) {
    const neighbors = getNeighbors(x, y);
    return neighbors.filter(n => !getCell(n.x, n.y).rabbit);
  }

  function getEmptyFoxNeighbors(x, y) {
    const neighbors = getNeighbors(x, y);
    return neighbors.filter(n => !getCell(n.x, n.y).fox);
  }

  function getRabbitNeighbors(x, y) {
    const neighbors = getNeighbors(x, y);
    return neighbors.filter(n => getCell(n.x, n.y).rabbit);
  }

  function getEmptyFoxNeighborsWithRabbit(x, y) {
    const neighbors = getNeighbors(x, y);
    return neighbors.filter(n => getCell(n.x, n.y).rabbit && !getCell(n.x, n.y).fox);
  }

  function getEmptyFoxNeighborsNoRabbit(x, y) {
    const neighbors = getNeighbors(x, y);
    return neighbors.filter(n => !getCell(n.x, n.y).fox && !getCell(n.x, n.y).rabbit);
  }

  function getEmptyFoxNeighbors(x, y) {
    const neighbors = getNeighbors(x, y);
    return neighbors.filter(n => !getCell(n.x, n.y).fox);
  }

  function getEmptyFoxNeighborsNoRabbit(x, y) {
    const neighbors = getNeighbors(x, y);
    return neighbors.filter(n => !getCell(n.x, n.y).fox && !getCell(n.x, n.y).rabbit);
  }

  // --- Core Simulation ---
  function reset(seed, params = {}) {
    state.seed = seed;
    state.rand = mulberry32(seed);
    state.tick = 0;
    state.history = [];
    state.idCounter = 1;
    state.isPlaying = false;
    if (state.timerId) clearInterval(state.timerId);
    
    // Merge params
    state.params = { ...DEFAULTS, ...params };
    
    // Init Grid
    state.grid = Array(state.params.height).fill(null).map(() => 
      Array(state.params.width).fill(null).map(() => ({ grass: 0, rabbit: null, fox: null }))
    );

    // Init Rabbits
    for (let i = 0; i < state.params.rabbits0; i++) {
      const emptyCells = [];
      for (let y = 0; y < state.params.height; y++) {
        for (let x = 0; x < state.params.width; x++) {
          if (!getCell(x, y).rabbit) emptyCells.push({x, y});
        }
      }
      const spot = pick(emptyCells);
      if (spot) {
        state.rabbits.push({
          id: state.idCounter++,
          x: spot.x, y: spot.y,
          energy: state.params.rabbitStart
        });
      }
    }

    // Init Foxes
    for (let i = 0; i < state.params.foxes0; i++) {
      const emptyCells = [];
      for (let y = 0; y < state.params.height; y++) {
        for (let x = 0; x < state.params.width; x++) {
          if (!getCell(x, y).fox) emptyCells.push({x, y});
        }
      }
      const spot = pick(emptyCells);
      if (spot) {
        state.foxes.push({
          id: state.idCounter++,
          x: spot.x, y: spot.y,
          energy: state.params.foxStart
        });
      }
    }

    // Record initial history
    recordHistory();
    drawWorld();
    drawChart();
    updateCounters();
    updateOdeChart();
    return counts();
  }

  function step(n = 1) {
    for (let i = 0; i < n; i++) {
      if (state.isPlaying && state.timerId) clearInterval(state.timerId);
      
      // 1. Grass
      for (let y = 0; y < state.params.height; y++) {
        for (let x = 0; x < state.params.width; x++) {
          state.grid[y][x].grass = Math.min(state.params.grassMax, state.grid[y][x].grass + 1);
        }
      }

      // 2. Rabbits
      const rabbitsAlive = [...state.rabbits].sort((a, b) => a.id - b.id);
      for (const rabbit of rabbitsAlive) {
        // Move
        const emptyNeighbors = getEmptyRabbitNeighbors(rabbit.x, rabbit.y);
        if (emptyNeighbors.length > 0) {
          const move = pick(emptyNeighbors);
          if (move) {
            state.grid[rabbit.y][rabbit.x].rabbit = null;
            rabbit.x = move.x; rabbit.y = move.y;
            state.grid[rabbit.y][rabbit.x].rabbit = rabbit;
          }
        }
        // Eat
        const cell = getCell(rabbit.x, rabbit.y);
        if (cell && cell.grass > 0) {
          rabbit.energy += state.params.rabbitGain * cell.grass;
          cell.grass = 0;
        }
        // Cost
        rabbit.energy -= state.params.rabbitCost;
        // Breed
        if (rabbit.energy >= state.params.rabbitBreed) {
          const emptyNeighbors = getEmptyRabbitNeighbors(rabbit.x, rabbit.y);
          if (emptyNeighbors.length > 0) {
            const spot = pick(emptyNeighbors);
            const childEnergy = Math.floor(rabbit.energy / 2);
            rabbit.energy -= childEnergy;
            state.rabbits.push({
              id: state.idCounter++,
              x: spot.x, y: spot.y,
              energy: childEnergy
            });
          }
        }
        // Die
        if (rabbit.energy <= 0) {
          state.grid[rabbit.y][rabbit.x].rabbit = null;
          state.rabbits = state.rabbits.filter(r => r.id !== rabbit.id);
        }
      }

      // 3. Foxes
      const foxesAlive = [...state.foxes].sort((a, b) => a.id - b.id);
      for (const fox of foxesAlive) {
        // Move
        const hasRabbit = getRabbitNeighbors(fox.x, fox.y).length > 0;
        let moveCandidates = [];
        if (hasRabbit) {
          moveCandidates = getEmptyFoxNeighborsWithRabbit(fox.x, fox.y);
        }
        if (moveCandidates.length === 0) {
          moveCandidates = getEmptyFoxNeighborsNoRabbit(fox.x, fox.y);
        }
        if (moveCandidates.length > 0) {
          const move = pick(moveCandidates);
          if (move) {
            state.grid[fox.y][fox.x].fox = null;
            fox.x = move.x; fox.y = move.y;
            state.grid[fox.y][fox.x].fox = fox;
          }
        }
        // Eat
        const cell = getCell(fox.x, fox.y);
        if (cell && cell.rabbit) {
          state.grid[fox.y][fox.x].rabbit = null;
          fox.energy += state.params.foxGain;
        }
        // Cost
        fox.energy -= state.params.foxCost;
        // Breed
        if (fox.energy >= state.params.foxBreed) {
          const emptyNeighbors = getEmptyFoxNeighbors(fox.x, fox.y);
          if (emptyNeighbors.length > 0) {
            const spot = pick(emptyNeighbors);
            const childEnergy = Math.floor(fox.energy / 2);
            fox.energy -= childEnergy;
            state.foxes.push({
              id: state.idCounter++,
              x: spot.x, y: spot.y,
              energy: childEnergy
            });
          }
        }
        // Die
        if (fox.energy <= 0) {
          state.grid[fox.y][fox.x].fox = null;
          state.foxes = state.foxes.filter(f => f.id !== fox.id);
        }
      }

      state.tick++;
      recordHistory();
      drawWorld();
      drawChart();
      updateCounters();
    }
    if (state.isPlaying) {
      state.timerId = setInterval(() => step(1), 1000 / state.speed);
    }
    return counts();
  }

  function recordHistory() {
    const grassSum = state.grid.reduce((sum, row) => sum + row.reduce((r, c) => r + c.grass, 0), 0);
    state.history.push({
      tick: state.tick,
      rabbits: state.rabbits.length,
      foxes: state.foxes.length,
      grass: grassSum
    });
  }

  function counts() {
    const grassSum = state.grid.reduce((sum, row) => sum + row.reduce((r, c) => r + c.grass, 0), 0);
    return {
      rabbits: state.rabbits.length,
      foxes: state.foxes.length,
      grass: grassSum
    };
  }

  function tick() {
    return state.tick;
  }

  function cell(x, y) {
    const c = getCell(x, y);
    return {
      grass: c ? c.grass : 0,
      rabbit: c ? (c.rabbit ? { id: c.rabbit.id, energy: c.rabbit.energy } : null) : null,
      fox: c ? (c.fox ? { id: c.fox.id, energy: c.fox.energy } : null) : null
    };
  }

  function history() {
    return state.history;
  }

  function ode(p, t, dt) {
    const alpha = p.alpha, beta = p.beta, gamma = p.gamma, delta = p.delta;
    const x0 = p.x0, y0 = p.y0;
    const n = Math.round(t / dt);
    
    let x = x0, y = y0;
    for (let i = 0; i < n; i++) {
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
    state.history.forEach(h => {
      csv += `${h.tick},${h.rabbits},${h.foxes},${h.grass}\n`;
    });
    return csv;
  }

  function exportScenario() {
    return JSON.stringify({
      version: 1,
      seed: state.seed,
      params: state.params
    });
  }

  function loadScenario(text) {
    try {
      const data = JSON.parse(text);
      if (data.version !== 1) throw new Error("Invalid version");
      if (typeof data.seed !== 'number' || !Number.isInteger(data.seed)) throw new Error("Invalid seed");
      reset(data.seed, data.params);
      document.getElementById('scenario-error').textContent = '';
      return true;
    } catch (e) {
      document.getElementById('scenario-error').textContent = e.message;
      return false;
    }
  }

  // --- Rendering ---
  function drawWorld() {
    const w = state.params.width, h = state.params.height;
    const cellW = canvas.width / w;
    const cellH = canvas.height / h;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Grass
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = state.grid[y][x].grass;
        const G = 60 + Math.round(160 * g / state.params.grassMax);
        ctx.fillStyle = `rgb(30, ${G}, 30)`;
        ctx.fillRect(x * cellW, y * cellH, cellW, cellH);
      }
    }

    // Rabbits
    for (const r of state.rabbits) {
      const cx = r.x * cellW + cellW / 2;
      const cy = r.y * cellH + cellH / 2;
      ctx.fillStyle = 'rgb(240, 240, 240)';
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(cellW, cellH) / 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Foxes
    for (const f of state.foxes) {
      const cx = f.x * cellW + cellW / 2;
      const cy = f.y * cellH + cellH / 2;
      ctx.fillStyle = 'rgb(220, 80, 20)';
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(cellW, cellH) / 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawChart() {
    const w = chartSvg.clientWidth || 400;
    const h = chartSvg.clientHeight || 200;
    const padding = 20;
    const chartW = w - padding * 2;
    const chartH = h - padding * 2;

    // Clear
    chartSvg.innerHTML = '';

    // Axes
    const xScale = chartW / (state.history.length || 1);
    const yMax = Math.max(...state.history.map(h => h.rabbits), ...state.history.map(h => h.foxes), 1);
    const yScale = chartH / yMax;

    // Rabbits
    const rabbitPoints = state.history.map((h, i) => ({
      x: i * xScale + padding,
      y: h.rabbits * yScale + padding
    }));
    const rabbitPath = `M ${rabbitPoints[0].x} ${rabbitPoints[0].y}`;
    for (let i = 1; i < rabbitPoints.length; i++) {
      rabbitPath += ` L ${rabbitPoints[i].x} ${rabbitPoints[i].y}`;
    }
    const rabbitPoly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    rabbitPoly.setAttribute("data-testid", "series-rabbits");
    rabbitPoly.setAttribute("class", "series-line series-rabbits");
    rabbitPoly.setAttribute("points", rabbitPath);
    chartSvg.appendChild(rabbitPoly);

    // Foxes
    const foxPoints = state.history.map((h, i) => ({
      x: i * xScale + padding,
      y: h.foxes * yScale + padding
    }));
    const foxPath = `M ${foxPoints[0].x} ${foxPoints[0].y}`;
    for (let i = 1; i < foxPoints.length; i++) {
      foxPath += ` L ${foxPoints[i].x} ${foxPoints[i].y}`;
    }
    const foxPoly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    foxPoly.setAttribute("data-testid", "series-foxes");
    foxPoly.setAttribute("class", "series-line series-foxes");
    foxPoly.setAttribute("points", foxPath);
    chartSvg.appendChild(foxPoly);

    // Labels
    const xAxis = document.createElementNS("http://www.w3.org/2000/svg", "text");
    xAxis.setAttribute("x", w / 2);
    xAxis.setAttribute("y", h - 5);
    xAxis.setAttribute("text-anchor", "middle");
    xAxis.setAttribute("class", "axis-label");
    xAxis.textContent = "tick";
    chartSvg.appendChild(xAxis);

    const yAxis = document.createElementNS("http://www.w3.org/2000/svg", "text");
    yAxis.setAttribute("x", 5);
    yAxis.setAttribute("y", h / 2);
    yAxis.setAttribute("text-anchor", "end");
    yAxis.setAttribute("class", "axis-label");
    yAxis.textContent = "count";
    chartSvg.appendChild(yAxis);
  }

  function updateOdeChart() {
    const w = odeChartSvg.clientWidth || 200;
    const h = odeChartSvg.clientHeight || 120;
    const padding = 10;
    const chartW = w - padding * 2;
    const chartH = h - padding * 2;

    odeChartSvg.innerHTML = '';

    const xMax = Math.max(...state.odeData.x, 1);
    const yMax = Math.max(...state.odeData.y, 1);
    const xScale = chartW / xMax;
    const yScale = chartH / yMax;

    // X series
    const xPoints = state.odeData.x.map((v, i) => ({
      x: i * xScale + padding,
      y: v * yScale + padding
    }));
    const xPath = `M ${xPoints[0].x} ${xPoints[0].y}`;
    for (let i = 1; i < xPoints.length; i++) xPath += ` L ${xPoints[i].x} ${xPoints[i].y}`;
    const xPoly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    xPoly.setAttribute("data-testid", "ode-series-x");
    xPoly.setAttribute("class", "series-line series-rabbits");
    xPoly.setAttribute("points", xPath);
    odeChartSvg.appendChild(xPoly);

    // Y series
    const yPoints = state.odeData.y.map((v, i) => ({
      x: i * xScale + padding,
      y: v * yScale + padding
    }));
    const yPath = `M ${yPoints[0].x} ${yPoints[0].y}`;
    for (let i = 1; i < yPoints.length; i++) yPath += ` L ${yPoints[i].x} ${yPoints[i].y}`;
    const yPoly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    yPoly.setAttribute("data-testid", "ode-series-y");
    yPoly.setAttribute("class", "series-line series-foxes");
    yPoly.setAttribute("points", yPath);
    odeChartSvg.appendChild(yPoly);
  }

  function updateCounters() {
    document.querySelector('[data-testid="count-rabbits"]').textContent = `Rabbits: ${counts().rabbits}`;
    document.querySelector('[data-testid="count-foxes"]').textContent = `Foxes: ${counts().foxes}`;
    document.querySelector('[data-testid="count-grass"]').textContent = `Grass: ${counts().grass}`;
    document.getElementById('tick-display').textContent = `Tick: ${state.tick}`;
  }

  function announce() {
    announcer.textContent = `Tick ${state.tick}: ${counts().rabbits} rabbits, ${counts().foxes} foxes`;
  }

  // --- ODE Logic ---
  function runODE() {
    const p = {
      alpha: parseFloat(document.getElementById('ode-alpha').value),
      beta: parseFloat(document.getElementById('ode-beta').value),
      gamma: parseFloat(document.getElementById('ode-gamma').value),
      delta: parseFloat(document.getElementById('ode-delta').value),
      x0: parseFloat(document.getElementById('ode-x0').value),
      y0: parseFloat(document.getElementById('ode-y0').value),
      t: parseFloat(document.getElementById('ode-t').value),
      dt: parseFloat(document.getElementById('ode-dt').value)
    };
    
    const result = ode(p, p.t, p.dt);
    
    document.getElementById('ode-x').textContent = result.x.toFixed(8);
    document.getElementById('ode-y').textContent = result.y.toFixed(8);
    document.getElementById('ode-eq-x').textContent = (p.gamma / p.delta).toFixed(8);
    document.getElementById('ode-eq-y').textContent = (p.alpha / p.beta).toFixed(8);
    
    // Drift
    const V_start = p.delta * p.x0 - p.gamma * Math.log(p.x0) + p.beta * p.y0 - p.alpha * Math.log(p.y0);
    const V_end = p.delta * result.x - p.gamma * Math.log(result.x) + p.beta * result.y - p.alpha * Math.log(result.y);
    const drift = Math.abs(V_end - V_start);
    document.getElementById('ode-drift').textContent = parseFloat(drift.toFixed(8));
    
    // Update chart
    state.odeData = { x: [], y: [] };
    let x = p.x0, y = p.y0;
    const n = Math.round(p.t / p.dt);
    for (let i = 0; i <= n; i++) {
      state.odeData.x.push(x);
      state.odeData.y.push(y);
      if (i < n) {
        const k1x = p.alpha * x - p.beta * x * y;
        const k1y = p.delta * x * y - p.gamma * y;
        const k2x = p.alpha * (x + 0.5 * p.dt * k1x) - p.beta * (x + 0.5 * p.dt * k1x) * (y + 0.5 * p.dt * k1y);
        const k2y = p.delta * (x + 0.5 * p.dt * k1x) * (y + 0.5 * p.dt * k1y) - p.gamma * (y + 0.5 * p.dt * k1y);
        const k3x = p.alpha * (x + 0.5 * p.dt * k2x) - p.beta * (x + 0.5 * p.dt * k2x) * (y + 0.5 * p.dt * k2y);
        const k3y = p.delta * (x + 0.5 * p.dt * k2x) * (y + 0.5 * p.dt * k2y) - p.gamma * (y + 0.5 * p.dt * k2y);
        const k4x = p.alpha * (x + p.dt * k3x) - p.beta * (x + p.dt * k3x) * (y + p.dt * k3y);
        const k4y = p.delta * (x + p.dt * k3x) * (y + p.dt * k3y) - p.gamma * (y + p.dt * k3y);
        x += p.dt * (k1x + 2*k2x + 2*k3x + k4x) / 6;
        y += p.dt * (k1y + 2*k2y + 2*k3y + k4y) / 6;
      }
    }
    updateOdeChart();
  }

  // --- Presets ---
  function savePreset(name) {
    const scenario = {
      version: 1,
      seed: state.seed,
      params: state.params
    };
    let presets = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
    presets[name] = scenario;
    localStorage.setItem("ecolab.presets", JSON.stringify(presets));
    renderPresets();
  }

  function loadPreset(name) {
    const presets = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
    if (presets[name]) {
      loadScenario(JSON.stringify(presets[name]));
    }
  }

  function deletePreset(name) {
    let presets = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
    delete presets[name];
    localStorage.setItem("ecolab.presets", JSON.stringify(presets));
    renderPresets();
  }

  function renderPresets() {
    const list = document.getElementById('preset-list');
    list.innerHTML = '';
    const presets = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
    Object.keys(presets).forEach(name => {
      const item = document.createElement('div');
      item.className = 'preset-item';
      item.innerHTML = `
        <span>${name}</span>
        <div class="preset-actions">
          <button data-preset-load="${name}">Load</button>
          <button data-preset-delete="${name}">Delete</button>
        </div>
      `;
      list.appendChild(item);
    });
  }

  // --- Initialization ---
  function init() {
    reset(42, {});
    renderPresets();
    
    // Event Listeners
    document.getElementById('play').addEventListener('click', () => {
      if (!state.isPlaying) {
        state.isPlaying = true;
        step(1); // Run one tick immediately
        state.timerId = setInterval(() => step(1), 1000 / state.speed);
      }
    });
    
    document.getElementById('pause').addEventListener('click', () => {
      state.isPlaying = false;
      if (state.timerId) clearInterval(state.timerId);
    });
    
    document.getElementById('step').addEventListener('click', () => {
      step(1);
    });
    
    document.getElementById('reset').addEventListener('click', () => {
      const seed = parseInt(document.getElementById('seed').value, 10);
      reset(seed, {});
    });
    
    document.getElementById('speed').addEventListener('input', (e) => {
      state.speed = parseInt(e.target.value, 10);
      document.getElementById('speed-val').textContent = state.speed;
      if (state.isPlaying) {
        clearInterval(state.timerId);
        state.timerId = setInterval(() => step(1), 1000 / state.speed);
      }
    });
    
    // Parameter sliders update params but don't apply until reset
    ['param-rabbits0', 'param-foxes0', 'param-rabbitBreed', 'param-foxBreed', 'param-foxGain', 'param-grassMax'].forEach(id => {
      document.getElementById(id).addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        const param = id.replace('param-', '');
        state.params[param] = val;
      });
    });
    
    // ODE
    document.getElementById('ode-run').addEventListener('click', runODE);
    
    // Scenario
    document.getElementById('scenario-export').addEventListener('click', () => {
      document.getElementById('scenario-json').value = exportScenario();
    });
    document.getElementById('scenario-load').addEventListener('click', () => {
      const text = document.getElementById('scenario-json').value;
      loadScenario(text);
    });
    
    // Presets
    document.getElementById('preset-save').addEventListener('click', () => {
      const name = document.getElementById('preset-name').value.trim();
      if (name) savePreset(name);
    });
    document.addEventListener('click', (e) => {
      if (e.target.matches('[data-preset-load]')) {
        loadPreset(e.target.dataset.presetLoad);
      }
      if (e.target.matches('[data-preset-delete]')) {
        deletePreset(e.target.dataset.presetDelete);
      }
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      
      if (e.code === 'Space') {
        if (state.isPlaying) {
          state.isPlaying = false;
          clearInterval(state.timerId);
        } else {
          state.isPlaying = true;
          step(1);
          state.timerId = setInterval(() => step(1), 1000 / state.speed);
        }
        announce();
      } else if (e.key.toLowerCase() === 's') {
        step(1);
      } else if (e.key.toLowerCase() === 'r') {
        const seed = parseInt(document.getElementById('seed').value, 10);
        reset(seed, {});
      }
    });
  }

  init();
})();
</script>
</body>
</html>
```