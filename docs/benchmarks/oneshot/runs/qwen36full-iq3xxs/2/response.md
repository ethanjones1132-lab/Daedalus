## Plan

**Data Model:**
The simulation state is encapsulated in a `World` object.
- `grid`: A 1D array of size `width * height`. Each element is an object `{ grass, rabbit: {id, energy}, fox: {id, energy} }`.
- `animals`: A Map of `id` to `{ type: 'rabbit'|'fox', energy }`.
- `params`: Merged configuration (defaults + user overrides).
- `history`: Array of `{ tick, rabbits, foxes, grass }`.
- `rng`: The Mulberry32 generator instance.

**Tick Order:**
1. **Grass Growth:** Increment all cells.
2. **Rabbits:** Iterate sorted by ID. Move (to empty neighbor), Eat (consume grass), Reproduce (if energy high, spawn child in neighbor), Die (if energy <= 0).
3. **Foxes:** Iterate sorted by ID. Move (prefer rabbit, else empty), Eat (consume rabbit), Reproduce, Die.
4. **Finalize:** Increment tick counter, record history.

**Components:**
- `World`: Manages simulation logic, RNG, and grid state.
- `Renderer`: Handles Canvas drawing (world) and SVG updates (charts).
- `UI`: Manages DOM elements, event listeners, and the `window.lab` API.
- `ODE`: Implements RK4 integration for Lotka-Volterra equations.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ecosystem Lab</title>
<style>
  :root {
    --bg: #f4f4f4;
    --panel-bg: #fff;
    --border: #ccc;
    --text: #333;
    --accent: #2196F3;
    --danger: #f44336;
  }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow-x: hidden;
  }
  h1, h2, h3 { margin: 0.5em 0; }
  button, input, select, textarea { margin: 2px; }
  button { cursor: pointer; padding: 4px 8px; }
  button:focus, input:focus, textarea:focus { outline: 2px solid var(--accent); }
  
  .layout {
    display: flex;
    flex: 1;
    overflow: hidden;
  }
  .panel-world {
    flex: 1;
    padding: 10px;
    overflow-y: auto;
    min-width: 300px;
    border-right: 1px solid var(--border);
  }
  .panel-side {
    flex: 1;
    padding: 10px;
    overflow-y: auto;
    min-width: 300px;
    background: #fafafa;
  }
  
  @media (min-width: 1000px) {
    .layout { flex-direction: row; }
  }
  @media (max-width: 700px) {
    .layout { flex-direction: column; }
    .panel-world { border-right: none; border-bottom: 1px solid var(--border); }
  }

  .control-group {
    background: var(--panel-bg);
    padding: 10px;
    border-radius: 4px;
    margin-bottom: 10px;
    border: 1px solid var(--border);
  }
  .control-group h3 { font-size: 1em; border-bottom: 1px solid #eee; padding-bottom: 5px; }
  
  .row { display: flex; align-items: center; margin-bottom: 5px; gap: 10px; }
  .row label { flex: 1; font-size: 0.9em; }
  .row input[type="range"] { flex: 2; }
  .row span { width: 40px; text-align: right; font-size: 0.9em; }

  canvas {
    background: #000;
    width: 100%;
    max-width: 400px;
    height: auto;
    aspect-ratio: 4/3;
    display: block;
    margin: 0 auto;
    image-rendering: pixelated;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 5px;
    margin-top: 10px;
    text-align: center;
  }
  .stat-box {
    background: #eee;
    padding: 5px;
    border-radius: 4px;
  }
  .stat-box div { font-size: 0.8em; color: #666; }
  .stat-box strong { font-size: 1.2em; }

  svg { width: 100%; height: 200px; border: 1px solid #ddd; background: #fff; }
  
  .presets-list { list-style: none; padding: 0; }
  .preset-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px;
    border-bottom: 1px solid #eee;
  }
  .preset-item button { font-size: 0.8em; }

  #announcer {
    position: absolute;
    left: -10000px;
    top: -10000px;
  }
  .error-msg { color: var(--danger); font-size: 0.9em; min-height: 1.2em; }
</style>
</head>
<body>

<div id="announcer" aria-live="polite"></div>

<div class="layout">
  <div class="panel-world">
    <h1>Ecosystem Lab</h1>
    <div class="control-group">
      <div class="row">
        <button data-testid="play">Play</button>
        <button data-testid="pause">Pause</button>
        <button data-testid="step">Step</button>
        <button data-testid="reset">Reset</button>
      </div>
      <div class="row">
        <label for="seed">Seed:</label>
        <input type="number" id="seed" value="42" data-testid="seed">
        <label for="speed">Speed:</label>
        <input type="range" id="speed" min="1" max="60" value="10" data-testid="speed">
        <span id="speed-val">10</span>
      </div>
    </div>

    <div class="control-group">
      <h3>Parameters</h3>
      <div class="row">
        <label for="param-rabbits0">Rabbits0:</label>
        <input type="range" id="param-rabbits0" min="0" max="300" value="100" data-testid="param-rabbits0">
        <span id="val-rabbits0">100</span>
      </div>
      <div class="row">
        <label for="param-foxes0">Foxes0:</label>
        <input type="range" id="param-foxes0" min="0" max="60" value="6" data-testid="param-foxes0">
        <span id="val-foxes0">6</span>
      </div>
      <div class="row">
        <label for="param-rabbitBreed">Rabbit Breed:</label>
        <input type="range" id="param-rabbitBreed" min="2" max="40" value="12" data-testid="param-rabbitBreed">
        <span id="val-rabbitBreed">12</span>
      </div>
      <div class="row">
        <label for="param-foxBreed">Fox Breed:</label>
        <input type="range" id="param-foxBreed" min="2" max="60" value="40" data-testid="param-foxBreed">
        <span id="val-foxBreed">40</span>
      </div>
      <div class="row">
        <label for="param-foxGain">Fox Gain:</label>
        <input type="range" id="param-foxGain" min="1" max="30" value="4" data-testid="param-foxGain">
        <span id="val-foxGain">4</span>
      </div>
      <div class="row">
        <label for="param-grassMax">Grass Max:</label>
        <input type="range" id="param-grassMax" min="1" max="10" value="4" data-testid="param-grassMax">
        <span id="val-grassMax">4</span>
      </div>
    </div>

    <canvas data-testid="world" width="400" height="300"></canvas>
    
    <div class="stats">
      <div class="stat-box"><div>TICK</div><strong data-testid="tick">0</strong></div>
      <div class="stat-box"><div>RABBITS</div><strong data-testid="count-rabbits">0</strong></div>
      <div class="stat-box"><div>FOXES</div><strong data-testid="count-foxes">0</strong></div>
      <div class="stat-box"><div>GRASS</div><strong data-testid="count-grass">0</strong></div>
    </div>
  </div>

  <div class="panel-side">
    <div class="control-group">
      <h3>Population Chart</h3>
      <svg data-testid="chart">
        <text x="10" y="10" font-size="10">count</text>
        <text x="100" y="190" font-size="10">tick</text>
        <polyline data-testid="series-rabbits" fill="none" stroke="white" stroke-width="2" points=""></polyline>
        <polyline data-testid="series-foxes" fill="none" stroke="orange" stroke-width="2" points=""></polyline>
      </svg>
      <div class="row" style="margin-top:10px;">
        <button data-testid="csv-export">Export CSV</button>
      </div>
    </div>

    <div class="control-group">
      <h3>Lotka-Volterra</h3>
      <div class="row">
        <label for="ode-alpha">α:</label>
        <input type="number" id="ode-alpha" value="1.1" step="0.1">
        <label for="ode-beta">β:</label>
        <input type="number" id="ode-beta" value="0.4" step="0.1">
      </div>
      <div class="row">
        <label for="ode-gamma">γ:</label>
        <input type="number" id="ode-gamma" value="0.4" step="0.1">
        <label for="ode-delta">δ:</label>
        <input type="number" id="ode-delta" value="0.1" step="0.1">
      </div>
      <div class="row">
        <label for="ode-x0">x0:</label>
        <input type="number" id="ode-x0" value="10">
        <label for="ode-y0">y0:</label>
        <input type="number" id="ode-y0" value="10">
      </div>
      <div class="row">
        <label for="ode-t">t:</label>
        <input type="number" id="ode-t" value="50">
        <label for="ode-dt">dt:</label>
        <input type="number" id="ode-dt" value="0.01" step="0.01">
      </div>
      <button data-testid="ode-run">Run ODE</button>
      <div id="ode-results" style="margin-top:10px; font-size:0.9em;">
        <div>Final x: <span id="ode-x">-</span></div>
        <div>Final y: <span id="ode-y">-</span></div>
        <div>Eq x: <span id="ode-eq-x">-</span></div>
        <div>Eq y: <span id="ode-eq-y">-</span></div>
        <div>Drift: <span id="ode-drift">-</span></div>
      </div>
      <svg data-testid="ode-chart" style="height:150px; margin-top:10px;">
        <polyline data-testid="ode-series-x" fill="none" stroke="blue" stroke-width="1" points=""></polyline>
        <polyline data-testid="ode-series-y" fill="none" stroke="red" stroke-width="1" points=""></polyline>
      </svg>
    </div>

    <div class="control-group">
      <h3>Scenario</h3>
      <div class="row">
        <button data-testid="scenario-export">Export</button>
        <button data-testid="scenario-load">Load</button>
      </div>
      <textarea data-testid="scenario-json" rows="3" style="width:100%;"></textarea>
      <div class="error-msg" data-testid="scenario-error"></div>
    </div>

    <div class="control-group">
      <h3>Presets</h3>
      <div class="row">
        <input type="text" id="preset-name" placeholder="Name">
        <button data-testid="preset-save">Save</button>
      </div>
      <ul class="presets-list" data-testid="preset-list"></ul>
    </div>
  </div>
</div>

<script>
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

// --- Defaults ---
const DEFAULTS = {
  width: 40, height: 30, grassMax: 4,
  rabbits0: 100, foxes0: 6,
  rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
  foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
};

// --- Simulation Logic ---
class World {
  constructor() {
    this.reset(42, {});
  }

  reset(seed, params = {}) {
    this.seed = seed;
    this.params = { ...DEFAULTS, ...params };
    this.rng = mulberry32(seed);
    this.tick = 0;
    this.idCounter = 1;
    this.history = [];
    
    // Init Grid
    const { width, height, grassMax } = this.params;
    this.grid = new Array(width * height).fill(null).map(() => ({
      grass: 0,
      rabbit: null,
      fox: null
    }));

    // Init Grass
    for (let i = 0; i < this.grid.length; i++) {
      this.grid[i].grass = Math.floor(this.rng() * (grassMax + 1));
    }

    // Init Rabbits
    for (let i = 0; i < this.params.rabbits0; i++) {
      this.placeAnimal('rabbit');
    }

    // Init Foxes
    for (let i = 0; i < this.params.foxes0; i++) {
      this.placeAnimal('fox');
    }

    this.recordHistory();
    return this.counts();
  }

  placeAnimal(type) {
    const { width, height } = this.params;
    const candidates = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!this.grid[idx][type]) {
          candidates.push({ x, y, idx });
        }
      }
    }
    if (candidates.length === 0) return;
    const spot = candidates[Math.floor(this.rng() * candidates.length)];
    const id = this.idCounter++;
    const energy = type === 'rabbit' ? this.params.rabbitStart : this.params.foxStart;
    
    this.grid[spot.idx][type] = { id, energy };
  }

  step(n = 1) {
    for (let i = 0; i < n; i++) {
      this.runTick();
    }
    return this.counts();
  }

  runTick() {
    const { width, height, grassMax } = this.params;

    // 1. Grass
    for (let i = 0; i < this.grid.length; i++) {
      this.grid[i].grass = Math.min(grassMax, this.grid[i].grass + 1);
    }

    // 2. Rabbits
    const rabbits = this.getAnimals('rabbit').sort((a, b) => a.id - b.id);
    for (const r of rabbits) {
      this.actRabbit(r);
    }

    // 3. Foxes
    const foxes = this.getAnimals('fox').sort((a, b) => a.id - b.id);
    for (const f of foxes) {
      this.actFox(f);
    }

    // 4. Finalize
    this.tick++;
    this.recordHistory();
  }

  actRabbit(r) {
    const { width, height, rabbitGain, rabbitCost, rabbitBreed } = this.params;
    const idx = r.y * width + r.x;
    
    // Move
    const neighbors = this.getNeighbors(r.x, r.y);
    const emptyNeighbors = neighbors.filter(n => !this.grid[n.idx].rabbit);
    if (emptyNeighbors.length > 0) {
      const spot = emptyNeighbors[Math.floor(this.rng() * emptyNeighbors.length)];
      this.grid[idx].rabbit = null;
      this.grid[spot.idx].rabbit = r;
      r.x = spot.x; r.y = spot.y;
    }

    // Eat
    const cell = this.grid[r.y * width + r.x];
    r.energy += rabbitGain * cell.grass;
    cell.grass = 0;

    // Cost
    r.energy -= rabbitCost;

    // Breed
    if (r.energy >= rabbitBreed) {
      const bNeighbors = this.getNeighbors(r.x, r.y);
      const freeNeighbors = bNeighbors.filter(n => !this.grid[n.idx].rabbit);
      if (freeNeighbors.length > 0) {
        const spot = freeNeighbors[Math.floor(this.rng() * freeNeighbors.length)];
        const childEnergy = Math.floor(r.energy / 2);
        r.energy -= childEnergy;
                const child = { id: this.idCounter++, energy: childEnergy };
        this.grid[spot.idx].rabbit = child;
      }
    }

    // Die
    if (r.energy <= 0) {
      this.grid[r.y * width + r.x].rabbit = null;
    }
  }

  actFox(f) {
    const { width, height, foxGain, foxCost, foxBreed } = this.params;
    const idx = f.y * width + f.x;

    // Move
    const neighbors = this.getNeighbors(f.x, f.y);
    const rabbitNeighbors = neighbors.filter(n => this.grid[n.idx].rabbit && !this.grid[n.idx].fox);
    let spot = null;
    if (rabbitNeighbors.length > 0) {
      spot = rabbitNeighbors[Math.floor(this.rng() * rabbitNeighbors.length)];
    } else {
      const emptyNeighbors = neighbors.filter(n => !this.grid[n.idx].fox);
      if (emptyNeighbors.length > 0) {
        spot = emptyNeighbors[Math.floor(this.rng() * emptyNeighbors.length)];
      }
    }

    if (spot) {
      this.grid[idx].fox = null;
      this.grid[spot.idx].fox = f;
      f.x = spot.x; f.y = spot.y;
    }

    // Eat
    const cell = this.grid[f.y * width + f.x];
    if (cell.rabbit) {
      cell.rabbit = null;
      f.energy += foxGain;
    }

    // Cost
    f.energy -= foxCost;

    // Breed
    if (f.energy >= foxBreed) {
      const bNeighbors = this.getNeighbors(f.x, f.y);
      const freeNeighbors = bNeighbors.filter(n => !this.grid[n.idx].fox);
      if (freeNeighbors.length > 0) {
        const spot = freeNeighbors[Math.floor(this.rng() * freeNeighbors.length)];
        const childEnergy = Math.floor(f.energy / 2);
        f.energy -= childEnergy;
        const child = { id: this.idCounter++, energy: childEnergy };
        this.grid[spot.idx].fox = child;
      }
    }

    // Die
    if (f.energy <= 0) {
      this.grid[f.y * width + f.x].fox = null;
    }
  }

  getNeighbors(x, y) {
    const { width, height } = this.params;
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const res = [];
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        res.push({ x: nx, y: ny, idx: ny * width + nx });
      }
    }
    return res;
  }

  getAnimals(type) {
    const res = [];
    for (let y = 0; y < this.params.height; y++) {
      for (let x = 0; x < this.params.width; x++) {
        const cell = this.grid[y * this.params.width + x];
        if (cell[type]) res.push({ ...cell[type], x, y });
      }
    }
    return res;
  }

  recordHistory() {
    const rabbits = this.getAnimals('rabbit').length;
    const foxes = this.getAnimals('fox').length;
    let grass = 0;
    for (const c of this.grid) grass += c.grass;
    this.history.push({ tick: this.tick, rabbits, foxes, grass });
  }

  counts() {
    const r = this.getAnimals('rabbit').length;
    const f = this.getAnimals('fox').length;
    let g = 0;
    for (const c of this.grid) g += c.grass;
    return { rabbits: r, foxes: f, grass: g };
  }

  cell(x, y) {
    if (x < 0 || x >= this.params.width || y < 0 || y >= this.params.height) return null;
    const c = this.grid[y * this.params.width + x];
    return {
      grass: c.grass,
      rabbit: c.rabbit ? { id: c.rabbit.id, energy: c.rabbit.energy } : null,
      fox: c.fox ? { id: c.fox.id, energy: c.fox.energy } : null
    };
  }

  exportCSV() {
    let csv = "tick,rabbits,foxes,grass\n";
    for (const h of this.history) {
      csv += `${h.tick},${h.rabbits},${h.foxes},${h.grass}\n`;
    }
    return csv;
  }

  exportScenario() {
    return JSON.stringify({
      version: 1,
      seed: this.seed,
      params: { ...this.params }
    });
  }

  loadScenario(text) {
    try {
      const data = JSON.parse(text);
      if (data.version !== 1 || !Number.isInteger(data.seed)) return false;
      this.reset(data.seed, data.params);
      return true;
    } catch (e) {
      return false;
    }
  }

  ode(p, t, dt) {
    const { alpha, beta, gamma, delta, x0, y0 } = p;
    let x = x0, y = y0;
    const steps = Math.round(t / dt);
    
    const f = (x, y) => alpha * x - beta * x * y;
    const g = (x, y) => delta * x * y - gamma * y;

    for (let i = 0; i < steps; i++) {
      const k1x = f(x, y), k1y = g(x, y);
      const k2x = f(x + k1x * dt / 2, y + k1y * dt / 2), k2y = g(x + k1x * dt / 2, y + k1y * dt / 2);
      const k3x = f(x + k2x * dt / 2, y + k2y * dt / 2), k3y = g(x + k2x * dt / 2, y + k2y * dt / 2);
      const k4x = f(x + k3x * dt, y + k3y * dt), k4y = g(x + k3x * dt, y + k3y * dt);
      x += (k1x + 2 * k2x + 2 * k3x + k4x) * dt / 6;
      y += (k1y + 2 * k2y + 2 * k3y + k4y) * dt / 6;
    }
    return { x, y };
  }
}

// --- UI & App ---
const world = new World();
let playing = false;
let lastTime = 0;
let accumulator = 0;
let animFrameId = null;

// DOM Elements
const canvas = document.querySelector('canvas[data-testid="world"]');
const ctx = canvas.getContext('2d');
const tickEl = document.querySelector('[data-testid="tick"]');
const countRabbitsEl = document.querySelector('[data-testid="count-rabbits"]');
const countFoxesEl = document.querySelector('[data-testid="count-foxes"]');
const countGrassEl = document.querySelector('[data-testid="count-grass"]');
const seedInput = document.querySelector('#seed');
const speedInput = document.querySelector('#speed');
const speedVal = document.querySelector('#speed-val');
const announcer = document.querySelector('#announcer');
const chartSvg = document.querySelector('svg[data-testid="chart"]');
const seriesRabbits = chartSvg.querySelector('[data-testid="series-rabbits"]');
const seriesFoxes = chartSvg.querySelector('[data-testid="series-foxes"]');
const scenarioJson = document.querySelector('[data-testid="scenario-json"]');
const scenarioError = document.querySelector('[data-testid="scenario-error"]');
const presetList = document.querySelector('[data-testid="preset-list"]');

// --- Rendering ---
function draw() {
  const { width, height, grassMax } = world.params;
  canvas.width = width * 10;
  canvas.height = height * 10;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = world.cell(x, y);
      const g = Math.round(60 + 160 * cell.grass / grassMax);
      ctx.fillStyle = `rgb(30, ${g}, 30)`;
      ctx.fillRect(x * 10, y * 10, 10, 10);

      if (cell.rabbit) {
        ctx.fillStyle = 'rgb(240, 240, 240)';
        ctx.fillRect(x * 10 + 3, y * 10 + 3, 4, 4);
      }
      if (cell.fox) {
        ctx.fillStyle = 'rgb(220, 80, 20)';
        ctx.fillRect(x * 10 + 3, y * 10 + 3, 4, 4);
      }
    }
  }
}

function updateStats() {
  const c = world.counts();
  tickEl.textContent = world.tick;
  countRabbitsEl.textContent = c.rabbits;
  countFoxesEl.textContent = c.foxes;
  countGrassEl.textContent = c.grass;
  announcer.textContent = `Tick ${world.tick}: ${c.rabbits} rabbits, ${c.foxes} foxes`;
}

function updateChart() {
  const hist = world.history;
  if (hist.length === 0) return;
  
  const maxTick = hist[hist.length - 1].tick;
  const maxCount = Math.max(...hist.map(h => Math.max(h.rabbits, h.foxes)), 1);
  
  const toPoints = (key) => hist.map(h => {
    const px = (h.tick / (maxTick || 1)) * 100;
    const py = 100 - (h[key] / maxCount) * 90; // 10px padding
    return `${px},${py}`;
  }).join(' ');

  seriesRabbits.setAttribute('points', toPoints('rabbits'));
  seriesFoxes.setAttribute('points', toPoints('foxes'));
}

// --- Game Loop ---
function loop(timestamp) {
  if (!playing) return;
  if (!lastTime) lastTime = timestamp;
  const dt = timestamp - lastTime;
  lastTime = timestamp;

  const speed = parseInt(speedInput.value);
  accumulator += dt;
  const interval = 1000 / speed;

  while (accumulator >= interval) {
    world.step();
    accumulator -= interval;
  }

  draw();
  updateStats();
  updateChart();
  animFrameId = requestAnimationFrame(loop);
}

function togglePlay() {
  playing = !playing;
  if (playing) {
    lastTime = 0;
    accumulator = 0;
    animFrameId = requestAnimationFrame(loop);
  } else {
    cancelAnimationFrame(animFrameId);
  }
}

function doReset() {
  playing = false;
  cancelAnimationFrame(animFrameId);
  const seed = parseInt(seedInput.value) || 0;
  const params = getParamsFromUI();
  world.reset(seed, params);
  draw();
  updateStats();
  updateChart();
}

function getParamsFromUI() {
  return {
    rabbits0: parseInt(document.querySelector('#param-rabbits0').value),
    foxes0: parseInt(document.querySelector('#param-foxes0').value),
    rabbitBreed: parseInt(document.querySelector('#param-rabbitBreed').value),
    foxBreed: parseInt(document.querySelector('#param-foxBreed').value),
    foxGain: parseInt(document.querySelector('#param-foxGain').value),
    grassMax: parseInt(document.querySelector('#param-grassMax').value)
  };
}

// --- Event Listeners ---
document.querySelector('[data-testid="play"]').onclick = togglePlay;
document.querySelector('[data-testid="pause"]').onclick = togglePlay;
document.querySelector('[data-testid="step"]').onclick = () => {
  playing = false;
  cancelAnimationFrame(animFrameId);
  world.step();
  draw();
  updateStats();
  updateChart();
};
document.querySelector('[data-testid="reset"]').onclick = doReset;

speedInput.oninput = () => {
  speedVal.textContent = speedInput.value;
};

// Sliders
['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax'].forEach(name => {
  const el = document.querySelector(`#param-${name}`);
  const val = document.querySelector(`#val-${name}`);
  el.oninput = () => {
    val.textContent = el.value;
  };
});

// Chart Export
document.querySelector('[data-testid="csv-export"]').onclick = () => {
  const csv = world.exportCSV();
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ecolab.csv';
  a.click();
};

// Scenario
document.querySelector('[data-testid="scenario-export"]').onclick = () => {
  scenarioJson.value = world.exportScenario();
  scenarioError.textContent = '';
};

document.querySelector('[data-testid="scenario-load"]').onclick = () => {
  const text = scenarioJson.value;
  const success = world.loadScenario(text);
  if (success) {
    scenarioError.textContent = '';
    draw();
    updateStats();
    updateChart();
  } else {
    scenarioError.textContent = 'Invalid scenario data.';
  }
};

// ODE
document.querySelector('[data-testid="ode-run"]').onclick = () => {
  const p = {
    alpha: parseFloat(document.querySelector('#ode-alpha').value),
    beta: parseFloat(document.querySelector('#ode-beta').value),
    gamma: parseFloat(document.querySelector('#ode-gamma').value),
    delta: parseFloat(document.querySelector('#ode-delta').value),
    x0: parseFloat(document.querySelector('#ode-x0').value),
    y0: parseFloat(document.querySelector('#ode-y0').value),
  };
  const t = parseFloat(document.querySelector('#ode-t').value);
  const dt = parseFloat(document.querySelector('#ode-dt').value);

  const res = world.ode(p, t, dt);
  
  document.querySelector('#ode-x').textContent = res.x.toPrecision(8);
  document.querySelector('#ode-y').textContent = res.y.toPrecision(8);
  document.querySelector('#ode-eq-x').textContent = (p.gamma / p.delta).toPrecision(8);
  document.querySelector('#ode-eq-y').textContent = (p.alpha / p.beta).toPrecision(8);

  // Drift
  const V = (x, y) => p.delta * x - p.gamma * Math.log(x) + p.beta * y - p.alpha * Math.log(y);
  const drift = Math.abs(V(res.x, res.y) - V(p.x0, p.y0));
  document.querySelector('#ode-drift').textContent = drift.toPrecision(8);

  // Draw ODE Chart
  const svg = document.querySelector('svg[data-testid="ode-chart"]');
  // Clear old polylines
  while (svg.children.length > 2) svg.removeChild(svg.lastChild);
  
  const steps = Math.round(t / dt);
  let x = p.x0, y = p.y0;
  const pointsX = [], pointsY = [];
  const f = (x, y) => p.alpha * x - p.beta * x * y;
  const g = (x, y) => p.delta * x * y - p.gamma * y;

  for (let i = 0; i <= steps; i++) {
    const px = (i / steps) * 100;
    const py = 100 - (y / (Math.max(p.x0, p.y0) * 1.1)) * 90;
    pointsX.push(`${px},${py}`);
    pointsY.push(`${px},${py}`);
    
    const k1x = f(x, y), k1y = g(x, y);
    const k2x = f(x + k1x * dt / 2, y + k1y * dt / 2), k2y = g(x + k1x * dt / 2, y + k1y * dt / 2);
    const k3x = f(x + k2x * dt / 2, y + k2y * dt / 2), k3y = g(x + k2x * dt / 2, y + k2y * dt / 2);
    const k4x = f(x + k3x * dt, y + k3y * dt), k4y = g(x + k3x * dt, y + k3y * dt);
    x += (k1x + 2 * k2x + 2 * k3x + k4x) * dt / 6;
    y += (k1y + 2 * k2y + 2 * k3y + k4y) * dt / 6;
  }

  const polyX = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  polyX.setAttribute('data-testid', 'ode-series-x');
  polyX.setAttribute('fill', 'none');
  polyX.setAttribute('stroke', 'blue');
  polyX.setAttribute('stroke-width', '1');
  polyX.setAttribute('points', pointsX.join(' '));
  svg.appendChild(polyX);

  const polyY = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  polyY.setAttribute('data-testid', 'ode-series-y');
  polyY.setAttribute('fill', 'none');
  polyY.setAttribute('stroke', 'red');
  polyY.setAttribute('stroke-width', '1');
  polyY.setAttribute('points', pointsY.join(' '));
  svg.appendChild(polyY);
};

// Presets
function loadPresets() {
  const stored = localStorage.getItem('ecolab.presets');
  let presets = {};
  if (stored) {
    try { presets = JSON.parse(stored); } catch (e) {}
  }
  renderPresets(presets);
}

function renderPresets(presets) {
  presetList.innerHTML = '';
  for (const [name, data] of Object.entries(presets)) {
    const li = document.createElement('li');
    li.className = 'preset-item';
    li.innerHTML = `
      <span>${name}</span>
      <div>
        <button class="preset-load">Load</button>
        <button class="preset-delete">Del</button>
      </div>
    `;
    li.querySelector('.preset-load').onclick = () => {
      scenarioJson.value = JSON.stringify(data);
      document.querySelector('[data-testid="scenario-load"]').click();
    };
    li.querySelector('.preset-delete').onclick = () => {
      delete presets[name];
      localStorage.setItem('ecolab.presets', JSON.stringify(presets));
      renderPresets(presets);
    };
    presetList.appendChild(li);
  }
}

document.querySelector('[data-testid="preset-save"]').onclick = () => {
  const name = document.querySelector('#preset-name').value.trim();
  if (!name) return;
  const stored = localStorage.getItem('ecolab.presets');
  let presets = {};
  if (stored) {
    try { presets = JSON.parse(stored); } catch (e) {}
  }
  presets[name] = JSON.parse(world.exportScenario());
  localStorage.setItem('ecolab.presets', JSON.stringify(presets));
  renderPresets(presets);
};

// Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.key === 's') { e.preventDefault(); document.querySelector('[data-testid="step"]').click(); }
  if (e.key === 'r') { e.preventDefault(); doReset(); }
});

// Init
loadPresets();
doReset();

// --- API ---
window.lab = {
  reset: (seed, params) => {
    const p = { ...DEFAULTS, ...params };
    world.reset(seed, p);
    draw();
    updateStats();
    updateChart();
    return world.counts();
  },
  step: (n = 1) => {
    world.step(n);
    draw();
    updateStats();
    updateChart();
    return world.counts();
  },
  counts: () => world.counts(),
  tick: () => world.tick,
  cell: (x, y) => world.cell(x, y),
  history: () => world.history,
  ode: (p, t, dt) => world.ode(p, t, dt),
  exportCSV: () => world.exportCSV(),
  exportScenario: () => world.exportScenario(),
  loadScenario: (text) => {
    const res = world.loadScenario(text);
    if (res) {
      draw();
      updateStats();
      updateChart();
    }
    return res;
  }
};
</script>
</body>
</html>
```