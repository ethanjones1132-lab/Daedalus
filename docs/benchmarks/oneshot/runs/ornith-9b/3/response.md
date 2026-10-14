## Plan

**Data Model:**
- **Grid:** 2D array of size `width × height`. Each cell stores `{grass: int, rabbit: {id, energy} | null, fox: {id, energy} | null}`.
- **Animals:** Array of objects `{id, x, y, energy, type}`. Ids are unique integers starting from 1, shared across both species.
- **State:** `{tick, seed, params, animals, grid, history}`.
- **History:** Array of `{tick, rabbits, foxes, grass}` snapshots recorded at the end of each tick.

**Tick Order:**
1. **Grass Growth:** Iterate all cells, increment grass, cap at `grassMax`.
2. **Rabbits:** Get sorted list of rabbits alive at start of phase. For each: Move → Eat → Cost → Breed → Die.
3. **Foxes:** Get sorted list of foxes alive at start of phase. For each: Move → Eat → Cost → Breed → Die.
4. **Record:** Increment tick, record history point.

**Components:**
- **Canvas (`data-testid="world"`):** Renders the grid with grass colors, rabbit shapes, and fox shapes.
- **Controls:** Play/Pause/Step/Reset buttons, speed slider, parameter sliders (rabbits0, foxes0, rabbitBreed, foxBreed, foxGain, grassMax), seed input.
- **Counters:** Live tick count, rabbit count, fox count, grass sum.
- **Chart (`data-testid="chart"`):** SVG polyline for rabbit and fox populations over time.
- **Lotka-Volterra Panel:** Inputs for ODE parameters, Run button, results display, and an SVG chart for the ODE trajectory.
- **Scenario Tools:** JSON textarea, Export/Load buttons, error message display.
- **Presets:** Save/Load/Delete functionality using `localStorage`.
- **Announcer:** `aria-live="polite"` element for keyboard shortcuts and state changes.

---

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Ecosystem Lab</title>
<style>
  :root {
    --bg: #f8f9fa;
    --panel-bg: #ffffff;
    --border: #dee2e6;
    --text: #212529;
    --text-muted: #6c757d;
    --primary: #0d6efd;
    --primary-hover: #0b5ed7;
    --danger: #dc3545;
    --success: #198754;
    --radius: 6px;
    --shadow: 0 2px 4px rgba(0,0,0,0.1);
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 0;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  .container {
    display: flex;
    flex-wrap: wrap;
    max-width: 1400px;
    margin: 0 auto;
    padding: 16px;
    gap: 16px;
  }
  .panel-world {
    flex: 1;
    min-width: 360px;
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    box-shadow: var(--shadow);
  }
  .panel-side {
    flex: 1;
    min-width: 300px;
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    box-shadow: var(--shadow);
    overflow-y: auto;
    max-height: 80vh;
  }
  h1 { font-size: 1.4rem; margin: 0 0 12px; }
  h2 { font-size: 1.1rem; margin: 16px 0 8px; border-bottom: 2px solid var(--border); padding-bottom: 4px; }
  .grid-canvas {
    display: block;
    margin: 0 auto 12px;
    border: 1px solid var(--border);
    background: #1a1a2e;
    border-radius: var(--radius);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;
  }
  button {
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel-bg);
    cursor: pointer;
    font-size: 0.9rem;
    transition: all 0.15s;
    outline: none;
  }
  button:hover { background: #e9ecef; }
  button:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  button.primary { background: var(--primary); color: white; border-color: var(--primary); }
  button.primary:hover { background: var(--primary-hover); }
  button.danger { color: var(--danger); border-color: var(--danger); }
  button.danger:hover { background: #f8d7da; }
  input[type="number"], input[type="text"], textarea {
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 0.9rem;
    outline: none;
  }
  input[type="number"]:focus, textarea:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 2px rgba(13,110,253,0.2);
  }
  textarea { width: 100%; min-height: 80px; font-family: monospace; font-size: 0.8rem; resize: vertical; }
  .counter-row {
    display: flex;
    gap: 16px;
    margin-bottom: 12px;
    font-size: 0.95rem;
  }
  .counter-item { font-weight: 600; }
  .counter-item span { color: var(--primary); }
  .slider-group {
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .slider-group label { font-size: 0.85rem; min-width: 80px; }
  .slider-group input[type="range"] { flex: 1; }
  .slider-group .value { font-size: 0.85rem; color: var(--text-muted); min-width: 24px; text-align: right; }
  .chart-container {
    background: #f8f9fa;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px;
    margin-bottom: 12px;
  }
  .chart-title { font-size: 0.85rem; font-weight: 600; margin-bottom: 4px; }
  .ode-panel { margin-top: 12px; }
  .ode-inputs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 10px;
  }
  .ode-inputs .full { grid-column: 1 / -1; }
  .result-row {
    display: flex;
    gap: 12px;
    margin-bottom: 6px;
    font-size: 0.9rem;
  }
  .result-label { color: var(--text-muted); min-width: 100px; }
  .result-value { font-family: monospace; font-weight: 600; }
  .presets-section { margin-top: 12px; }
  .preset-item {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 4px;
    font-size: 0.85rem;
  }
  .preset-item button { padding: 2px 8px; font-size: 0.8rem; }
  .error-msg { color: var(--danger); font-size: 0.85rem; margin-top: 4px; min-height: 1.2em; }
  .announcer { position: absolute; left: -9999px; }
  @media (max-width: 700px) {
    .panel-side { order: 2; width: 100%; }
    .panel-world { order: 1; width: 100%; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="panel-world">
    <h1>Ecosystem Lab</h1>
    <canvas class="grid-canvas" data-testid="world" width="400" height="300"></canvas>
    <div class="controls">
      <button id="play" data-testid="play">Play</button>
      <button id="pause" data-testid="pause" disabled>Pause</button>
      <button id="step" data-testid="step">Step</button>
      <button id="reset" data-testid="reset">Reset</button>
      <label for="seed" style="font-size:0.85rem;">Seed:</label>
      <input type="number" id="seed" value="42" style="width:60px;">
      <label for="speed" style="font-size:0.85rem;">Speed:</label>
      <input type="range" id="speed" data-testid="speed" min="1" max="60" value="10" oninput="updateSpeedLabel()">
      <span id="speed-label" style="font-size:0.85rem;">10 t/s</span>
    </div>
    <div class="counter-row">
      <div class="counter-item">Tick: <span id="tick">0</span></div>
      <div class="counter-item">Rabbits: <span id="count-rabbits">0</span></div>
      <div class="counter-item">Foxes: <span id="count-foxes">0</span></div>
      <div class="counter-item">Grass: <span id="count-grass">0</span></div>
    </div>
    <h2>Parameters</h2>
    <div class="slider-group">
      <label for="param-rabbits0">Rabbits 0</label>
      <input type="range" id="param-rabbits0" data-testid="param-rabbits0" min="0" max="300" value="100">
      <span class="value" id="val-rabbits0">100</span>
    </div>
    <div class="slider-group">
      <label for="param-foxes0">Foxes 0</label>
      <input type="range" id="param-foxes0" data-testid="param-foxes0" min="0" max="60" value="6">
      <span class="value" id="val-foxes0">6</span>
    </div>
    <div class="slider-group">
      <label for="param-rabbitBreed">Rabbit Breed</label>
      <input type="range" id="param-rabbitBreed" data-testid="param-rabbitBreed" min="2" max="40" value="12">
      <span class="value" id="val-rabbitBreed">12</span>
    </div>
    <div class="slider-group">
      <label for="param-foxBreed">Fox Breed</label>
      <input type="range" id="param-foxBreed" data-testid="param-foxBreed" min="2" max="60" value="40">
      <span class="value" id="val-foxBreed">40</span>
    </div>
    <div class="slider-group">
      <label for="param-foxGain">Fox Gain</label>
      <input type="range" id="param-foxGain" data-testid="param-foxGain" min="1" max="30" value="4">
      <span class="value" id="val-foxGain">4</span>
    </div>
    <div class="slider-group">
      <label for="param-grassMax">Grass Max</label>
      <input type="range" id="param-grassMax" data-testid="param-grassMax" min="1" max="10" value="4">
      <span class="value" id="val-grassMax">4</span>
    </div>
  </div>
  <div class="panel-side">
    <h2>Population Chart</h2>
    <div class="chart-container">
      <div class="chart-title">Populations over time</div>
      <svg data-testid="chart" width="100%" height="200" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid meet">
        <polyline data-testid="series-rabbits" points="" fill="none" stroke="#0d6efd" stroke-width="2"/>
        <polyline data-testid="series-foxes" points="" fill="none" stroke="#dc3545" stroke-width="2"/>
        <text x="10" y="185" font-size="12" fill="#6c757d">tick</text>
        <text x="190" y="10" font-size="12" fill="#6c757d" transform="rotate(-90 190 10)">count</text>
      </svg>
    </div>
    <h2>Lotka-Volterra</h2>
    <div class="ode-panel">
      <div class="ode-inputs">
        <div><label>α</label><input type="number" id="ode-alpha" value="1.1" step="0.1"></div>
        <div><label>β</label><input type="number" id="ode-beta" value="0.4" step="0.1"></div>
        <div><label>γ</label><input type="number" id="ode-gamma" value="0.4" step="0.1"></div>
        <div><label>δ</label><input type="number" id="ode-delta" value="0.1" step="0.1"></div>
        <div><label>x₀</label><input type="number" id="ode-x0" value="10"></div>
        <div><label>y₀</label><input type="number" id="ode-y0" value="10"></div>
        <div><label>t</label><input type="number" id="ode-t" value="50" step="1"></div>
        <div><label>dt</label><input type="number" id="ode-dt" value="0.01" step="0.001"></div>
      </div>
      <button id="ode-run" data-testid="ode-run">Run ODE</button>
      <div class="result-row"><span class="result-label">Final x:</span><span class="result-value" id="ode-x">-</span></div>
      <div class="result-row"><span class="result-label">Final y:</span><span class="result-value" id="ode-y">-</span></div>
      <div class="result-row"><span class="result-label">Eq. x (γ/δ):</span><span class="result-value" id="ode-eq-x">-</span></div>
      <div class="result-row"><span class="result-label">Eq. y (α/β):</span><span class="result-value" id="ode-eq-y">-</span></div>
      <div class="result-row"><span class="result-label">Drift:</span><span class="result-value" id="ode-drift">-</span></div>
      <div class="chart-container" style="margin-top:8px;">
        <div class="chart-title">ODE Trajectory</div>
        <svg data-testid="ode-chart" width="100%" height="150" viewBox="0 0 400 150" preserveAspectRatio="xMidYMid meet">
          <polyline data-testid="ode-series-x" points="" fill="none" stroke="#0d6efd" stroke-width="2"/>
          <polyline data-testid="ode-series-y" points="" fill="none" stroke="#dc3545" stroke-width="2"/>
        </svg>
      </div>
    </div>
    <h2>Scenario</h2>
    <div class="slider-group" style="margin-bottom:8px;">
      <textarea id="scenario-json" data-testid="scenario-json" placeholder="Paste scenario JSON here..."></textarea>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:8px;">
      <button id="scenario-export" data-testid="scenario-export">Export</button>
      <button id="scenario-load" data-testid="scenario-load">Load</button>
    </div>
    <div class="error-msg" id="scenario-error"></div>
    <h2>Presets</h2>
    <div style="display:flex;gap:8px;margin-bottom:8px;">
      <input type="text" id="preset-name" placeholder="Preset name" style="flex:1;">
      <button id="preset-save" data-testid="preset-save">Save</button>
    </div>
    <div id="preset-list" data-testid="preset-list"></div>
  </div>
</div>
<div class="announcer" id="announcer" aria-live="polite"></div>

<script>
// --- Defaults ---
const DEFAULTS = {
  width: 40, height: 30, grassMax: 4,
  rabbits0: 100, foxes0: 6,
  rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
  foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
};

// --- State ---
let state = null;
let playing = false;
let speed = 10;
let lastTime = 0;
let animFrame = null;
let idCounter = 0;

// --- RNG ---
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
  return list[Math.floor(rand() * list.length)];
}

// --- Simulation ---
function reset(seed, params) {
  const p = { ...DEFAULTS, ...params };
  const rand = mulberry32(seed);
  const W = p.width, H = p.height;
  
  idCounter = 1;
  state = {
    tick: 0,
    seed,
    params: p,
    animals: [],
    grid: [],
    history: [{ tick: 0, rabbits: 0, foxes: 0, grass: 0 }]
  };
  
  // Init grid
  for (let y = 0; y < H; y++) {
    state.grid[y] = [];
    for (let x = 0; x < W; x++) {
      state.grid[y][x] = { grass: Math.floor(rand() * (p.grassMax + 1)), rabbit: null, fox: null };
    }
  }
  
  // Place rabbits
  for (let i = 0; i < p.rabbits0; i++) {
    const cells = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!state.grid[y][x].rabbit) cells.push({x, y});
      }
    }
    const cell = pick(cells);
    if (cell) {
      state.animals.push({ id: idCounter++, x: cell.x, y: cell.y, energy: p.rabbitStart, type: 'rabbit' });
      state.grid[cell.y][cell.x].rabbit = { id: state.animals[state.animals.length-1].id, energy: p.rabbitStart };
    }
  }
  
  // Place foxes
  for (let i = 0; i < p.foxes0; i++) {
    const cells = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!state.grid[y][x].fox) cells.push({x, y});
      }
    }
    const cell = pick(cells);
    if (cell) {
      state.animals.push({ id: idCounter++, x: cell.x, y: cell.y, energy: p.foxStart, type: 'fox' });
      state.grid[cell.y][cell.x].fox = { id: state.animals[state.animals.length-1].id, energy: p.foxStart };
    }
  }
  
  updateUI();
  return counts();
}

function getNeighbors(x, y, W, H) {
  const dirs = [[0,-1],[1,0],[0,1],[-1,0]];
  const neighbors = [];
  for (const [dx, dy] of dirs) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < W && ny >= 0 && ny < H) neighbors.push({x: nx, y: ny});
  }
  return neighbors;
}

function tick() {
  const p = state.params;
  const W = p.width, H = p.height;
  
  // 1. Grass growth
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      state.grid[y][x].grass = Math.min(p.grassMax, state.grid[y][x].grass + 1);
    }
  }
  
  // 2. Rabbits
  const rabbitsAlive = state.animals.filter(a => a.type === 'rabbit' && a.energy > 0).sort((a,b) => a.id - b.id);
  for (const rabbit of rabbitsAlive) {
    // Move
    const neighbors = getNeighbors(rabbit.x, rabbit.y, W, H);
    const freeNeighbors = neighbors.filter(n => !state.grid[n.y][n.x].rabbit);
    if (freeNeighbors.length > 0) {
      const target = pick(freeNeighbors);
      rabbit.x = target.x;
      rabbit.y = target.y;
    }
    // Eat
    const cell = state.grid[rabbit.y][rabbit.x];
    rabbit.energy += p.rabbitGain * cell.grass;
    cell.grass = 0;
    // Cost
    rabbit.energy -= p.rabbitCost;
    // Breed
    if (rabbit.energy >= p.rabbitBreed) {
      const neighbors = getNeighbors(rabbit.x, rabbit.y, W, H);
      const freeNeighbors = neighbors.filter(n => !state.grid[n.y][n.x].rabbit);
      if (freeNeighbors.length > 0) {
        const spot = pick(freeNeighbors);
        const child = Math.floor(rabbit.energy / 2);
        rabbit.energy -= child;
        state.animals.push({ id: idCounter++, x: spot.x, y: spot.y, energy: child, type: 'rabbit' });
        state.grid[spot.y][spot.x].rabbit = { id: state.animals[state.animals.length-1].id, energy: child };
      }
    }
    // Die
    if (rabbit.energy <= 0) {
      state.grid[rabbit.y][rabbit.x].rabbit = null;
      const idx = state.animals.indexOf(rabbit);
      if (idx > -1) state.animals.splice(idx, 1);
    }
  }
  
  // 3. Foxes
  const foxesAlive = state.animals.filter(a => a.type === 'fox' && a.energy > 0).sort((a,b) => a.id - b.id);
  for (const fox of foxesAlive) {
    // Move
    const neighbors = getNeighbors(fox.x, fox.y, W, H);
    const rabbitNeighbors = neighbors.filter(n => state.grid[n.y][n.x].rabbit && !state.grid[n.y][n.x].fox);
    if (rabbitNeighbors.length > 0) {
      const target = pick(rabbitNeighbors);
      fox.x = target.x;
      fox.y = target.y;
    } else {
      const freeNeighbors = neighbors.filter(n => !state.grid[n.y][n.x].fox);
      if (freeNeighbors.length > 0) {
        const target = pick(freeNeighbors);
        fox.x = target.x;
        fox.y = target.y;
      }
    }
    // Eat
    const cell = state.grid[fox.y][fox.x];
    if (cell.rabbit) {
      cell.rabbit = null;
      fox.energy += p.foxGain;
    }
    // Cost
    fox.energy -= p.foxCost;
    // Breed
    if (fox.energy >= p.foxBreed) {
      const neighbors = getNeighbors(fox.x, fox.y, W, H);
      const freeNeighbors = neighbors.filter(n => !state.grid[n.y][n.x].fox);
      if (freeNeighbors.length > 0) {
        const spot = pick(freeNeighbors);
        const child = Math.floor(fox.energy / 2);
        fox.energy -= child;
        state.animals.push({ id: idCounter++, x: spot.x, y: spot.y, energy: child, type: 'fox' });
        state.grid[spot.y][spot.x].fox = { id: state.animals[state.animals.length-1].id, energy: child };
      }
    }
    // Die
    if (fox.energy <= 0) {
      state.grid[fox.y][fox.x].fox = null;
      const idx = state.animals.indexOf(fox);
      if (idx > -1) state.animals.splice(idx, 1);
    }
  }
  
  // 4. Record
  state.tick++;
  const rabbits = state.animals.filter(a => a.type === 'rabbit').length;
  const foxes = state.animals.filter(a => a.type === 'fox').length;
  let grassSum = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grassSum += state.grid[y][x].grass;
  state.history.push({ tick: state.tick, rabbits, foxes, grass: grassSum });
  
  updateUI();
}

function counts() {
  const rabbits = state.animals.filter(a => a.type === 'rabbit').length;
  const foxes = state.animals.filter(a => a.type === 'fox').length;
  let grassSum = 0;
  const H = state.params.height, W = state.params.width;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grassSum += state.grid[y][x].grass;
  return { rabbits, foxes, grass: grassSum };
}

function cell(x, y) {
  if (x < 0 || x >= state.params.width || y < 0 || y >= state.params.height) return { grass: 0, rabbit: null, fox: null };
  const c = state.grid[y][x];
  return {
    grass: c.grass,
    rabbit: c.rabbit ? { id: c.rabbit.id, energy: c.rabbit.energy } : null,
    fox: c.fox ? { id: c.fox.id, energy: c.fox.energy } : null
  };
}

// --- ODE ---
function ode(p, t, dt) {
  const alpha = p.alpha, beta = p.beta, gamma = p.gamma, delta = p.delta;
  const x0 = p.x0, y0 = p.y0;
  const n = Math.round(t / dt);
  let x = x0, y = y0;
  for (let i = 0; i < n; i++) {
    const k1x = alpha * x - beta * x * y;
    const k1y = delta * x * y - gamma * y;
    const x2 = x + 0.5 * dt * k1x;
    const y2 = y + 0.5 * dt * k1y;
    const k2x = alpha * x2 - beta * x2 * y2;
    const k2y = delta * x2 * y2 - gamma * y2;
    const x3 = x + 0.5 * dt * k2x;
    const y3 = y + 0.5 * dt * k2y;
    const k3x = alpha * x3 - beta * x3 * y3;
    const k3y = delta * x3 * y3 - gamma * y3;
    const x4 = x + dt * k3x;
    const y4 = y + dt * k3y;
    const k4x = alpha * x4 - beta * x4 * y4;
    const k4y = delta * x4 * y4 - gamma * y4;
    x = x + (dt / 6) * (k1x + 2*k2x + 2*k3x + k4x);
    y = y + (dt / 6) * (k1y + 2*k2y + 2*k3y + k4y);
  }
  return { x, y };
}

function V(x, y, alpha, beta, gamma, delta) {
  return delta * x - gamma * Math.log(x) + beta * y - alpha * Math.log(y);
}

// --- UI ---
const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const announcer = document.getElementById('announcer');

function resizeCanvas() {
  const W = state.params.width, H = state.params.height;
  canvas.width = W * 10;
  canvas.height = H * 10;
}

function drawWorld() {
  const W = state.params.width, H = state.params.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Draw grass
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const g = state.grid[y][x].grass;
      const G = 60 + Math.round(160 * g / state.params.grassMax);
      ctx.fillStyle = `rgb(30, ${G}, 30)`;
      ctx.fillRect(x * 10, y * 10, 10, 10);
    }
  }
  
  // Draw animals
  for (const animal of state.animals) {
    const cx = animal.x * 10 + 5;
    const cy = animal.y * 10 + 5;
    if (animal.type === 'rabbit') {
      ctx.fillStyle = 'rgb(240, 240, 240)';
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (animal.type === 'fox') {
      ctx.fillStyle = 'rgb(220, 80, 20)';
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function updateUI() {
  const c = counts();
  document.getElementById('tick').textContent = state.tick;
  document.getElementById('count-rabbits').textContent = c.rabbits;
  document.getElementById('count-foxes').textContent = c.foxes;
  document.getElementById('count-grass').textContent = c.grass;
  
  // Chart
  const rabbitPoints = state.history.map(h => `${h.tick},${h.rabbits}`).join(' ');
  const foxPoints = state.history.map(h => `${h.tick},${h.foxes}`).join(' ');
  document.querySelector('[data-testid="series-rabbits"]').setAttribute('points', rabbitPoints);
  document.querySelector('[data-testid="series-foxes"]').setAttribute('points', foxPoints);
  
  // Counters
  document.getElementById('val-rabbits0').textContent = state.params.rabbits0;
  document.getElementById('val-foxes0').textContent = state.params.foxes0;
  document.getElementById('val-rabbitBreed').textContent = state.params.rabbitBreed;
  document.getElementById('val-foxBreed').textContent = state.params.foxBreed;
  document.getElementById('val-foxGain').textContent = state.params.foxGain;
  document.getElementById('val-grassMax').textContent = state.params.grassMax;
  
  // Play/Pause
  document.getElementById('play').disabled = playing;
  document.getElementById('pause').disabled = !playing;
  
  // Announcer
  announcer.textContent = `Tick ${state.tick}: ${c.rabbits} rabbits, ${c.foxes} foxes`;
}

function updateSpeedLabel() {
  speed = parseInt(document.getElementById('speed').value);
  document.getElementById('speed-label').textContent = `${speed} t/s`;
}

// --- Event Listeners ---
document.getElementById('play').addEventListener('click', () => {
  playing = true;
  lastTime = performance.now();
  gameLoop();
});

document.getElementById('pause').addEventListener('click', () => {
  playing = false;
  if (animFrame) cancelAnimationFrame(animFrame);
  announcer.textContent = `Tick ${state.tick}: ${counts().rabbits} rabbits, ${counts().foxes} foxes`;
});

document.getElementById('step').addEventListener('click', () => {
  if (!playing) {
    tick();
    updateUI();
  }
});

document.getElementById('reset').addEventListener('click', () => {
  const seed = parseInt(document.getElementById('seed').value) || 42;
  const params = {};
  const sliders = ['param-rabbits0','param-foxes0','param-rabbitBreed','param-foxBreed','param-foxGain','param-grassMax'];
  for (const s of sliders) {
    params[s.slice(6)] = parseInt(document.getElementById(s).value);
  }
  reset(seed, params);
  updateUI();
});

document.getElementById('speed').addEventListener('input', updateSpeedLabel);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const focused = document.activeElement;
  const isInput = focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT';
  const isButton = focused.tagName === 'BUTTON';
  
  if (isInput || isButton) return;
  
  if (e.key === ' ' || e.key === 'Space') {
    e.preventDefault();
    if (playing) {
      playing = false;
      if (animFrame) cancelAnimationFrame(animFrame);
      announcer.textContent = `Tick ${state.tick}: ${counts().rabbits} rabbits, ${counts().foxes} foxes`;
    } else {
      playing = true;
      lastTime = performance.now();
      gameLoop();
    }
  }
  if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    tick();
    updateUI();
  }
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    const seed = parseInt(document.getElementById('seed').value) || 42;
    const params = {};
    const sliders = ['param-rabbits0','param-foxes0','param-rabbitBreed','param-foxBreed','param-foxGain','param-grassMax'];
    for (const s of sliders) {
      params[s.slice(6)] = parseInt(document.getElementById(s).value);
    }
    reset(seed, params);
    updateUI();
  }
});

function gameLoop() {
  if (!playing) return;
  const now = performance.now();
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  
  const ticksThisFrame = Math.floor(dt * speed);
  for (let i = 0; i < ticksThisFrame; i++) {
    tick();
  }
  
  updateUI();
  animFrame = requestAnimationFrame(gameLoop);
}

// --- ODE Panel ---
document.getElementById('ode-run').addEventListener('click', () => {
  const alpha = parseFloat(document.getElementById('ode-alpha').value);
  const beta = parseFloat(document.getElementById('ode-beta').value);
  const gamma = parseFloat(document.getElementById('ode-gamma').value);
  const delta = parseFloat(document.getElementById('ode-delta').value);
  const x0 = parseFloat(document.getElementById('ode-x0').value);
  const y0 = parseFloat(document.getElementById('ode-y0').value);
  const t = parseFloat(document.getElementById('ode-t').value);
  const dt = parseFloat(document.getElementById('ode-dt').value);
  
  const result = ode({ alpha, beta, gamma, delta, x0, y0 }, t, dt);
  
  document.getElementById('ode-x').textContent = result.x.toFixed(8);
  document.getElementById('ode-y').textContent = result.y.toFixed(8);
  document.getElementById('ode-eq-x').textContent = (gamma / delta).toFixed(8);
  document.getElementById('ode-eq-y').textContent = (alpha / beta).toFixed(8);
  
  const startV = V(x0, y0, alpha, beta, gamma, delta);
  const endV = V(result.x, result.y, alpha, beta, gamma, delta);
  document.getElementById('ode-drift').textContent = Math.abs(endV - startV).toFixed(8);
  
  // Draw ODE chart
  const n = Math.round(t / dt);
  let x = x0, y = y0;
  const points = [];
  for (let i = 0; i <= n; i++) {
    points.push(`${i * dt},${x}`);
    if (i < n) {
      const k1x = alpha * x - beta * x * y;
      const k1y = delta * x * y - gamma * y;
      const x2 = x + 0.5 * dt * k1x;
      const y2 = y + 0.5 * dt * k1y;
      const k2x = alpha * x2 - beta * x2 * y2;
      const k2y = delta * x2 * y2 - gamma * y2;
      const x3 = x + 0.5 * dt * k2x;
      const y3 = y + 0.5 * dt * k2y;
      const k3x = alpha * x3 - beta * x3 * y3;
      const k3y = delta * x3 * y3 - gamma * y3;
      const x4 = x + dt * k3x;
      const y4 = y + dt * k3y;
      const k4x = alpha * x4 - beta * x4 * y4;
      const k4y = delta * x4 * y4 - gamma * y4;
      x = x + (dt / 6) * (k1x + 2*k2x + 2*k3x + k4x);
      y = y + (dt / 6) * (k1y + 2*k2y + 2*k3y + k4y);
    }
  }
  document.querySelector('[data-testid="ode-series-x"]').setAttribute('points', points.join(' '));
  document.querySelector('[data-testid="ode-series-y"]').setAttribute('points', points.join(' '));
});

// --- Scenario ---
document.getElementById('scenario-export').addEventListener('click', () => {
  const json = JSON.stringify({
    version: 1,
    seed: state.seed,
    params: state.params
  }, null, 2);
  document.getElementById('scenario-json').value = json;
});

document.getElementById('scenario-load').addEventListener('click', () => {
  const text = document.getElementById('scenario-json').value;
  const errorEl = document.getElementById('scenario-error');
  try {
    const data = JSON.parse(text);
    if (data.version !== 1 || typeof data.seed !== 'number' || !Number.isInteger(data.seed)) {
      throw new Error('Invalid scenario');
    }
    const params = {};
    const allParams = Object.keys(DEFAULTS);
    for (const key of allParams) {
      if (data.params && data.params[key] !== undefined) {
        params[key] = data.params[key];
      }
    }
    reset(data.seed, params);
    errorEl.textContent = '';
  } catch (e) {
    errorEl.textContent = e.message;
  }
});

// --- Presets ---
function savePreset(name) {
  const scenario = {
    version: 1,
    seed: state.seed,
    params: state.params
  };
  let presets = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
  presets[name] = scenario;
  localStorage.setItem('ecolab.presets', JSON.stringify(presets));
  renderPresets();
}

function loadPreset(name) {
  const presets = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
  if (presets[name]) {
    const scenario = presets[name];
    const params = {};
    const allParams = Object.keys(DEFAULTS);
    for (const key of allParams) {
      if (scenario.params && scenario.params[key] !== undefined) {
        params[key] = scenario.params[key];
      }
    }
    reset(scenario.seed, params);
    updateUI();
  }
}

function deletePreset(name) {
  let presets = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
  delete presets[name];
  localStorage.setItem('ecolab.presets', JSON.stringify(presets));
  renderPresets();
}

function renderPresets() {
  const container = document.getElementById('preset-list');
  const presets = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
  container.innerHTML = '';
  for (const [name, scenario] of Object.entries(presets)) {
    const item = document.createElement('div');
    item.className = 'preset-item';
    item.innerHTML = `
      <span>${name}</span>
      <button data-testid="preset-load" onclick="loadPreset('${name}')">Load</button>
      <button data-testid="preset-delete" class="danger" onclick="deletePreset('${name}')">Delete</button>
    `;
    container.appendChild(item);
  }
}

// --- Init ---
function init() {
  resizeCanvas();
  reset(42, {});
  updateUI();
  renderPresets();
}

init();
</script>
</body>
</html>
```