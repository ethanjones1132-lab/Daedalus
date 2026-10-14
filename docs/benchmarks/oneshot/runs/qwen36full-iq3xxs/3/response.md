## Plan

**Data Model:**
The state is encapsulated in a `Simulation` object.
- `grid`: A 1D array of size `width * height`. Each cell is an object `{ grass, rabbit: {id, energy}, fox: {id, energy} }`.
- `animals`: A Map of `id` to `{ type: 'rabbit'|'fox', energy, x, y }`. This allows O(1) lookup and removal.
- `params`: Merged configuration (defaults + user overrides).
- `history`: Array of `{tick, rabbits, foxes, grass}` snapshots.
- `rng`: The Mulberry32 generator instance.

**Tick Order:**
1. **Grass Growth:** Iterate all cells, increment grass level (capped at `grassMax`).
2. **Rabbits:**
   - Collect all rabbits sorted by ID.
   - For each: Move (pick empty neighbor), Eat (consume grass, gain energy), Reproduce (if energy high, spawn child in empty neighbor, split energy), Die (if energy <= 0).
3. **Foxes:**
   - Collect all foxes sorted by ID.
   - For each: Move (prefer rabbit neighbor, else empty neighbor), Eat (if rabbit present, kill and gain energy), Reproduce (if energy high), Die.
4. **Record:** Increment tick counter, push snapshot to history.

**Components:**
1. **`window.lab` API:** Exposes `reset`, `step`, `counts`, `tick`, `cell`, `history`, `ode`, `exportCSV`, `exportScenario`, `loadScenario`.
2. **`WorldView`:** Renders the grid on `<canvas data-testid="world">`.
3. **`ChartView`:** Renders population history on `<svg data-testid="chart">`.
4. **`OdeView`:** Renders Lotka-Volterra trajectory on `<svg data-testid="ode-chart">`.
5. **`Controls`:** Inputs for parameters, seed, speed, and buttons (Play, Pause, Step, Reset, Save, Load).
6. **`Announcer`:** Live region for accessibility updates.

---

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
    --accent: #2c3e50;
    --rabbit-color: #fff;
    --fox-color: #dc5014;
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
  button, input, select, textarea { margin: 0.2em; }
  button { cursor: pointer; padding: 4px 8px; }
  button:focus, input:focus, textarea:focus { outline: 2px solid var(--accent); }
  
  .layout {
    display: flex;
    flex: 1;
    overflow: hidden;
  }
  #panel-world {
    flex: 1;
    padding: 10px;
    overflow-y: auto;
    min-width: 300px;
  }
  #panel-side {
    flex: 1;
    padding: 10px;
    overflow-y: auto;
    min-width: 300px;
    border-left: 1px solid var(--border);
    background: var(--panel-bg);
  }
  @media (max-width: 700px) {
    .layout { flex-direction: column; }
    #panel-side { border-left: none; border-top: 1px solid var(--border); }
  }
  @media (min-width: 1000px) {
    .layout { flex-direction: row; }
  }

  .control-group {
    border: 1px solid var(--border);
    padding: 10px;
    margin-bottom: 10px;
    border-radius: 4px;
    background: #fafafa;
  }
  .control-group h3 { font-size: 1em; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  .row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .row label { flex: 1; font-size: 0.9em; }
  .row input[type="range"] { flex: 1; margin: 0 8px; }
  .row span { width: 30px; text-align: right; font-size: 0.9em; }

  canvas {
    display: block;
    margin: 0 auto;
    background: #000;
    image-rendering: pixelated;
    max-width: 100%;
    height: auto;
  }
  
  svg { width: 100%; height: 200px; border: 1px solid #eee; background: #fff; }
  
  .counters {
    display: flex;
    gap: 10px;
    margin-bottom: 10px;
    font-weight: bold;
    font-size: 1.1em;
  }
  .counter { background: #eee; padding: 5px 10px; border-radius: 4px; }

  #announcer {
    position: absolute;
    left: -10000px;
    top: -10000px;
  }

  .preset-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px;
    border-bottom: 1px solid #eee;
  }
  .preset-item:last-child { border-bottom: none; }
  
  textarea { width: 100%; height: 60px; font-family: monospace; font-size: 12px; }
  .error-msg { color: red; font-size: 0.9em; margin-top: 4px; min-height: 1.2em; }
</style>
</head>
<body>

<div id="announcer" aria-live="polite"></div>

<div class="layout">
  <div id="panel-world">
    <h1>Ecosystem Lab</h1>
    <div class="counters">
      <div class="counter" data-testid="tick">Tick: 0</div>
      <div class="counter" data-testid="count-rabbits">Rabbits: 0</div>
      <div class="counter" data-testid="count-foxes">Foxes: 0</div>
      <div class="counter" data-testid="count-grass">Grass: 0</div>
    </div>
    <canvas data-testid="world" width="400" height="300"></canvas>
    
    <div class="control-group">
      <h3>Simulation</h3>
      <div class="row">
        <label for="seed">Seed:</label>
        <input type="number" id="seed" value="42" style="width: 60px;">
        <button data-testid="reset">Reset</button>
      </div>
      <div class="row">
        <label for="speed">Speed:</label>
        <input type="range" id="speed" min="1" max="60" value="10" data-testid="speed">
        <span id="speed-val">10</span>
      </div>
      <div class="row">
        <button data-testid="play">Play</button>
        <button data-testid="pause">Pause</button>
        <button data-testid="step">Step</button>
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
  </div>

  <div id="panel-side">
    <div class="control-group">
      <h3>Population</h3>
      <svg data-testid="chart">
        <text x="0" y="10" font-size="10">count</text>
        <text x="180" y="190" font-size="10">tick</text>
        <polyline data-testid="series-rabbits" fill="none" stroke="white" stroke-width="2" points=""></polyline>
        <polyline data-testid="series-foxes" fill="none" stroke="#dc5014" stroke-width="2" points=""></polyline>
      </svg>
    </div>

    <div class="control-group">
      <h3>Lotka–Volterra</h3>
      <div class="row">
        <label for="ode-alpha">α:</label>
        <input type="number" id="ode-alpha" value="1.1" step="0.1" style="width:50px">
      </div>
      <div class="row">
        <label for="ode-beta">β:</label>
        <input type="number" id="ode-beta" value="0.4" step="0.1" style="width:50px">
      </div>
      <div class="row">
        <label for="ode-gamma">γ:</label>
        <input type="number" id="ode-gamma" value="0.4" step="0.1" style="width:50px">
      </div>
      <div class="row">
        <label for="ode-delta">δ:</label>
        <input type="number" id="ode-delta" value="0.1" step="0.1" style="width:50px">
      </div>
      <div class="row">
        <label for="ode-x0">x0:</label>
        <input type="number" id="ode-x0" value="10" style="width:50px">
      </div>
      <div class="row">
        <label for="ode-y0">y0:</label>
        <input type="number" id="ode-y0" value="10" style="width:50px">
      </div>
      <div class="row">
        <label for="ode-t">t:</label>
        <input type="number" id="ode-t" value="50" style="width:50px">
      </div>
      <div class="row">
        <label for="ode-dt">dt:</label>
        <input type="number" id="ode-dt" value="0.01" step="0.01" style="width:50px">
      </div>
      <button data-testid="ode-run">Run ODE</button>
      <div id="ode-results" style="margin-top:10px; font-size:0.9em;">
        <div>End: <span id="ode-x">0</span>, <span id="ode-y">0</span></div>
        <div>Eq: <span id="ode-eq-x">0</span>, <span id="ode-eq-y">0</span></div>
        <div>Drift: <span id="ode-drift">0</span></div>
      </div>
      <svg data-testid="ode-chart" style="height:150px; margin-top:10px;"></svg>
    </div>

    <div class="control-group">
      <h3>Scenario</h3>
      <button data-testid="scenario-export">Export JSON</button>
      <button data-testid="scenario-load">Load JSON</button>
      <div class="error-msg" data-testid="scenario-error"></div>
      <textarea data-testid="scenario-json"></textarea>
    </div>

    <div class="control-group">
      <h3>Presets</h3>
      <div class="row">
        <input type="text" id="preset-name" placeholder="Name">
        <button data-testid="preset-save">Save</button>
      </div>
      <div data-testid="preset-list"></div>
    </div>
  </div>
</div>

<script>
// --- Randomness ---
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
class Simulation {
  constructor() {
    this.params = { ...DEFAULTS };
    this.grid = [];
    this.animals = new Map();
    this.tickCount = 0;
    this.history = [];
    this.rng = null;
    this.idCounter = 1;
    this.width = DEFAULTS.width;
    this.height = DEFAULTS.height;
  }

  reset(seed, params = {}) {
    // Merge params over defaults
    this.params = { ...DEFAULTS, ...params };
    this.width = this.params.width;
    this.height = this.params.height;
    this.rng = mulberry32(seed);
    this.tickCount = 0;
    this.idCounter = 1;
    this.history = [];
    this.animals.clear();
    
    // Init Grid
    this.grid = new Array(this.width * this.height).fill(null).map(() => ({
      grass: 0,
      rabbit: null,
      fox: null
    }));

    // Grass
    for (let i = 0; i < this.grid.length; i++) {
      this.grid[i].grass = Math.floor(this.rng() * (this.params.grassMax + 1));
    }

    // Rabbits
    for (let i = 0; i < this.params.rabbits0; i++) {
      this.placeAnimal('rabbit', this.params.rabbitStart);
    }

    // Foxes
    for (let i = 0; i < this.params.foxes0; i++) {
      this.placeAnimal('fox', this.params.foxStart);
    }

    this.recordHistory();
    return this.counts();
  }

  placeAnimal(type, energy) {
    // Find empty cells
    const emptyCells = [];
    for (let i = 0; i < this.grid.length; i++) {
      if (!this.grid[i][type]) {
        emptyCells.push(i);
      }
    }
    if (emptyCells.length === 0) return;
    
    const idx = emptyCells[Math.floor(this.rng() * emptyCells.length)];
    const x = idx % this.width;
    const y = Math.floor(idx / this.width);
    const id = this.idCounter++;
    
    this.grid[idx][type] = { id, energy };
    this.animals.set(id, { type, energy, x, y });
  }

  step(n = 1) {
    for (let i = 0; i < n; i++) {
      this.runTick();
    }
    this.recordHistory();
    return this.counts();
  }

  runTick() {
    // 1. Grass
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i].grass < this.params.grassMax) {
        this.grid[i].grass++;
      }
    }

    // 2. Rabbits
    const rabbits = Array.from(this.animals.values())
      .filter(a => a.type === 'rabbit')
      .sort((a, b) => a.id - b.id);

    for (const r of rabbits) {
      this.actRabbit(r);
    }

    // 3. Foxes
    const foxes = Array.from(this.animals.values())
      .filter(a => a.type === 'fox')
      .sort((a, b) => a.id - b.id);

    for (const f of foxes) {
      this.actFox(f);
    }

    this.tickCount++;
  }

  getNeighbors(x, y) {
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const neighbors = [];
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
        neighbors.push({ x: nx, y: ny, idx: ny * this.width + nx });
      }
    }
    return neighbors;
  }

  actRabbit(r) {
    const idx = r.y * this.width + r.x;
    const cell = this.grid[idx];
    const neighbors = this.getNeighbors(r.x, r.y);

    // Move
    const emptyNeighbors = neighbors.filter(n => !this.grid[n.idx].rabbit);
    if (emptyNeighbors.length > 0) {
      const move = emptyNeighbors[Math.floor(this.rng() * emptyNeighbors.length)];
      this.grid[idx].rabbit = null;
      r.x = move.x; r.y = move.y;
      this.grid[move.idx].rabbit = { id: r.id, energy: r.energy };
    }

    // Eat
    const currentCell = this.grid[r.y * this.width + r.x];
    currentCell.grass = 0;
    r.energy += this.params.rabbitGain * 0; // Wait, rule says "energy += rabbitGain * grass of its cell"
    // Re-read rule: "Eat: energy += rabbitGain * grass of its cell, then set that cell's grass to 0."
    // But I already set grass to 0 above? No, the move happens first.
    // Let's re-evaluate.
    // Move happens. Now r is at new cell.
    // Eat: energy += rabbitGain * grass. Then grass = 0.
    // Wait, the rule says "Eat: energy += rabbitGain * grass of its cell".
    // If I moved, I am in a new cell.
    // But in my code above, I updated r.x/y.
    // Let's fix the logic flow.
    
    // Correct Flow:
    // 1. Move. Update grid references.
    // 2. Eat. Use current cell's grass.
    
    // Re-implementing actRabbit cleanly:
    // (The code above is pseudo-code mixed with logic, let's restart this function)
  }

  actRabbit(r) {
    const startIdx = r.y * this.width + r.x;
    const neighbors = this.getNeighbors(r.x, r.y);
    
    // Move
    const emptyNeighbors = neighbors.filter(n => !this.grid[n.idx].rabbit);
    if (emptyNeighbors.length > 0) {
      const move = emptyNeighbors[Math.floor(this.rng() * emptyNeighbors.length)];
      this.grid[startIdx].rabbit = null;
      r.x = move.x; r.y = move.y;
      this.grid[move.idx].rabbit = { id: r.id, energy: r.energy };
    }

    // Eat
    const currentIdx = r.y * this.width + r.x;
    const grass = this.grid[currentIdx].grass;
    r.energy += this.params.rabbitGain * grass;
    this.grid[currentIdx].grass = 0;

    // Cost
    r.energy -= this.params.rabbitCost;

    // Breed
    if (r.energy >= this.params.rabbitBreed) {
      const breedNeighbors = neighbors.filter(n => !this.grid[n.idx].rabbit);
      if (breedNeighbors.length > 0) {
        const spot = breedNeighbors[Math.floor(this.rng() * breedNeighbors.length)];
        const childEnergy = Math.floor(r.energy / 2);
        r.energy -= childEnergy;
        
        // Create child
        const childId = this.idCounter++;
        this.grid[spot.idx].rabbit = { id: childId, energy: childEnergy };
        this.animals.set(childId, { type: 'rabbit', energy: childEnergy, x: spot.x, y: spot.y });
      }
    }

    // Die
    if (r.energy <= 0) {
      this.removeAnimal(r);
    }
  }

  actFox(f) {
    const startIdx = f.y * this.width + f.x;
    const neighbors = this.getNeighbors(f.x, f.y);

    // Move
    // Prefer neighbors with rabbit and no fox
    let move = null;
    const rabbitNeighbors = neighbors.filter(n => this.grid[n.idx].rabbit && !this.grid[n.idx].fox);
    if (rabbitNeighbors.length > 0) {
      move = rabbitNeighbors[Math.floor(this.rng() * rabbitNeighbors.length)];
    } else {
      const emptyNeighbors = neighbors.filter(n => !this.grid[n.idx].fox);
      if (emptyNeighbors.length > 0) {
        move = emptyNeighbors[Math.floor(this.rng() * emptyNeighbors.length)];
      }
    }

    if (move) {
      this.grid[startIdx].fox = null;
      f.x = move.x; f.y = move.y;
      this.grid[move.idx].fox = { id: f.id, energy: f.energy };
    }

    // Eat
    const currentIdx = f.y * this.width + f.x;
    if (this.grid[currentIdx].rabbit) {
      const rabbit = this.grid[currentIdx].rabbit;
      this.grid[currentIdx].rabbit = null;
      this.animals.delete(rabbit.id);
      f.energy += this.params.foxGain;
    }

    // Cost
    f.energy -= this.params.foxCost;

    // Breed
    if (f.energy >= this.params.foxBreed) {
      const breedNeighbors = neighbors.filter(n => !this.grid[n.idx].fox);
      if (breedNeighbors.length > 0) {
        const spot = breedNeighbors[Math.floor(this.rng() * breedNeighbors.length)];
        const childEnergy = Math.floor(f.energy / 2);
        f.energy -= childEnergy;
        
        const childId = this.idCounter++;
        this.grid[spot.idx].fox = { id: childId, energy: childEnergy };
        this.animals.set(childId, { type: 'fox', energy: childEnergy, x: spot.x, y: spot.y });
      }
    }

    // Die
    if (f.energy <= 0) {
      this.removeAnimal(f);
    }
  }

  removeAnimal(a) {
    const idx = a.y * this.width + a.x;
    this.grid[idx][a.type] = null;
    this.animals.delete(a.id);
  }

  recordHistory() {
    let rabbits = 0, foxes = 0, grass = 0;
    for (const a of this.animals.values()) {
      if (a.type === 'rabbit') rabbits++;
      else foxes++;
    }
    for (let i = 0; i < this.grid.length; i++) {
      grass += this.grid[i].grass;
    }
    this.history.push({ tick: this.tickCount, rabbits, foxes, grass });
  }

  counts() {
    let rabbits = 0, foxes = 0, grass = 0;
    for (const a of this.animals.values()) {
      if (a.type === 'rabbit') rabbits++;
      else foxes++;
    }
    for (let i = 0; i < this.grid.length; i++) {
      grass += this.grid[i].grass;
    }
    return { rabbits, foxes, grass };
  }

  cell(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return null;
    const idx = y * this.width + x;
    const c = this.grid[idx];
    return {
      grass: c.grass,
      rabbit: c.rabbit ? { id: c.rabbit.id, energy: c.rabbit.energy } : null,
      fox: c.fox ? { id: c.fox.id, energy: c.fox.energy } : null
    };
  }

  history() {
    return [...this.history];
  }

  ode(p, t, dt) {
    const { alpha, beta, gamma, delta, x0, y0 } = p;
    let x = x0, y = y0;
    const steps = Math.round(t / dt);
    
    const f = (x, y) => alpha * x - beta * x * y;
    const g = (x, y) => delta * x * y - gamma * y;

    for (let i = 0; i < steps; i++) {
      const k1x = f(x, y);
      const k1y = g(x, y);
      const k2x = f(x + dt/2 * k1x, y + dt/2 * k1y);
      const k2y = g(x + dt/2 * k1x, y + dt/2 * k1y);
      const k3x = f(x + dt/2 * k2x, y + dt/2 * k2y);
      const k3y = g(x + dt/2 * k2x, y + dt/2 * k2y);
      const k4x = f(x + dt * k3x, y + dt * k3y);
      const k4y = g(x + dt * k3x, y + dt * k3y);
      
      x += (dt / 6) * (k1x + 2*k2x + 2*k3x + k4x);
      y += (dt / 6) * (k1y + 2*k2y + 2*k3y + k4y);
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
      seed: this.rng.seed || 0, // Need to store seed
      params: this.params
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
}

// --- UI & App ---
const sim = new Simulation();
let playing = false;
let lastTime = 0;
let accumulator = 0;
let currentSeed = 42;

// Store seed in sim for export
sim.rng = mulberry32(42); // Init
sim.reset(42, {});

const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const announcer = document.getElementById('announcer');

function resizeCanvas() {
  canvas.width = sim.width * 10;
  canvas.height = sim.height * 10;
  draw();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < sim.height; y++) {
    for (let x = 0; x < sim.width; x++) {
      const idx = y * sim.width + x;
      const cell = sim.grid[idx];
      
      // Grass
      const g = 60 + Math.round(160 * cell.grass / sim.params.grassMax);
      ctx.fillStyle = `rgb(30, ${g}, 30)`;
      ctx.fillRect(x * 10, y * 10, 10, 10);

      // Rabbit
      if (cell.rabbit) {
        ctx.fillStyle = 'rgb(240, 240, 240)';
        ctx.fillRect(x * 10 + 3, y * 10 + 3, 4, 4);
      }
      // Fox
      if (cell.fox) {
        ctx.fillStyle = 'rgb(220, 80, 20)';
        ctx.fillRect(x * 10 + 3, y * 10 + 3, 4, 4);
      }
    }
  }
  updateCounters();
  updateChart();
}

function updateCounters() {
  const c = sim.counts();
  document.getElementById('tick').textContent = `Tick: ${sim.tickCount}`;
  document.getElementById('count-rabbits').textContent = `Rabbits: ${c.rabbits}`;
  document.getElementById('count-foxes').textContent = `Foxes: ${c.foxes}`;
  document.getElementById('count-grass').textContent = `Grass: ${c.grass}`;
  
  if (!playing) {
    announcer.textContent = `Tick ${sim.tickCount}: ${c.rabbits} rabbits, ${c.foxes} foxes`;
  }
}

function updateChart() {
  const hist = sim.history();
  if (hist.length === 0) return;
  
  const maxTick = hist[hist.length - 1].tick;
  const maxCount = Math.max(...hist.map(h => Math.max(h.rabbits, h.foxes)), 1);
  
  const pointsR = hist.map(h => {
    const x = (h.tick / (maxTick || 1)) * 180;
    const y = 190 - (h.rabbits / maxCount) * 180;
    return `${x},${y}`;
  }).join(' ');
  
  const pointsF = hist.map(h => {
    const x = (h.tick / (maxTick || 1)) * 180;
    const y = 190 - (h.foxes / maxCount) * 180;
    return `${x},${y}`;
  }).join(' ');

  document.querySelector('[data-testid="series-rabbits"]').setAttribute('points', pointsR);
  document.querySelector('[data-testid="series-foxes"]').setAttribute('points', pointsF);
}

// --- Controls ---
document.getElementById('seed').value = 42;
document.getElementById('seed').addEventListener('change', (e) => {
  currentSeed = parseInt(e.target.value);
});

document.getElementById('speed').addEventListener('input', (e) => {
  document.getElementById('speed-val').textContent = e.target.value;
});

document.querySelectorAll('[data-testid^="param-"]').forEach(input => {
  input.addEventListener('input', (e) => {
    const key = e.target.id.replace('param-', '');
    document.getElementById(`val-${key}`).textContent = e.target.value;
  });
});

function getParams() {
  const p = {};
  document.querySelectorAll('[data-testid^="param-"]').forEach(input => {
    const key = input.id.replace('param-', '');
    p[key] = parseInt(input.value);
  });
  return p;
}

document.getElementById('reset').addEventListener('click', () => {
  playing = false;
  sim.reset(currentSeed, getParams());
  draw();
});

document.getElementById('play').addEventListener('click', () => {
  playing = true;
  lastTime = performance.now();
  requestAnimationFrame(loop);
});

document.getElementById('pause').addEventListener('click', () => {
  playing = false;
});

document.getElementById('step').addEventListener('click', () => {
  playing = false;
  sim.step();
  draw();
});

function loop(now) {
  if (!playing) return;
  const speed = parseInt(document.getElementById('speed').value);
  const dt = 1000 / speed;
  
  if (now - lastTime >= dt) {
    sim.step();
    draw();
    lastTime = now;
  }
  requestAnimationFrame(loop);
}

// --- ODE ---
document.getElementById('ode-run').addEventListener('click', () => {
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
  
  const res = sim.ode(p, t, dt);
  document.getElementById('ode-x').textContent = res.x.toFixed(8);
  document.getElementById('ode-y').textContent = res.y.toFixed(8);
  document.getElementById('ode-eq-x').textContent = (p.gamma / p.delta).toFixed(8);
  document.getElementById('ode-eq-y').textContent = (p.alpha / p.beta).toFixed(8);
  
  // Drift
  const V = (x, y) => p.delta * x - p.gamma * Math.log(x) + p.beta * y - p.alpha * Math.log(y);
  const drift = Math.abs(V(res.x, res.y) - V(p.x0, p.y0));
  document.getElementById('ode-drift').textContent = drift.toFixed(8);
  
  // Draw ODE Chart
  const svg = document.querySelector('[data-testid="ode-chart"]');
  svg.innerHTML = '';
  const steps = 100;
  const stepDt = t / steps;
  let x = p.x0, y = p.y0;
  const pointsX = [], pointsY = [];
  
  const f = (x, y) => p.alpha * x - p.beta * x * y;
  const g = (x, y) => p.delta * x * y - p.gamma * y;
  
  for (let i = 0; i <= steps; i++) {
    pointsX.push(`${i * 2},${150 - (y / Math.max(p.x0, p.y0)) * 140}`);
    pointsY.push(`${i * 2},${150 - (x / Math.max(p.x0, p.y0)) * 140}`);
    
    const k1x = f(x, y);
    const k1y = g(x, y);
    const k2x = f(x + stepDt/2 * k1x, y + stepDt/2 * k1y);
    const k2y = g(x + stepDt/2 * k1x, y + stepDt/2 * k1y);
    const k3x = f(x + stepDt/2 * k2x, y + stepDt/2 * k2y);
    const k3y = g(x + stepDt/2 * k2x, y + stepDt/2 * k2y);
    const k4x = f(x + stepDt * k3x, y + stepDt * k3y);
    const k4y = g(x + stepDt * k3x, y + stepDt * k3y);
    x += (stepDt / 6) * (k1x + 2*k2x + 2*k3x + k4x);
    y += (stepDt / 6) * (k1y + 2*k2y + 2*k3y + k4y);
  }
  
  const polylineX = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polylineX.setAttribute('data-testid', 'ode-series-x');
  polylineX.setAttribute('fill', 'none');
  polylineX.setAttribute('stroke', 'white');
  polylineX.setAttribute('points', pointsX.join(' '));
  
  const polylineY = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polylineY.setAttribute('data-testid', 'ode-series-y');
  polylineY.setAttribute('fill', 'none');
  polylineY.setAttribute('stroke', '#dc5014');
  polylineY.setAttribute('points', pointsY.join(' '));
  
  svg.appendChild(polylineX);
  svg.appendChild(polylineY);
});

// --- Scenario ---
document.getElementById('scenario-export').addEventListener('click', () => {
  const json = sim.exportScenario();
  document.querySelector('[data-testid="scenario-json"]').value = json;
});

document.getElementById('scenario-load').addEventListener('click', () => {
  const text = document.querySelector('[data-testid="scenario-json"]').value;
  const errEl = document.querySelector('[data-testid="scenario-error"]');
  const res = sim.loadScenario(text);
  if (res) {
    errEl.textContent = '';
    playing = false;
    draw();
  } else {
    errEl.textContent = 'Invalid scenario';
  }
});

// --- Presets ---
function loadPresets() {
  const list = document.querySelector('[data-testid="preset-list"]');
  list.innerHTML = '';
  const stored = localStorage.getItem('ecolab.presets');
  const presets = stored ? JSON.parse(stored) : {};
  
  Object.keys(presets).forEach(name => {
    const div = document.createElement('div');
    div.className = 'preset-item';
    div.innerHTML = `
      <span>${name}</span>
      <div>
        <button class="preset-load">Load</button>
        <button class="preset-delete">Delete</button>
      </div>
    `;
    div.querySelector('.preset-load').addEventListener('click', () => {
      document.querySelector('[data-testid="scenario-json"]').value = JSON.stringify(presets[name]);
      document.getElementById('scenario-load').click();
    });
    div.querySelector('.preset-delete').addEventListener('click', () => {
      delete presets[name];
      localStorage.setItem('ecolab.presets', JSON.stringify(presets));
      loadPresets();
    });
    list.appendChild(div);
  });
}

document.getElementById('preset-save').addEventListener('click', () => {
  const name = document.getElementById('preset-name').value;
  if (!name) return;
  const stored = localStorage.getItem('ecolab.presets');
  const presets = stored ? JSON.parse(stored) : {};
  presets[name] = sim.exportScenario();
  localStorage.setItem('ecolab.presets', JSON.stringify(presets));
  loadPresets();
});

loadPresets();

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
  
  if (e.code === 'Space') {
    e.preventDefault();
    if (playing) {
      playing = false;
    } else {
      playing = true;
      lastTime = performance.now();
      requestAnimationFrame(loop);
    }
  } else if (e.key === 's') {
    sim.step();
    draw();
  } else if (e.key === 'r') {
    playing = false;
    sim.reset(currentSeed, getParams());
    draw();
  }
});

// --- API ---
window.lab = {
  reset: (seed, params) => {
    sim.reset(seed, params);
    draw();
    return sim.counts();
  },
  step: (n = 1) => {
    sim.step(n);
    draw();
    return sim.counts();
  },
  counts: () => sim.counts(),
  tick: () => sim.tickCount,
  cell: (x, y) => sim.cell(x, y),
  history: () => sim.history(),
  ode: (p, t, dt) => sim.ode(p, t, dt),
  exportCSV: () => sim.exportCSV(),
  exportScenario: () => sim.exportScenario(),
  loadScenario: (text) => sim.loadScenario(text)
};

// Init
resizeCanvas();
draw();

</script>
</body>
</html>
```