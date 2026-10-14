## Plan

**Data Model:**
- `Grid`: 2D array of objects `{grass, rabbit, fox}`.
- `Animals`: Objects `{id, energy}` stored in `Grid` cells.
- `State`: `seed`, `tick`, `params`, `history`, `rng`.
- `Params`: 13 configuration values with defaults.

**Tick Order:**
1. **Grass Growth:** Increment all grass levels up to `grassMax`.
2. **Rabbits:** Iterate sorted by ID. Move (to empty neighbor), Eat (grass), Cost, Breed (if energy high), Die (if energy <= 0).
3. **Foxes:** Iterate sorted by ID. Move (to rabbit neighbor, else empty), Eat (rabbit), Cost, Breed (if energy high), Die (if energy <= 0).
4. **Record:** Save state to history.

**Components:**
- `Panel World`: Canvas, Controls (Play, Pause, Step, Reset), Sliders, Counters.
- `Panel Side`: SVG Chart, Lotka-Volterra Panel, Scenario Tools, Presets.
- `Announcer`: Screen reader output.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ecosystem Lab</title>
<style>
:root { --bg: #f0f4f8; --panel: #ffffff; --text: #1a202c; --border: #cbd5e0; --accent: #3182ce; --btn: #e2e8f0; --btn-hover: #cbd5e0; }
body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 16px; background: var(--bg); color: var(--text); display: flex; flex-direction: column; gap: 16px; height: 100vh; box-sizing: border-box; }
.layout { display: flex; gap: 16px; flex: 1; min-height: 0; }
.panel-world { flex: 1 1 500px; display: flex; flex-direction: column; gap: 12px; }
.panel-side { flex: 1 1 400px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
@media (max-width: 700px) { .layout { flex-direction: column; } .panel-side { flex: 1 1 auto; } }
canvas { background: #222; border-radius: 4px; width: 100%; max-width: 400px; margin: 0 auto; image-rendering: pixelated; }
.controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
button { padding: 8px 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--btn); cursor: pointer; font-weight: 600; }
button:hover { background: var(--btn-hover); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input[type="range"] { width: 100%; }
input[type="number"] { width: 60px; padding: 4px; border: 1px solid var(--border); border-radius: 4px; }
label { display: flex; align-items: center; justify-content: space-between; font-size: 0.9em; margin-bottom: 4px; }
label span { min-width: 40px; text-align: right; }
.counters { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; text-align: center; font-size: 0.9em; }
.counter-box { background: var(--panel); padding: 8px; border-radius: 4px; border: 1px solid var(--border); }
.counter-val { font-size: 1.5em; font-weight: bold; display: block; }
.chart-container { background: var(--panel); border: 1px solid var(--border); border-radius: 4px; padding: 8px; }
svg { width: 100%; height: 200px; }
.ode-panel { background: var(--panel); border: 1px solid var(--border); border-radius: 4px; padding: 8px; }
.ode-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 8px; }
.ode-grid input { width: 100%; box-sizing: border-box; }
.ode-results { font-size: 0.85em; margin-top: 8px; word-break: break-all; }
textarea { width: 100%; height: 80px; font-family: monospace; font-size: 0.8em; border: 1px solid var(--border); border-radius: 4px; padding: 4px; box-sizing: border-box; }
.preset-list { display: flex; flex-direction: column; gap: 4px; }
.preset-item { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; background: var(--btn); border-radius: 4px; font-size: 0.9em; }
.preset-item button { padding: 2px 6px; font-size: 0.8em; }
#announcer { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
h2 { margin: 0 0 8px 0; font-size: 1.1em; }
</style>
</head>
<body>
<div id="announcer" aria-live="polite"></div>
<div class="layout">
  <div class="panel-world">
    <canvas data-testid="world" width="400" height="300"></canvas>
    <div class="controls">
      <button data-testid="play">Play</button>
      <button data-testid="pause">Pause</button>
      <button data-testid="step">Step</button>
      <button data-testid="reset">Reset</button>
      <div>Seed: <input type="number" id="seed" data-testid="seed" value="42"></div>
      <div>Speed: <input type="range" id="speed" data-testid="speed" min="1" max="60" value="10"></div>
    </div>
    <div class="counters">
      <div class="counter-box"><span class="counter-val" id="count-tick" data-testid="tick">0</span>Tick</div>
      <div class="counter-box"><span class="counter-val" id="count-rabbits" data-testid="count-rabbits">0</span>Rabbits</div>
      <div class="counter-box"><span class="counter-val" id="count-foxes" data-testid="count-foxes">0</span>Foxes</div>
      <div class="counter-box"><span class="counter-val" id="count-grass" data-testid="count-grass">0</span>Grass</div>
    </div>
    <div>
      <h2>Parameters</h2>
      <div id="params"></div>
    </div>
  </div>
  <div class="panel-side">
    <div class="chart-container">
      <h2>Population</h2>
      <svg data-testid="chart">
        <polyline data-testid="series-rabbits" fill="none" stroke="blue" stroke-width="2"></polyline>
        <polyline data-testid="series-foxes" fill="none" stroke="red" stroke-width="2"></polyline>
        <text x="50%" y="95%" text-anchor="middle" font-size="12">tick</text>
        <text x="15" y="50%" text-anchor="middle" transform="rotate(-90, 15, 50)" font-size="12">count</text>
      </svg>
    </div>
    <div class="ode-panel">
      <h2>Lotka–Volterra</h2>
      <div class="ode-grid">
        <input type="number" id="ode-alpha" data-testid="ode-alpha" value="1.1" step="0.1">
        <input type="number" id="ode-beta" data-testid="ode-beta" value="0.4" step="0.1">
        <input type="number" id="ode-gamma" data-testid="ode-gamma" value="0.4" step="0.1">
        <input type="number" id="ode-delta" data-testid="ode-delta" value="0.1" step="0.1">
        <input type="number" id="ode-x0" data-testid="ode-x0" value="10" step="1">
        <input type="number" id="ode-y0" data-testid="ode-y0" value="10" step="1">
        <input type="number" id="ode-t" data-testid="ode-t" value="50" step="1">
        <input type="number" id="ode-dt" data-testid="ode-dt" value="0.01" step="0.001">
      </div>
      <button data-testid="ode-run">Run ODE</button>
      <div class="ode-results" id="ode-results"></div>
      <svg data-testid="ode-chart" style="height: 150px; margin-top: 8px;">
        <polyline data-testid="ode-series-x" fill="none" stroke="blue"></polyline>
        <polyline data-testid="ode-series-y" fill="none" stroke="red"></polyline>
      </svg>
    </div>
    <div>
      <h2>Scenario</h2>
      <textarea data-testid="scenario-json"></textarea>
      <div class="controls">
        <button data-testid="scenario-export">Export</button>
        <button data-testid="scenario-load">Load</button>
      </div>
      <div style="color: red; font-size: 0.9em;" data-testid="scenario-error"></div>
    </div>
    <div>
      <h2>Presets</h2>
      <div style="display: flex; gap: 4px; margin-bottom: 8px;">
        <input type="text" id="preset-name" data-testid="preset-name" placeholder="Name">
        <button data-testid="preset-save">Save</button>
      </div>
      <div class="preset-list" data-testid="preset-list"></div>
    </div>
  </div>
</div>

<script>
// 1. Parameters
const DEFAULTS = {
  width: 40, height: 30, grassMax: 4, rabbits0: 100, foxes0: 6,
  rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
  foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
};

// 2. Randomness
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

// 3. The World
class World {
  constructor() {
    this.grid = [];
    this.width = 0;
    this.height = 0;
    this.params = {};
    this.rand = null;
    this.tick = 0;
    this.idCounter = 1;
    this.history = [];
  }

  reset(seed, params = {}) {
    this.params = { ...DEFAULTS, ...params };
    this.width = this.params.width;
    this.height = this.params.height;
    this.rand = mulberry32(seed);
    this.tick = 0;
    this.idCounter = 1;
    this.history = [];

    // Init Grid
    this.grid = [];
    for (let y = 0; y < this.height; y++) {
      const row = [];
      for (let x = 0; x < this.width; x++) {
        row.push({ grass: 0, rabbit: null, fox: null });
      }
      this.grid.push(row);
    }

    // Grass
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        this.grid[y][x].grass = Math.floor(this.rand() * (this.params.grassMax + 1));
      }
    }

    // Rabbits
    for (let i = 0; i < this.params.rabbits0; i++) {
      this.placeAnimal('rabbit');
    }

    // Foxes
    for (let i = 0; i < this.params.foxes0; i++) {
      this.placeAnimal('fox');
    }

    this.recordHistory();
    return this.counts();
  }

  placeAnimal(type) {
    const list = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (!this.grid[y][x][type]) list.push({ x, y });
      }
    }
    if (list.length === 0) return;
    const spot = list[Math.floor(this.rand() * list.length)];
    const cell = this.grid[spot.y][spot.x];
    const id = this.idCounter++;
    const energy = type === 'rabbit' ? this.params.rabbitStart : this.params.foxStart;
    cell[type] = { id, energy };
  }

  step(n = 1) {
    for (let i = 0; i < n; i++) {
      this.tick++;
      this.runTick();
      this.recordHistory();
    }
    return this.counts();
  }

  runTick() {
    // 1. Grass
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        this.grid[y][x].grass = Math.min(this.params.grassMax, this.grid[y][x].grass + 1);
      }
    }

    // 2. Rabbits
    const rabbits = this.getAnimals('rabbit').sort((a, b) => a.id - b.id);
    for (const r of rabbits) {
      this.move(r, 'rabbit');
      this.eat(r, 'rabbit', 'grass');
      r.energy -= this.params.rabbitCost;
      this.breed(r, 'rabbit');
      if (r.energy <= 0) {
        this.grid[r.y][r.x].rabbit = null;
      }
    }

    // 3. Foxes
    const foxes = this.getAnimals('fox').sort((a, b) => a.id - b.id);
    for (const f of foxes) {
      this.move(f, 'fox');
      this.eat(f, 'fox', 'rabbit');
      f.energy -= this.params.foxCost;
      this.breed(f, 'fox');
      if (f.energy <= 0) {
        this.grid[f.y][f.x].fox = null;
      }
    }
  }

  getAnimals(type) {
    const list = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.grid[y][x][type]) list.push({ ...this.grid[y][x][type], x, y });
      }
    }
    return list;
  }

  move(animal, type) {
    const neighbors = this.getNeighbors(animal.x, animal.y);
    const free = neighbors.filter(n => !this.grid[n.y][n.x][type]);
    if (free.length > 0) {
      const spot = free[Math.floor(this.rand() * free.length)];
      this.grid[animal.y][animal.x][type] = null;
      animal.x = spot.x;
      animal.y = spot.y;
      this.grid[spot.y][spot.x][type] = { id: animal.id, energy: animal.energy };
    }
  }

  getNeighbors(x, y) {
    const res = [];
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
        res.push({ x: nx, y: ny });
      }
    }
    return res;
  }

  eat(animal, predator, prey) {
    const cell = this.grid[animal.y][animal.x];
    if (prey === 'grass') {
      const gain = this.params.rabbitGain * cell.grass;
      animal.energy += gain;
      cell.grass = 0;
    } else if (prey === 'rabbit') {
      if (cell.rabbit) {
        cell.rabbit = null;
        animal.energy += this.params.foxGain;
      }
    }
  }

  breed(animal, type) {
    const param = type === 'rabbit' ? this.params.rabbitBreed : this.params.foxBreed;
    if (animal.energy >= param) {
      const neighbors = this.getNeighbors(animal.x, animal.y);
      const free = neighbors.filter(n => !this.grid[n.y][n.x][type]);
      if (free.length > 0) {
        const spot = free[Math.floor(this.rand() * free.length)];
        const child = Math.floor(animal.energy / 2);
        animal.energy -= child;
        const id = this.idCounter++;
        this.grid[spot.y][spot.x][type] = { id, energy: child };
      }
    }
  }

  recordHistory() {
    this.history.push({
      tick: this.tick,
      rabbits: this.countAnimals('rabbit'),
      foxes: this.countAnimals('fox'),
      grass: this.sumGrass()
    });
  }

  countAnimals(type) {
    let count = 0;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.grid[y][x][type]) count++;
      }
    }
    return count;
  }

  sumGrass() {
    let sum = 0;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        sum += this.grid[y][x].grass;
      }
    }
    return sum;
  }

  counts() {
    return {
      rabbits: this.countAnimals('rabbit'),
      foxes: this.countAnimals('fox'),
      grass: this.sumGrass()
    };
  }

  cell(x, y) {
    const c = this.grid[y][x];
    return {
      grass: c.grass,
      rabbit: c.rabbit ? { id: c.rabbit.id, energy: c.rabbit.energy } : null,
      fox: c.fox ? { id: c.fox.id, energy: c.fox.energy } : null
    };
  }

  history() {
    return this.history;
  }

  ode(p, t, dt) {
    const { alpha, beta, gamma, delta, x0, y0 } = p;
    let x = x0, y = y0;
    const n = Math.round(t / dt);
    for (let i = 0; i < n; i++) {
      const k1x = alpha * x - beta * x * y;
      const k1y = delta * x * y - gamma * y;
      const k2x = alpha * (x + dt / 2 * k1x) - beta * (x + dt / 2 * k1x) * (y + dt / 2 * k1y);
      const k2y = delta * (x + dt / 2 * k1x) * (y + dt / 2 * k1y) - gamma * (y + dt / 2 * k1y);
      const k3x = alpha * (x + dt / 2 * k2x) - beta * (x + dt / 2 * k2x) * (y + dt / 2 * k2y);
      const k3y = delta * (x + dt / 2 * k2x) * (y + dt / 2 * k2y) - gamma * (y + dt / 2 * k2y);
      const k4x = alpha * (x + dt * k3x) - beta * (x + dt * k3x) * (y + dt * k3y);
      const k4y = delta * (x + dt * k3x) * (y + dt * k3y) - gamma * (y + dt * k3y);
      x += dt / 6 * (k1x + 2 * k2x + 2 * k3x + k4x);
      y += dt / 6 * (k1y + 2 * k2y + 2 * k3y + k4y);
    }
    return { x, y };
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
      seed: this.rand === null ? 0 : this.rand.toString().split('').reduce((a, b) => a + b.charCodeAt(0), 0), // Hack: store seed in rand? No, store seed separately.
      params: this.params
    });
  }
  
  // Fix: Store seed in instance
  setSeed(seed) { this._seed = seed; }
  getSeed() { return this._seed; }
}

// Extend World to store seed
const origReset = World.prototype.reset;
World.prototype.reset = function(seed, params) {
  this._seed = seed;
  return origReset.call(this, seed, params);
};
World.prototype.exportScenario = function() {
  return JSON.stringify({ version: 1, seed: this._seed, params: this.params });
};

const world = new World();

// 4. API
window.lab = {
  reset: (seed, params) => {
    world.reset(seed, params);
    render();
    updateCounters();
    updateChart();
    return world.counts();
  },
  step: (n = 1) => {
    world.step(n);
    render();
    updateCounters();
    updateChart();
    return world.counts();
  },
  counts: () => world.counts(),
  tick: () => world.tick,
  cell: (x, y) => world.cell(x, y),
  history: () => world.history(),
  ode: (p, t, dt) => world.ode(p, t, dt),
  exportCSV: () => world.exportCSV(),
  exportScenario: () => world.exportScenario(),
  loadScenario: (text) => {
    try {
      const data = JSON.parse(text);
      if (data.version !== 1 || !Number.isInteger(data.seed)) throw new Error("Invalid");
      world.reset(data.seed, data.params);
      render();
      updateCounters();
      updateChart();
      document.querySelector('[data-testid="scenario-error"]').textContent = "";
      return true;
    } catch (e) {
      document.querySelector('[data-testid="scenario-error"]').textContent = "Invalid scenario";
      return false;
    }
  }
};

// 5. Rendering
const canvas = document.querySelector('[data-testid="world"]');
const ctx = canvas.getContext('2d');

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const w = world.params.width;
  const h = world.params.height;
  const cellW = canvas.width / w;
  const cellH = canvas.height / h;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = world.grid[y][x];
      const g = cell.grass;
      const grassLevel = Math.round(60 + 160 * g / world.params.grassMax);
      ctx.fillStyle = `rgb(30, ${grassLevel}, 30)`;
      ctx.fillRect(x * cellW, y * cellH, cellW, cellH);

      if (cell.rabbit) {
        ctx.fillStyle = "rgb(240, 240, 240)";
        ctx.fillRect(x * cellW + cellW * 0.3, y * cellH + cellH * 0.3, cellW * 0.4, cellH * 0.4);
      }
      if (cell.fox) {
        ctx.fillStyle = "rgb(220, 80, 20)";
        ctx.fillRect(x * cellW + cellW * 0.3, y * cellH + cellH * 0.3, cellW * 0.4, cellH * 0.4);
      }
    }
  }
}

// 6. Controls
const params = [
  { id: 'rabbits0', min: 0, max: 300 },
  { id: 'foxes0', min: 0, max: 60 },
  { id: 'rabbitBreed', min: 2, max: 40 },
  { id: 'foxBreed', min: 2, max: 60 },
  { id: 'foxGain', min: 1, max: 30 },
  { id: 'grassMax', min: 1, max: 10 }
];

const paramsDiv = document.getElementById('params');
params.forEach(p => {
  const label = document.createElement('label');
  label.innerHTML = `${p.id}: <input type="range" data-testid="param-${p.id}" min="${p.min}" max="${p.max}" value="${DEFAULTS[p.id]}"><span>${DEFAULTS[p.id]}</span>`;
  paramsDiv.appendChild(label);
});

document.querySelectorAll('[data-testid^="param-"]').forEach(input => {
  input.addEventListener('input', () => {
    input.nextElementSibling.textContent = input.value;
  });
});

function updateCounters() {
  const c = world.counts();
  document.getElementById('count-tick').textContent = world.tick;
  document.getElementById('count-rabbits').textContent = c.rabbits;
  document.getElementById('count-foxes').textContent = c.foxes;
  document.getElementById('count-grass').textContent = c.grass;
  document.getElementById('announcer').textContent = `Tick ${world.tick}: ${c.rabbits} rabbits, ${c.foxes} foxes`;
}

let playing = false;
let lastTime = 0;
let tickAccum = 0;

function loop(timestamp) {
  if (!playing) return;
  const speed = parseInt(document.getElementById('speed').value);
  const dt = timestamp - lastTime;
  lastTime = timestamp;
  tickAccum += dt;
  const ticksPerMs = speed / 1000;
  const ticks = Math.floor(tickAccum * ticksPerMs);
  if (ticks > 0) {
    world.step(ticks);
    render();
    updateCounters();
    updateChart();
    tickAccum -= ticks / ticksPerMs;
  }
  requestAnimationFrame(loop);
}

document.querySelector('[data-testid="play"]').addEventListener('click', () => {
  playing = true;
  lastTime = performance.now();
  requestAnimationFrame(loop);
});

document.querySelector('[data-testid="pause"]').addEventListener('click', () => {
  playing = false;
});

document.querySelector('[data-testid="step"]').addEventListener('click', () => {
  world.step(1);
  render();
  updateCounters();
  updateChart();
});

document.querySelector('[data-testid="reset"]').addEventListener('click', () => {
  const seed = parseInt(document.getElementById('seed').value);
  const params = {};
  document.querySelectorAll('[data-testid^="param-"]').forEach(input => {
    params[input.id] = parseInt(input.value);
  });
  window.lab.reset(seed, params);
});

// 7. Chart
const svgChart = document.querySelector('[data-testid="chart"]');
const polyRabbits = svgChart.querySelector('[data-testid="series-rabbits"]');
const polyFoxes = svgChart.querySelector('[data-testid="series-foxes"]');

function updateChart() {
  const hist = world.history();
  if (hist.length === 0) return;
  const maxTick = hist[hist.length - 1].tick;
  const maxCount = Math.max(...hist.map(h => Math.max(h.rabbits, h.foxes, h.grass)), 1);
  const w = 100;
  const h = 100;
  const points = (data, key) => hist.map((d, i) => {
    const x = (d.tick / maxTick) * w;
    const y = h - (d[key] / maxCount) * h;
    return `${x},${y}`;
  }).join(' ');
  polyRabbits.setAttribute('points', points(hist, 'rabbits'));
  polyFoxes.setAttribute('points', points(hist, 'foxes'));
}

// CSV Export
document.querySelector('[data-testid="csv-export"]').addEventListener('click', () => {
  const csv = world.exportCSV();
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ecolab.csv';
  a.click();
  URL.revokeObjectURL(url);
});

// Scenario
document.querySelector('[data-testid="scenario-export"]').addEventListener('click', () => {
  document.querySelector('[data-testid="scenario-json"]').value = world.exportScenario();
});

document.querySelector('[data-testid="scenario-load"]').addEventListener('click', () => {
  const text = document.querySelector('[data-testid="scenario-json"]').value;
  window.lab.loadScenario(text);
});

// 8. ODE
document.querySelector('[data-testid="ode-run"]').addEventListener('click', () => {
  const p = {
    alpha: parseFloat(document.getElementById('ode-alpha').value),
    beta: parseFloat(document.getElementById('ode-beta').value),
    gamma: parseFloat(document.getElementById('ode-gamma').value),
    delta: parseFloat(document.getElementById('ode-delta').value),
    x0: parseFloat(document.getElementById('ode-x0').value),
    y0: parseFloat(document.getElementById('ode-y0').value)
  };
  const t = parseFloat(document.getElementById('ode-t').value);
  const dt = parseFloat(document.getElementById('ode-dt').value);
  const res = world.ode(p, t, dt);

  const eqX = p.gamma / p.delta;
  const eqY = p.alpha / p.beta;
  const V = (x, y) => p.delta * x - p.gamma * Math.log(x) + p.beta * y - p.alpha * Math.log(y);
  const drift = Math.abs(V(res.x, res.y) - V(p.x0, p.y0));

  document.getElementById('ode-results').innerHTML = `
    x: ${res.x.toFixed(8)}, y: ${res.y.toFixed(8)}<br>
    eq-x: ${eqX.toFixed(8)}, eq-y: ${eqY.toFixed(8)}<br>
    drift: ${drift.toFixed(8)}
  `;

  // Draw ODE chart
  const svgOde = document.querySelector('[data-testid="ode-chart"]');
  const polyX = svgOde.querySelector('[data-testid="ode-series-x"]');
  const polyY = svgOde.querySelector('[data-testid="ode-series-y"]');
  
  // Generate trajectory points
  let x = p.x0, y = p.y0;
  const n = Math.round(t / dt);
  const pointsX = [];
  const pointsY = [];
  for (let i = 0; i <= n; i++) {
    const tx = (i / n) * 100;
    const ty = 100 - (y / Math.max(p.x0, p.y0, 1)) * 100;
    pointsX.push(`${tx},${ty}`);
    pointsY.push(`${tx},${100 - (x / Math.max(p.x0, p.y0, 1)) * 100}`);
    const k1x = p.alpha * x - p.beta * x * y;
    const k1y = p.delta * x * y - p.gamma * y;
    const k2x = p.alpha * (x + dt / 2 * k1x) - p.beta * (x + dt / 2 * k1x) * (y + dt / 2 * k1y);
    const k2y = p.delta * (x + dt / 2 * k1x) * (y + dt / 2 * k1y) - p.gamma * (y + dt / 2 * k1y);
    const k3x = p.alpha * (x + dt / 2 * k2x) - p.beta * (x + dt / 2 * k2x) * (y + dt / 2 * k2y);
    const k3y = p.delta * (x + dt / 2 * k2x) * (y + dt / 2 * k2y) - p.gamma * (y + dt / 2 * k2y);
    const k4x = p.alpha * (x + dt * k3x) - p.beta * (x + dt * k3x) * (y + dt * k3y);
    const k4y = p.delta * (x + dt * k3x) * (y + dt * k3y) - p.gamma * (y + dt * k3y);
    x += dt / 6 * (k1x + 2 * k2x + 2 * k3x + k4x);
    y += dt / 6 * (k1y + 2 * k2y + 2 * k3y + k4y);
  }
  polyX.setAttribute('points', pointsX.join(' '));
  polyY.setAttribute('points', pointsY.join(' '));
});

// 9. Presets
const presetList = document.querySelector('[data-testid="preset-list"]');
const presetNameInput = document.getElementById('preset-name');

function loadPresets() {
  presetList.innerHTML = '';
  const stored = localStorage.getItem('ecolab.presets');
  let presets = {};
  try { presets = JSON.parse(stored); } catch (e) {}
  for (const name in presets) {
    const item = document.createElement('div');
    item.className = 'preset-item';
    item.innerHTML = `
      <span>${name}</span>
      <div>
        <button data-testid="preset-load">Load</button>
        <button data-testid="preset-delete">Delete</button>
      </div>
    `;
    item.querySelector('[data-testid="preset-load"]').addEventListener('click', () => {
      const text = JSON.stringify(presets[name]);
      window.lab.loadScenario(text);
    });
    item.querySelector('[data-testid="preset-delete"]').addEventListener('click', () => {
      delete presets[name];
      localStorage.setItem('ecolab.presets', JSON.stringify(presets));
      loadPresets();
    });
    presetList.appendChild(item);
  }
}

document.querySelector('[data-testid="preset-save"]').addEventListener('click', () => {
  const name = presetNameInput.value.trim();
  if (!name) return;
  const stored = localStorage.getItem('ecolab.presets');
  let presets = {};
  try { presets = JSON.parse(stored); } catch (e) {}
  presets[name] = JSON.parse(world.exportScenario());
  localStorage.setItem('ecolab.presets', JSON.stringify(presets));
  loadPresets();
});

loadPresets();

// 10. Accessibility & Keyboard
document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'BUTTON') return;
  if (e.code === 'Space') {
    e.preventDefault();
    playing ? document.querySelector('[data-testid="pause"]').click() : document.querySelector('[data-testid="play"]').click();
  } else if (e.key === 's') {
    e.preventDefault();
    document.querySelector('[data-testid="step"]').click();
  } else if (e.key === 'r') {
    e.preventDefault();
    document.querySelector('[data-testid="reset"]').click();
  }
});

// Init
window.lab.reset(42, {});
</script>
</body>
</html>
```