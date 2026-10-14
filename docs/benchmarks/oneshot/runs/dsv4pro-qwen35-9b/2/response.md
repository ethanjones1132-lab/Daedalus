## Plan

**Data Model:**
- **Grid:** 2D array of cells. Each cell holds `grass` (0 to `grassMax`), `rabbit` (object with `id`, `energy` or null), `fox` (object with `id`, `energy` or null).
- **Animals:** Array of objects `{id, x, y, energy}`. `id` is a global counter starting at 1.
- **State:** `tick` (current tick), `history` (array of `{tick, rabbits, foxes, grass}`), `rand` (Mulberry32 generator), `playing` (boolean), `speed` (ticks/sec).

**Tick Order:**
1. **Grass:** `grass = min(grassMax, grass + 1)` for all cells.
2. **Rabbits:** Iterate sorted by `id`. For each: Move (pick neighbor without rabbit), Eat (add `rabbitGain * grass`, set grass to 0), Cost (`energy -= rabbitCost`), Breed (if `energy >= rabbitBreed`, pick neighbor without rabbit, spawn child with `energy/2`, parent loses `child`), Die (if `energy <= 0`).
3. **Foxes:** Iterate sorted by `id`. For each: Move (prioritize neighbors with rabbit, then neighbors without fox), Eat (if cell has rabbit, remove it, add `foxGain`), Cost (`energy -= foxCost`), Breed (if `energy >= foxBreed`, pick neighbor without fox, spawn child, parent loses `child`), Die (if `energy <= 0`).
4. **Tick Increment:** `tick++`. Record history point.

**Components:**
- **Canvas:** Renders grid, grass, rabbits, foxes.
- **Chart:** SVG polyline for rabbit/fox populations over time.
- **Lotka-Volterra Panel:** RK4 integrator for ODEs, displaying trajectory and equilibrium points.
- **Controls:** Play/Pause/Step/Reset, Seed input, Speed slider, Parameter sliders.
- **Scenario Tools:** Export/Load JSON, CSV export.
- **Presets:** Save/Load/Delete from localStorage.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ecosystem Lab</title>
<style>
  :root {
    --bg: #f8f9fa;
    --panel-bg: #ffffff;
    --border: #dee2e6;
    --text: #212529;
    --primary: #0d6efd;
    --danger: #dc3545;
    --success: #198754;
    --rabbit: #f0f0f0;
    --fox: #dc5014;
    --grass-base: #1e301e;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    overflow: hidden;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 10px;
    gap: 10px;
  }

  .panel {
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    flex-shrink: 0;
  }

  .panel-header {
    font-weight: 600;
    margin-bottom: 10px;
    padding-bottom: 5px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  /* Layout */
  .main-content {
    display: flex;
    flex: 1;
    gap: 10px;
    overflow: hidden;
  }

  .panel-world {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  .panel-side {
    width: 320px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    max-height: 100%;
  }

  @media (max-width: 700px) {
    .main-content {
      flex-direction: column;
    }
    .panel-side {
      width: 100%;
      max-height: 300px;
    }
  }

  /* Canvas */
  #world {
    background: #000;
    border-radius: 4px;
    flex: 1;
    min-height: 200px;
    width: 100%;
  }

  /* Controls */
  .controls-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }

  button {
    background: var(--panel-bg);
    border: 1px solid var(--border);
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
    transition: background 0.1s;
  }
  button:hover { background: #e9ecef; }
  button:active { background: #dee2e6; }
  button.primary { background: var(--primary); color: white; border: none; }
  button.primary:hover { background: #0b5ed7; }
  button.danger { background: var(--danger); color: white; border: none; }
  button.danger:hover { background: #bb2d3b; }

  .input-group {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.9em;
  }
  .input-group input[type="number"] {
    width: 60px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .input-group input[type="range"] {
    width: 80px;
  }

  .counter {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    background: #e9ecef;
    font-size: 0.9em;
  }

  /* Sliders */
  .slider-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85em;
    margin-bottom: 4px;
  }
  .slider-row label { flex: 1; }
  .slider-row input[type="range"] { flex: 2; }
  .slider-row span { width: 30px; text-align: right; font-variant-numeric: tabular-nums; }

  /* Chart */
  .chart-container {
    height: 150px;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px;
    background: #f8f9fa;
  }
  svg { width: 100%; height: 100%; }
  polyline { stroke-width: 2; fill: none; }
  .series-rabbits { stroke: var(--primary); }
  .series-foxes { stroke: var(--danger); }

  /* Lotka Volterra */
  .ode-panel {
    font-size: 0.85em;
  }
  .ode-inputs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    margin-bottom: 8px;
  }
  .ode-inputs input {
    width: 100%;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .ode-results {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    font-size: 0.8em;
    margin-bottom: 8px;
  }
  .ode-results div {
    background: #f8f9fa;
    padding: 4px;
    border-radius: 4px;
  }
  .ode-results strong { font-size: 0.9em; }

  /* Presets */
  .preset-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 150px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px;
  }
  .preset-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 8px;
    background: #f8f9fa;
    border-radius: 4px;
    font-size: 0.85em;
  }
  .preset-item button {
    padding: 2px 6px;
    font-size: 0.75em;
    margin-left: 4px;
  }

  /* Scenario */
  .scenario-box {
    font-size: 0.8em;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .scenario-box textarea {
    font-family: monospace;
    resize: vertical;
    min-height: 60px;
    font-size: 0.75em;
  }

  /* Announcer */
  #announcer {
    position: absolute;
    bottom: 10px;
    right: 10px;
    background: rgba(0,0,0,0.7);
    color: white;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.8em;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
  }
  #announcer.visible { opacity: 1; }

  /* Error */
  .error-msg {
    color: var(--danger);
    font-size: 0.85em;
    min-height: 1.2em;
    margin-top: 4px;
  }
</style>
</head>
<body>

<div class="app">
  <div class="main-content">
    <div class="panel panel-world">
      <div class="panel-header">
        <span>Ecosystem Lab</span>
        <div class="controls-row">
          <button id="play" class="primary">Play</button>
          <button id="pause">Pause</button>
          <button id="step">Step</button>
          <button id="reset">Reset</button>
        </div>
      </div>

      <div class="controls-row">
        <div class="input-group">
          <label for="seed">Seed:</label>
          <input type="number" id="seed" value="42">
        </div>
        <div class="input-group">
          <label for="speed">Speed:</label>
          <input type="range" id="speed" min="1" max="60" value="10">
          <span id="speed-val">10</span>
        </div>
        <div class="counter" data-testid="count-tick">Tick: 0</div>
        <div class="counter" data-testid="count-rabbits">Rabbits: 0</div>
        <div class="counter" data-testid="count-foxes">Foxes: 0</div>
        <div class="counter" data-testid="count-grass">Grass: 0</div>
      </div>

      <div class="panel-header">Parameters</div>
      <div class="slider-row">
        <label for="param-rabbits0">Rabbits 0</label>
        <input type="range" id="param-rabbits0" min="0" max="300" value="100">
        <span id="val-rabbits0">100</span>
      </div>
      <div class="slider-row">
        <label for="param-foxes0">Foxes 0</label>
        <input type="range" id="param-foxes0" min="0" max="60" value="6">
        <span id="val-foxes0">6</span>
      </div>
      <div class="slider-row">
        <label for="param-rabbitBreed">Rabbit Breed</label>
        <input type="range" id="param-rabbitBreed" min="2" max="40" value="12">
        <span id="val-rabbitBreed">12</span>
      </div>
      <div class="slider-row">
        <label for="param-foxBreed">Fox Breed</label>
        <input type="range" id="param-foxBreed" min="2" max="60" value="40">
        <span id="val-foxBreed">40</span>
      </div>
      <div class="slider-row">
        <label for="param-foxGain">Fox Gain</label>
        <input type="range" id="param-foxGain" min="1" max="30" value="4">
        <span id="val-foxGain">4</span>
      </div>
      <div class="slider-row">
        <label for="param-grassMax">Grass Max</label>
        <input type="range" id="param-grassMax" min="1" max="10" value="4">
        <span id="val-grassMax">4</span>
      </div>

      <div class="panel-header">Population Chart</div>
      <div class="chart-container">
        <svg id="chart" width="100%" height="100%">
          <!-- Polyline will be injected here -->
        </svg>
      </div>
    </div>

    <div class="panel panel-side">
      <div class="panel-header">Lotka-Volterra</div>
      <div class="ode-panel">
        <div class="ode-inputs">
          <input type="number" id="ode-alpha" value="1.1">
          <input type="number" id="ode-beta" value="0.4">
          <input type="number" id="ode-gamma" value="0.4">
          <input type="number" id="ode-delta" value="0.1">
          <input type="number" id="ode-x0" value="10">
          <input type="number" id="ode-y0" value="10">
          <input type="number" id="ode-t" value="50">
          <input type="number" id="ode-dt" value="0.01">
        </div>
        <button id="ode-run">Run ODE</button>
        <div class="ode-results">
          <div><strong>Final X:</strong> <span id="ode-x">-</span></div>
          <div><strong>Final Y:</strong> <span id="ode-y">-</span></div>
          <div><strong>Eq X (γ/δ):</strong> <span id="ode-eq-x">-</span></div>
          <div><strong>Eq Y (α/β):</strong> <span id="ode-eq-y">-</span></div>
          <div><strong>Drift:</strong> <span id="ode-drift">-</span></div>
        </div>
        <div class="chart-container" style="height: 120px;">
          <svg id="ode-chart" width="100%" height="100%">
            <!-- Polyline will be injected here -->
          </svg>
        </div>
      </div>

      <div class="panel-header">Scenario</div>
      <div class="scenario-box">
        <textarea id="scenario-json" placeholder="Paste scenario JSON here..."></textarea>
        <div class="controls-row">
          <button id="scenario-export">Export JSON</button>
          <button id="scenario-load">Load JSON</button>
        </div>
        <div class="error-msg" id="scenario-error"></div>
      </div>

      <div class="panel-header">Presets</div>
      <div class="controls-row">
        <input type="text" id="preset-name" placeholder="Preset name" style="flex:1; padding:4px;">
        <button id="preset-save">Save</button>
      </div>
      <div class="preset-list" id="preset-list">
        <!-- Preset items injected here -->
      </div>
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
    params: { ...DEFAULTS },
    grid: [],
    animals: [],
    tick: 0,
    history: [],
    rand: null,
    playing: false,
    speed: 10,
    lastFrameTime: 0,
    framesSinceLastTick: 0,
    idCounter: 1,
    odeHistory: []
  };

  // --- DOM Elements ---
  const canvas = document.getElementById('world');
  const ctx = canvas.getContext('2d');
  const chartSvg = document.getElementById('chart');
  const odeChartSvg = document.getElementById('ode-chart');
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
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
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

  function getCellKey(x, y) {
    return `${x},${y}`;
  }

  // --- Core Simulation ---
  function reset(seed, params = {}) {
    // Merge params over defaults
    const newParams = { ...DEFAULTS, ...params };
    
    // Initialize grid
    state.grid = [];
    for (let y = 0; y < newParams.height; y++) {
      const row = [];
      for (let x = 0; x < newParams.width; x++) {
        const grass = Math.floor(state.rand() * (newParams.grassMax + 1));
        row.push({ grass, rabbit: null, fox: null });
      }
      state.grid.push(row);
    }

    // Initialize animals
    state.animals = [];
    state.idCounter = 1;

    // Place Rabbits
    for (let i = 0; i < newParams.rabbits0; i++) {
      const available = [];
      for (let y = 0; y < newParams.height; y++) {
        for (let x = 0; x < newParams.width; x++) {
          if (!state.grid[y][x].rabbit) available.push({x, y});
        }
      }
      const spot = pick(available);
      if (spot) {
        state.animals.push({
          id: state.idCounter++,
          x: spot.x, y: spot.y,
          energy: newParams.rabbitStart
        });
      }
    }

    // Place Foxes
    for (let i = 0; i < newParams.foxes0; i++) {
      const available = [];
      for (let y = 0; y < newParams.height; y++) {
        for (let x = 0; x < newParams.width; x++) {
          if (!state.grid[y][x].fox) available.push({x, y});
        }
      }
      const spot = pick(available);
      if (spot) {
        state.animals.push({
          id: state.idCounter++,
          x: spot.x, y: spot.y,
          energy: newParams.foxStart
        });
      }
    }

    // Reset state
    state.tick = 0;
    state.history = [];
    state.odeHistory = [];
    state.params = newParams;
    state.rand = mulberry32(seed);
    state.playing = false;
    state.framesSinceLastTick = 0;
    state.lastFrameTime = 0;

    // Update UI
    updateCounters();
    drawWorld();
    drawChart();
    drawOdeChart();
    updateSliders();
    announcer.textContent = '';
    announcer.classList.remove('visible');
  }

  function step(n = 1) {
    if (state.playing) {
      pause();
    }
    for (let i = 0; i < n; i++) {
      tick();
    }
    updateCounters();
    drawWorld();
    drawChart();
    return counts();
  }

  function tick() {
    const { width, height, grassMax, rabbits0, foxes0, rabbitStart, rabbitGain, rabbitCost, rabbitBreed, foxStart, foxGain, foxCost, foxBreed } = state.params;

    // 1. Grass
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        state.grid[y][x].grass = Math.min(grassMax, state.grid[y][x].grass + 1);
      }
    }

    // 2. Rabbits
    const rabbitsAlive = state.animals.filter(a => a.species === 'rabbit' && a.energy > 0);
    rabbitsAlive.sort((a, b) => a.id - b.id);

    for (const rabbit of rabbitsAlive) {
      // Move
      const neighbors = getNeighbors(rabbit.x, rabbit.y);
      const available = neighbors.filter(n => !getCell(n.x, n.y).rabbit);
      if (available.length > 0) {
        const spot = pick(available);
        rabbit.x = spot.x;
        rabbit.y = spot.y;
      }

      // Eat
      const cell = getCell(rabbit.x, rabbit.y);
      if (cell) {
        rabbit.energy += rabbitGain * cell.grass;
        cell.grass = 0;
      }

      // Cost
      rabbit.energy -= rabbitCost;

      // Breed
      if (rabbit.energy >= rabbitBreed) {
        const neighbors = getNeighbors(rabbit.x, rabbit.y);
        const available = neighbors.filter(n => !getCell(n.x, n.y).rabbit);
        if (available.length > 0) {
          const spot = pick(available);
          const childEnergy = Math.floor(rabbit.energy / 2);
          rabbit.energy -= childEnergy;
          state.animals.push({
            id: state.idCounter++,
            x: spot.x, y: spot.y,
            energy: childEnergy,
            species: 'rabbit'
          });
        }
      }

      // Die
      if (rabbit.energy <= 0) {
        state.animals = state.animals.filter(a => a.id !== rabbit.id);
      }
    }

    // 3. Foxes
    const foxesAlive = state.animals.filter(a => a.species === 'fox' && a.energy > 0);
    foxesAlive.sort((a, b) => a.id - b.id);

    for (const fox of foxesAlive) {
      // Move
      const neighbors = getNeighbors(fox.x, fox.y);
      // Prioritize neighbors with rabbit and no fox
      const withRabbit = neighbors.filter(n => {
        const c = getCell(n.x, n.y);
        return c && c.rabbit && !c.fox;
      });
      const withoutFox = neighbors.filter(n => {
        const c = getCell(n.x, n.y);
        return c && !c.fox;
      });

      let moved = false;
      if (withRabbit.length > 0) {
        const spot = pick(withRabbit);
        fox.x = spot.x;
        fox.y = spot.y;
        moved = true;
      } else if (withoutFox.length > 0) {
        const spot = pick(withoutFox);
        fox.x = spot.x;
        fox.y = spot.y;
        moved = true;
      }

      // Eat
      const cell = getCell(fox.x, fox.y);
      if (cell && cell.rabbit) {
        const rabbit = cell.rabbit;
        // Remove rabbit from animals
        state.animals = state.animals.filter(a => a.id !== rabbit.id);
        fox.energy += foxGain;
      }

      // Cost
      fox.energy -= foxCost;

      // Breed
      if (fox.energy >= foxBreed) {
        const neighbors = getNeighbors(fox.x, fox.y);
        const available = neighbors.filter(n => !getCell(n.x, n.y).fox);
        if (available.length > 0) {
          const spot = pick(available);
          const childEnergy = Math.floor(fox.energy / 2);
          fox.energy -= childEnergy;
          state.animals.push({
            id: state.idCounter++,
            x: spot.x, y: spot.y,
            energy: childEnergy,
            species: 'fox'
          });
        }
      }

      // Die
      if (fox.energy <= 0) {
        state.animals = state.animals.filter(a => a.id !== fox.id);
      }
    }

    // 4. Tick Increment & History
    state.tick++;
    const totalGrass = state.grid.reduce((sum, row) => sum + row.reduce((s, c) => s + c.grass, 0), 0);
    state.history.push({
      tick: state.tick,
      rabbits: state.animals.filter(a => a.species === 'rabbit').length,
      foxes: state.animals.filter(a => a.species === 'fox').length,
      grass: totalGrass
    });

    // Update ODE history if needed (for comparison)
    // (Not strictly required by spec for the main chart, but good for context)

    // Redraw
    drawWorld();
    drawChart();
    updateCounters();
  }

  function counts() {
    return {
      rabbits: state.animals.filter(a => a.species === 'rabbit').length,
      foxes: state.animals.filter(a => a.species === 'fox').length,
      grass: state.grid.reduce((sum, row) => sum + row.reduce((s, c) => s + c.grass, 0), 0)
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
    const { alpha, beta, gamma, delta, x0, y0 } = p;
    const n = Math.round(t / dt);
    let x = x0, y = y0;
    
    const f = (x, y) => ({
      dx: alpha * x - beta * x * y,
      dy: delta * x * y - gamma * y
    });

    for (let i = 0; i < n; i++) {
      const k1 = f(x, y);
      const k2 = f(x + 0.5 * dt * k1.dx, y + 0.5 * dt * k1.dy);
      const k3 = f(x + 0.5 * dt * k2.dx, y + 0.5 * dt * k2.dy);
      const k4 = f(x + dt * k3.dx, y + dt * k3.dy);
      
      x += dt * (k1.dx + 2 * k2.dx + 2 * k3.dx + k4.dx) / 6;
      y += dt * (k1.dy + 2 * k2.dy + 2 * k3.dy + k4.dy) / 6;
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
      seed: state.rand ? (state.rand(0) > 0.5 ? 1 : 0) : 0, // Dummy seed for export
      params: state.params
    });
  }

  function loadScenario(text) {
    try {
      const data = JSON.parse(text);
      if (data.version !== 1) {
        throw new Error("Invalid version");
      }
      if (typeof data.seed !== 'number' || !Number.isInteger(data.seed)) {
        throw new Error("Seed must be an integer");
      }
      reset(data.seed, data.params);
      return true;
    } catch (e) {
      document.getElementById('scenario-error').textContent = e.message;
      return false;
    }
  }

  // --- Rendering ---
  function drawWorld() {
    const { width, height, grassMax } = state.params;
    const cellSize = 10;
    const w = width * cellSize;
    const h = height * cellSize;

    // Set backing size
    canvas.width = w;
    canvas.height = h;

    // Clear
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // Draw Grass
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const g = state.grid[y][x].grass;
        const G = 60 + Math.round(160 * g / grassMax);
        ctx.fillStyle = `rgb(30, ${G}, 30)`;
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
    }

    // Draw Animals
    // Sort by y then x so foxes drawn over rabbits
    const animals = [...state.animals].sort((a, b) => a.x + a.y - (b.x + b.y));
    for (const a of animals) {
      const cx = a.x * cellSize + cellSize / 2;
      const cy = a.y * cellSize + cellSize / 2;
      const color = a.species === 'rabbit' ? 'rgb(240, 240, 240)' : 'rgb(220, 80, 20)';
      
      ctx.fillStyle = color;
      // Draw a simple shape covering central 4x4 pixels
      ctx.fillRect(cx - 2, cy - 2, 4, 4);
    }
  }

  function drawChart() {
    // Clear
    chartSvg.innerHTML = '';

    if (state.history.length === 0) return;

    const maxTick = state.history[state.history.length - 1].tick;
    const maxCount = Math.max(
      ...state.history.map(h => h.rabbits),
      ...state.history.map(h => h.foxes)
    );
    const padding = 20;
    const chartW = chartSvg.clientWidth || 300;
    const chartH = chartSvg.clientHeight || 150;

    const scaleX = (chartW - padding * 2) / maxTick;
    const scaleY = (chartH - padding * 2) / maxCount;

    // Helper to create point
    const point = (tick, count, color, id) => {
      const x = padding + tick * scaleX;
      const y = padding + chartH - count * scaleY;
      return `<circle cx="${x}" cy="${y}" r="3" fill="${color}" />`;
    };

    // Polyline
    const createPolyline = (data, color, id) => {
      if (data.length === 0) return '';
      const points = data.map((h, i) => {
        const x = padding + h.tick * scaleX;
        const y = padding + chartH - h.count * scaleY;
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
      }).join(' ');
      return `<polyline data-testid="series-${id}" class="series-${id}" points="${points}" />`;
    };

    chartSvg.innerHTML = `
      ${createPolyline(state.history, 'var(--primary)', 'rabbits')}
      ${createPolyline(state.history, 'var(--danger)', 'foxes')}
    `;
  }

  function drawOdeChart() {
    // Clear
    odeChartSvg.innerHTML = '';

    if (state.odeHistory.length < 2) return;

    const maxTick = state.odeHistory[state.odeHistory.length - 1].tick;
    const maxCount = Math.max(...state.odeHistory.map(h => Math.max(h.x, h.y)));
    const padding = 20;
    const chartW = odeChartSvg.clientWidth || 200;
    const chartH = odeChartSvg.clientHeight || 120;

    const scaleX = (chartW - padding * 2) / maxTick;
    const scaleY = (chartH - padding * 2) / maxCount;

    const point = (tick, val, color, id) => {
      const x = padding + tick * scaleX;
      const y = padding + chartH - val * scaleY;
      return `<circle cx="${x}" cy="${y}" r="2" fill="${color}" />`;
    };

    const createPolyline = (data, color, id) => {
      if (data.length === 0) return '';
      const points = data.map((h, i) => {
        const x = padding + h.tick * scaleX;
        const y = padding + chartH - h.val * scaleY;
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
      }).join(' ');
      return `<polyline data-testid="ode-series-${id}" class="series-${id}" points="${points}" />`;
    };

    odeChartSvg.innerHTML = `
      ${createPolyline(state.odeHistory, 'var(--primary)', 'x')}
      ${createPolyline(state.odeHistory, 'var(--danger)', 'y')}
    `;
  }

  // --- UI Updates ---
  function updateCounters() {
    document.querySelector('[data-testid="count-tick"]').textContent = `Tick: ${state.tick}`;
    document.querySelector('[data-testid="count-rabbits"]').textContent = `Rabbits: ${counts().rabbits}`;
    document.querySelector('[data-testid="count-foxes"]').textContent = `Foxes: ${counts().foxes}`;
    document.querySelector('[data-testid="count-grass"]').textContent = `Grass: ${counts().grass}`;
  }

  function updateSliders() {
    const update = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
      const span = document.getElementById(`val-${id.replace('param-', '')}`);
      if (span) span.textContent = val;
    };

    update('param-rabbits0', state.params.rabbits0);
    update('param-foxes0', state.params.foxes0);
    update('param-rabbitBreed', state.params.rabbitBreed);
    update('param-foxBreed', state.params.foxBreed);
    update('param-foxGain', state.params.foxGain);
    update('param-grassMax', state.params.grassMax);
  }

  function updateSpeed() {
    const val = parseInt(document.getElementById('speed').value);
    document.getElementById('speed-val').textContent = val;
    state.speed = val;
  }

  // --- Event Listeners ---
  document.getElementById('play').addEventListener('click', () => {
    if (!state.playing) {
      state.playing = true;
      state.lastFrameTime = performance.now();
      requestAnimationFrame(gameLoop);
    }
  });

  document.getElementById('pause').addEventListener('click', pause);

  function pause() {
    state.playing = false;
    announcer.textContent = '';
    announcer.classList.remove('visible');
  }

  document.getElementById('step').addEventListener('click', () => {
    step(1);
  });

  document.getElementById('reset').addEventListener('click', () => {
    const seed = parseInt(document.getElementById('seed').value) || 42;
    reset(seed);
  });

  document.getElementById('seed').addEventListener('change', (e) => {
    const val = parseInt(e.target.value) || 42;
    document.getElementById('seed').value = val;
  });

  document.getElementById('speed').addEventListener('input', updateSpeed);

  // Sliders
  ['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax'].forEach(id => {
    document.getElementById(`param-${id}`).addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      document.getElementById(`val-${id}`).textContent = val;
      // Note: params only apply on reset per spec
    });
  });

  // Chart
  window.addEventListener('resize', drawChart);

  // Lotka Volterra
  document.getElementById('ode-run').addEventListener('click', () => {
    const alpha = parseFloat(document.getElementById('ode-alpha').value);
    const beta = parseFloat(document.getElementById('ode-beta').value);
    const gamma = parseFloat(document.getElementById('ode-gamma').value);
    const delta = parseFloat(document.getElementById('ode-delta').value);
    const x0 = parseFloat(document.getElementById('ode-x0').value);
    const y0 = parseFloat(document.getElementById('ode-y0').value);
    const t = parseFloat(document.getElementById('ode-t').value);
    const dt = parseFloat(document.getElementById('ode-dt').value);

    const p = { alpha, beta, gamma, delta, x0, y0 };
    const result = ode(p, t, dt);

    document.getElementById('ode-x').textContent = result.x.toFixed(8);
    document.getElementById('ode-y').textContent = result.y.toFixed(8);
    document.getElementById('ode-eq-x').textContent = (gamma / delta).toFixed(8);
    document.getElementById('ode-eq-y').textContent = (alpha / beta).toFixed(8);

    // Drift
    const V_start = delta * x0 - gamma * Math.log(x0) + beta * y0 - alpha * Math.log(y0);
    const V_end = delta * result.x - gamma * Math.log(result.x) + beta * result.y - alpha * Math.log(result.y);
    const drift = Math.abs(V_end - V_start);
    document.getElementById('ode-drift').textContent = parseFloat(drift.toFixed(8));

    // ODE Chart
    const odeHistory = [];
    let x = x0, y = y0;
    for (let i = 0; i <= Math.round(t / dt); i++) {
      odeHistory.push({ tick: i * dt, x, y });
      const k1 = { dx: alpha * x - beta * x * y, dy: delta * x * y - gamma * y };
      const k2 = { dx: alpha * (x + 0.5 * dt * k1.dx) - beta * (x + 0.5 * dt * k1.dx) * (y + 0.5 * dt * k1.dy), dy: delta * (x + 0.5 * dt * k1.dx) * (y + 0.5 * dt * k1.dy) - gamma * (y + 0.5 * dt * k1.dy) };
      const k3 = { dx: alpha * (x + 0.5 * dt * k2.dx) - beta * (x + 0.5 * dt * k2.dx) * (y + 0.5 * dt * k2.dy), dy: delta * (x + 0.5 * dt * k2.dx) * (y + 0.5 * dt * k2.dy) - gamma * (y + 0.5 * dt * k2.dy) };
      const k4 = { dx: alpha * (x + dt * k3.dx) - beta * (x + dt * k3.dx) * (y + dt * k3.dy), dy: delta * (x + dt * k3.dx) * (y + dt * k3.dy) - gamma * (y + dt * k3.dy) };
      x += dt * (k1.dx + 2 * k2.dx + 2 * k3.dx + k4.dx) / 6;
      y += dt * (k1.dy + 2 * k2.dy + 2 * k3.dy + k4.dy) / 6;
    }
    state.odeHistory = odeHistory;
    drawOdeChart();
  });

  // Scenario
  document.getElementById('scenario-export').addEventListener('click', () => {
    const json = exportScenario();
    document.getElementById('scenario-json').value = json;
  });

  document.getElementById('scenario-load').addEventListener('click', () => {
    const text = document.getElementById('scenario-json').value;
    loadScenario(text);
  });

  // Presets
  const presetListEl = document.getElementById('preset-list');
  const presetNameInput = document.getElementById('preset-name');
  const presetSaveBtn = document.getElementById('preset-save');

  function renderPresets() {
    presetListEl.innerHTML = '';
    const stored = JSON.parse(localStorage.getItem("ecolab.presets") || '{}');
    Object.keys(stored).forEach(name => {
      const item = document.createElement('div');
      item.className = 'preset-item';
      item.innerHTML = `
        <span>${name}</span>
        <div>
          <button class="preset-load" data-name="${name}">Load</button>
          <button class="preset-delete" data-name="${name}">Delete</button>
        </div>
      `;
      presetListEl.appendChild(item);
    });
  }

  presetSaveBtn.addEventListener('click', () => {
    const name = presetNameInput.value.trim();
    if (!name) return;
    const stored = JSON.parse(localStorage.getItem("ecolab.presets") || '{}');
    stored[name] = exportScenario();
    localStorage.setItem("ecolab.presets", JSON.stringify(stored));
    renderPresets();
  });

  presetListEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('preset-load')) {
      const name = e.target.dataset.name;
      const stored = JSON.parse(localStorage.getItem("ecolab.presets") || '{}');
      if (stored[name]) {
        loadScenario(stored[name]);
      }
    } else if (e.target.classList.contains('preset-delete')) {
      const name = e.target.dataset.name;
      const stored = JSON.parse(localStorage.getItem("ecolab.presets") || '{}');
      delete stored[name];
      localStorage.setItem("ecolab.presets", JSON.stringify(stored));
      renderPresets();
    }
  });

  // Initial Load
  reset(42);
  renderPresets();

  // Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    // Ignore if input focused
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;

    switch (e.key.toLowerCase()) {
      case ' ':
      case 'p':
        if (state.playing) pause();
        else {
          state.playing = true;
          state.lastFrameTime = performance.now();
          requestAnimationFrame(gameLoop);
        }
        break;
      case 's':
        step(1);
        break;
      case 'r':
        reset(parseInt(document.getElementById('seed').value) || 42);
        break;
    }
  });

  // Game Loop
  function gameLoop() {
    if (!state.playing) return;

    const now = performance.now();
    const dt = now - state.lastFrameTime;
    state.lastFrameTime = now;

    const ticksThisFrame = Math.floor(dt / (1000 / state.speed));
    for (let i = 0; i < ticksThisFrame; i++) {
      tick();
    }

    // Announcer
    const counts = counts();
    announcer.textContent = `Tick ${state.tick}: ${counts.rabbits} rabbits, ${counts.foxes} foxes`;
    announcer.classList.add('visible');

    requestAnimationFrame(gameLoop);
  }

})();
</script>
</body>
</html>
```