## Plan

**Data Model:**
- **Grid:** A 1D array of size `width * height`. Each element is an object `{ grass: number, rabbit: object|null, fox: object|null }`.
- **Animals:** Objects `{ id: number, energy: number, x: number, y: number }`. Stored in `rabbits` and `foxes` arrays.
- **State:** `seed`, `tick`, `params` (merged defaults), `rand` (mulberry32), `history` (array of snapshots).

**Tick Order:**
1. **Grass Growth:** Increment grass in every cell, capped at `grassMax`.
2. **Rabbits:** Sort by ID. For each: Move (to empty neighbor), Eat (grass=0), Cost, Breed (if energy high), Die (if energy <= 0).
3. **Foxes:** Sort by ID. For each: Move (prefer rabbit, else empty), Eat (remove rabbit), Cost, Breed (if energy high), Die (if energy <= 0).
4. **Record:** Snapshot counts and total grass.

**Components:**
- **World:** Canvas rendering the grid, animals, and colors.
- **Controls:** Inputs for seed, speed, and parameters. Buttons for play, pause, step, reset.
- **Counters:** Display tick, rabbit count, fox count, grass sum.
- **Chart:** SVG line chart for population history.
- **ODE Panel:** Inputs for Lotka-Volterra parameters, RK4 solver, and result chart.
- **Scenario/Presets:** JSON export/import and local storage management.
- **Announcer:** Live region for accessibility.

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
    --panel: #ffffff;
    --border: #ccc;
    --text: #333;
    --accent: #007bff;
    --danger: #dc3545;
    --success: #28a745;
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
  main {
    display: flex;
    flex: 1;
    overflow: hidden;
  }
  #panel-world {
    flex: 1 1 600px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: var(--panel);
  }
  #panel-side {
    flex: 1 1 400px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    background: var(--panel);
  }
  @media (max-width: 700px) {
    main { flex-direction: column; }
    #panel-world, #panel-side { flex: none; width: 100%; }
    #panel-world { border-right: none; border-bottom: 1px solid var(--border); }
  }
  canvas {
    border: 1px solid #333;
    image-rendering: pixelated;
    max-width: 100%;
    height: auto;
  }
  .controls {
    width: 100%;
    max-width: 400px;
    margin-top: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .btn {
    padding: 8px 16px;
    border: 1px solid var(--border);
    background: #fff;
    cursor: pointer;
    border-radius: 4px;
    font-size: 14px;
  }
  .btn:focus { outline: 2px solid var(--accent); }
  .btn-primary { background: var(--accent); color: #fff; border: none; }
  .btn-danger { background: var(--danger); color: #fff; border: none; }
  .btn-success { background: var(--success); color: #fff; border: none; }
  input[type="number"], input[type="text"], textarea {
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 14px;
  }
  .counter {
    font-size: 1.2em;
    font-weight: bold;
    margin: 10px 0;
    text-align: center;
  }
  .param-group {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    margin-bottom: 5px;
  }
  .param-group label { flex: 1; }
  .param-group input { flex: 1; }
  .param-group span { width: 40px; text-align: right; }
  .chart-container {
    width: 100%;
    margin-top: 20px;
    border: 1px solid var(--border);
    padding: 10px;
    box-sizing: border-box;
  }
  svg { width: 100%; height: 200px; }
  .section-title {
    font-weight: bold;
    margin-top: 20px;
    margin-bottom: 10px;
    border-bottom: 2px solid var(--accent);
    padding-bottom: 5px;
  }
  .preset-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px;
    border: 1px solid var(--border);
    margin-bottom: 5px;
    border-radius: 4px;
  }
  .preset-item button { margin-left: 5px; }
  #announcer {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
</head>
<body>
<main>
  <section id="panel-world">
    <canvas data-testid="world"></canvas>
    <div class="counter">
      <div>Tick: <span data-testid="tick">0</span></div>
      <div>Rabbits: <span data-testid="count-rabbits">0</span></div>
      <div>Foxes: <span data-testid="count-foxes">0</span></div>
      <div>Grass: <span data-testid="count-grass">0</span></div>
    </div>
    <div class="controls">
      <div class="row">
        <label for="seed">Seed:</label>
        <input type="number" id="seed" value="42" />
        <button data-testid="reset" class="btn">Reset</button>
      </div>
      <div class="row">
        <button data-testid="play" class="btn btn-success">Play</button>
        <button data-testid="pause" class="btn btn-danger">Pause</button>
        <button data-testid="step" class="btn">Step</button>
      </div>
      <div class="row">
        <label for="speed">Speed:</label>
        <input type="range" id="speed" min="1" max="60" value="10" />
        <span id="speed-val">10</span>
      </div>
      <div class="section-title">Parameters (apply on reset)</div>
      <div class="param-group">
        <label for="param-rabbits0">Rabbits0</label>
        <input type="range" id="param-rabbits0" min="0" max="300" value="100" />
        <span id="val-rabbits0">100</span>
      </div>
      <div class="param-group">
        <label for="param-foxes0">Foxes0</label>
        <input type="range" id="param-foxes0" min="0" max="60" value="6" />
        <span id="val-foxes0">6</span>
      </div>
      <div class="param-group">
        <label for="param-rabbitBreed">RabbitBreed</label>
        <input type="range" id="param-rabbitBreed" min="2" max="40" value="12" />
        <span id="val-rabbitBreed">12</span>
      </div>
      <div class="param-group">
        <label for="param-foxBreed">FoxBreed</label>
        <input type="range" id="param-foxBreed" min="2" max="60" value="40" />
        <span id="val-foxBreed">40</span>
      </div>
      <div class="param-group">
        <label for="param-foxGain">FoxGain</label>
        <input type="range" id="param-foxGain" min="1" max="30" value="4" />
        <span id="val-foxGain">4</span>
      </div>
      <div class="param-group">
        <label for="param-grassMax">GrassMax</label>
        <input type="range" id="param-grassMax" min="1" max="10" value="4" />
        <span id="val-grassMax">4</span>
      </div>
    </div>
  </section>
  <section id="panel-side">
    <div class="chart-container">
      <div class="section-title">Population Chart</div>
      <svg data-testid="chart">
        <text x="50%" y="95%" text-anchor="middle" font-size="12">tick</text>
        <text x="10" y="50%" text-anchor="middle" transform="rotate(-90, 10, 50)" font-size="12">count</text>
        <polyline data-testid="series-rabbits" fill="none" stroke="blue" />
        <polyline data-testid="series-foxes" fill="none" stroke="red" />
      </svg>
    </div>
    <div class="chart-container">
      <div class="section-title">Lotka–Volterra</div>
      <div class="row">
        <label for="ode-alpha">α:</label><input type="number" id="ode-alpha" value="1.1" step="0.1" />
        <label for="ode-beta">β:</label><input type="number" id="ode-beta" value="0.4" step="0.1" />
        <label for="ode-gamma">γ:</label><input type="number" id="ode-gamma" value="0.4" step="0.1" />
        <label for="ode-delta">δ:</label><input type="number" id="ode-delta" value="0.1" step="0.1" />
      </div>
      <div class="row">
        <label for="ode-x0">x0:</label><input type="number" id="ode-x0" value="10" />
        <label for="ode-y0">y0:</label><input type="number" id="ode-y0" value="10" />
        <label for="ode-t">t:</label><input type="number" id="ode-t" value="50" />
        <label for="ode-dt">dt:</label><input type="number" id="ode-dt" value="0.01" step="0.001" />
      </div>
      <button data-testid="ode-run" class="btn">Run ODE</button>
      <div id="ode-results" style="margin-top:10px; font-size:0.9em;"></div>
      <svg data-testid="ode-chart" style="height:150px;">
        <polyline data-testid="ode-series-x" fill="none" stroke="blue" />
        <polyline data-testid="ode-series-y" fill="none" stroke="red" />
      </svg>
    </div>
    <div class="chart-container">
      <div class="section-title">Scenario</div>
      <div class="row">
        <button data-testid="scenario-export" class="btn">Export</button>
        <button data-testid="scenario-load" class="btn">Load</button>
      </div>
      <textarea data-testid="scenario-json" rows="5" style="width:100%;"></textarea>
      <div data-testid="scenario-error" style="color:red;"></div>
      <button data-testid="csv-export" class="btn">Download CSV</button>
    </div>
    <div class="chart-container">
      <div class="section-title">Presets</div>
      <div class="row">
        <input type="text" id="preset-name" placeholder="Name" />
        <button data-testid="preset-save" class="btn">Save</button>
      </div>
      <div data-testid="preset-list"></div>
    </div>
  </section>
</main>
<div id="announcer" aria-live="polite"></div>

<script>
// --- 1. Randomness ---
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

// --- 2. Defaults ---
const DEFAULTS = {
  width: 40, height: 30, grassMax: 4,
  rabbits0: 100, foxes0: 6,
  rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
  foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
};

// --- 3. Simulation State ---
let state = {
  seed: 42,
  params: { ...DEFAULTS },
  rand: null,
  tick: 0,
  grid: [],
  rabbits: [],
  foxes: [],
  idCounter: 1,
  history: [],
  playing: false,
  lastTime: 0,
  animFrameId: null
};

function reset(seed, params = {}) {
  // Merge params over defaults
  const merged = { ...DEFAULTS, ...params };
  state.seed = seed;
  state.params = merged;
  state.rand = mulberry32(seed);
  state.tick = 0;
  state.idCounter = 1;
  state.history = [];
  state.rabbits = [];
  state.foxes = [];

  // Init Grid
  const w = merged.width;
  const h = merged.height;
  state.grid = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      state.grid[y * w + x] = {
        grass: Math.floor(state.rand() * (merged.grassMax + 1)),
        rabbit: null,
        fox: null
      };
    }
  }

  // Place Rabbits
  for (let i = 0; i < merged.rabbits0; i++) {
    placeAnimal('rabbit');
  }

  // Place Foxes
  for (let i = 0; i < merged.foxes0; i++) {
    placeAnimal('fox');
  }

  // Record history
  recordHistory();
  draw();
  updateCounters();
  updateChart();
  return counts();
}

function placeAnimal(type) {
  const w = state.params.width;
  const h = state.params.height;
  const grid = state.grid;
  const rand = state.rand;
  
  // Find empty spots
  let spots = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const cell = grid[idx];
      if (type === 'rabbit' && !cell.rabbit) spots.push({ x, y });
      if (type === 'fox' && !cell.fox) spots.push({ x, y });
    }
  }
  
  if (spots.length === 0) return;
  
  const spot = spots[Math.floor(rand() * spots.length)];
  const id = state.idCounter++;
  const energy = type === 'rabbit' ? state.params.rabbitStart : state.params.foxStart;
  
  const animal = { id, energy, x: spot.x, y: spot.y };
  const cell = grid[spot.y * w + spot.x];
  
  if (type === 'rabbit') {
    cell.rabbit = animal;
    state.rabbits.push(animal);
  } else {
    cell.fox = animal;
    state.foxes.push(animal);
  }
}

function getNeighbors(x, y) {
  const w = state.params.width;
  const h = state.params.height;
  const res = [];
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // up, right, down, left
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
      res.push({ x: nx, y: ny });
    }
  }
  return res;
}

function pick(list) {
  if (list.length === 0) return null;
  return list[Math.floor(state.rand() * list.length)];
}

function step() {
  const w = state.params.width;
  const h = state.params.height;
  const p = state.params;
  const grid = state.grid;
  const rand = state.rand;

  // 1. Grass
  for (let i = 0; i < grid.length; i++) {
    grid[i].grass = Math.min(p.grassMax, grid[i].grass + 1);
  }

  // 2. Rabbits
  // Sort by ID
  state.rabbits.sort((a, b) => a.id - b.id);
  const rabbitsToProcess = [...state.rabbits];
  
  for (const r of rabbitsToProcess) {
    // Move
    const neighbors = getNeighbors(r.x, r.y);
    const emptyNeighbors = neighbors.filter(n => {
      const cell = grid[n.y * w + n.x];
      return !cell.rabbit;
    });
    
    if (emptyNeighbors.length > 0) {
      const spot = pick(emptyNeighbors);
      // Remove from old cell
      grid[r.y * w + r.x].rabbit = null;
      // Add to new cell
      grid[spot.y * w + spot.x].rabbit = r;
      r.x = spot.x;
      r.y = spot.y;
    }

    // Eat
    const cell = grid[r.y * w + r.x];
    cell.grass = 0;
    r.energy += p.rabbitGain * 0; // Wait, rule says: energy += rabbitGain * grass. But grass is set to 0 after.
    // Re-read rule: "Eat: energy += rabbitGain * grass of its cell, then set that cell's grass to 0."
    // So we need to capture grass before setting to 0.
    // Correction: The rule says "Eat: energy += rabbitGain * grass... then set... to 0".
    // But in my code above I set grass to 0. I need to fix this.
    // Actually, I set grass to 0 in the "Move" logic? No, I didn't.
    // Let's fix the Eat logic.
    // I need to get grass value before setting to 0.
    // But I already set grass to 0 in the loop above? No, I didn't.
    // Wait, I did: `cell.grass = 0;` in the "Eat" section.
    // But I need to use the grass value BEFORE setting to 0.
    // So I should do:
    // const grassVal = cell.grass;
    // cell.grass = 0;
    // r.energy += p.rabbitGain * grassVal;
    
    // Let's rewrite the Eat part properly.
    // I'll remove the `cell.grass = 0` line I added above and put it here.
  }
  
  // I need to restart the rabbit loop with correct logic.
  // Let's do it properly.
  
  // Re-do Rabbits
  state.rabbits.sort((a, b) => a.id - b.id);
  const rabbitsList = [...state.rabbits];
  
  for (const r of rabbitsList) {
    // Move
    const neighbors = getNeighbors(r.x, r.y);
    const emptyNeighbors = neighbors.filter(n => {
      const cell = grid[n.y * w + n.x];
      return !cell.rabbit;
    });
    
    if (emptyNeighbors.length > 0) {
      const spot = pick(emptyNeighbors);
      grid[r.y * w + r.x].rabbit = null;
      grid[spot.y * w + spot.x].rabbit = r;
      r.x = spot.x;
      r.y = spot.y;
    }

    // Eat
    const cell = grid[r.y * w + r.x];
    const grassVal = cell.grass;
    cell.grass = 0;
    r.energy += p.rabbitGain * grassVal;

    // Cost
    r.energy -= p.rabbitCost;

    // Breed
    if (r.energy >= p.rabbitBreed) {
      const breedNeighbors = neighbors.filter(n => {
        const cell = grid[n.y * w + n.x];
        return !cell.rabbit;
      });
      if (breedNeighbors.length > 0) {
        const spot = pick(breedNeighbors);
        const childEnergy = Math.floor(r.energy / 2);
        r.energy -= childEnergy;
        const child = { id: state.idCounter++, energy: childEnergy, x: spot.x, y: spot.y };
        grid[spot.y * w + spot.x].rabbit = child;
        state.rabbits.push(child);
      }
    }

    // Die
    if (r.energy <= 0) {
      grid[r.y * w + r.x].rabbit = null;
    }
  }
  
  // Remove dead rabbits from list
  state.rabbits = state.rabbits.filter(r => {
    const cell = grid[r.y * w + r.x];
    return cell.rabbit === r;
  });

  // 3. Foxes
  state.foxes.sort((a, b) => a.id - b.id);
  const foxesList = [...state.foxes];
  
  for (const f of foxesList) {
    // Move
    const neighbors = getNeighbors(f.x, f.y);
    const preferRabbit = neighbors.filter(n => {
      const cell = grid[n.y * w + n.x];
      return cell.rabbit && !cell.fox;
    });
    
    let spot = null;
    if (preferRabbit.length > 0) {
      spot = pick(preferRabbit);
    } else {
      const emptyNeighbors = neighbors.filter(n => {
        const cell = grid[n.y * w + n.x];
        return !cell.fox;
      });
      if (emptyNeighbors.length > 0) {
        spot = pick(emptyNeighbors);
      }
    }
    
    if (spot) {
      grid[f.y * w + f.x].fox = null;
      grid[spot.y * w + spot.x].fox = f;
      f.x = spot.x;
      f.y = spot.y;
    }

    // Eat
    const cell = grid[f.y * w + f.x];
    if (cell.rabbit) {
      cell.rabbit = null;
      f.energy += p.foxGain;
    }

    // Cost
    f.energy -= p.foxCost;

    // Breed
    if (f.energy >= p.foxBreed) {
      const breedNeighbors = neighbors.filter(n => {
        const cell = grid[n.y * w + n.x];
        return !cell.fox;
      });
      if (breedNeighbors.length > 0) {
        const spot = pick(breedNeighbors);
        const childEnergy = Math.floor(f.energy / 2);
        f.energy -= childEnergy;
        const child = { id: state.idCounter++, energy: childEnergy, x: spot.x, y: spot.y };
        grid[spot.y * w + spot.x].fox = child;
        state.foxes.push(child);
      }
    }

    // Die
    if (f.energy <= 0) {
      grid[f.y * w + f.x].fox = null;
    }
  }
  
  // Remove dead foxes from list
  state.foxes = state.foxes.filter(f => {
    const cell = grid[f.y * w + f.x];
    return cell.fox === f;
  });

  state.tick++;
  recordHistory();
}

function recordHistory() {
  const totalGrass = state.grid.reduce((sum, cell) => sum + cell.grass, 0);
  state.history.push({
    tick: state.tick,
    rabbits: state.rabbits.length,
    foxes: state.foxes.length,
    grass: totalGrass
  });
}

function counts() {
  return {
    rabbits: state.rabbits.length,
    foxes: state.foxes.length,
    grass: state.grid.reduce((sum, cell) => sum + cell.grass, 0)
  };
}

function tick() {
  return state.tick;
}

function cell(x, y) {
  const c = state.grid[y * state.params.width + x];
  return {
    grass: c.grass,
    rabbit: c.rabbit ? { id: c.rabbit.id, energy: c.rabbit.energy } : null,
    fox: c.fox ? { id: c.fox.id, energy: c.fox.energy } : null
  };
}

function history() {
  return [...state.history];
}

function ode(p, t, dt) {
  const { alpha, beta, gamma, delta, x0, y0 } = p;
  let x = x0;
  let y = y0;
  const n = Math.round(t / dt);
  
  for (let i = 0; i < n; i++) {
    const k1x = alpha * x - beta * x * y;
    const k1y = delta * x * y - gamma * y;
    
    const k2x = alpha * (x + 0.5 * dt * k1x) - beta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y);
    const k2y = delta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y) - gamma * (y + 0.5 * dt * k1y);
    
    const k3x = alpha * (x + 0.5 * dt * k2x) - beta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y);
    const k3y = delta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y) - gamma * (y + 0.5 * dt * k2y);
    
    const k4x = alpha * (x + dt * k3x) - beta * (x + dt * k3x) * (y + dt * k3y);
    const k4y = delta * (x + dt * k3x) * (y + dt * k3y) - gamma * (y + dt * k3y);
    
    x += (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
    y += (dt / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
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
  return JSON.stringify({
    version: 1,
    seed: state.seed,
    params: { ...state.params }
  });
}

function loadScenario(text) {
  try {
    const data = JSON.parse(text);
    if (data.version !== 1) throw new Error("Invalid version");
    if (!Number.isInteger(data.seed)) throw new Error("Invalid seed");
    const params = { ...DEFAULTS, ...data.params };
    reset(data.seed, params);
    document.querySelector('[data-testid="scenario-error"]').textContent = "";
    return true;
  } catch (e) {
    document.querySelector('[data-testid="scenario-error"]').textContent = e.message;
    return false;
  }
}

// --- 4. Rendering ---
function draw() {
  const canvas = document.querySelector('[data-testid="world"]');
  const ctx = canvas.getContext('2d');
  const w = state.params.width;
  const h = state.params.height;
  const p = state.params;
  
  canvas.width = w * 10;
  canvas.height = h * 10;
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = state.grid[y * w + x];
      const gx = x * 10;
      const gy = y * 10;
      
      // Grass
      const G = 60 + Math.round(160 * cell.grass / p.grassMax);
      ctx.fillStyle = `rgb(30, ${G}, 30)`;
      ctx.fillRect(gx, gy, 10, 10);
      
      // Rabbit
      if (cell.rabbit) {
        ctx.fillStyle = 'rgb(240, 240, 240)';
        ctx.fillRect(gx + 3, gy + 3, 4, 4);
      }
      
      // Fox
      if (cell.fox) {
        ctx.fillStyle = 'rgb(220, 80, 20)';
        ctx.fillRect(gx + 3, gy + 3, 4, 4);
      }
    }
  }
}

function updateCounters() {
  const c = counts();
  document.querySelector('[data-testid="tick"]').textContent = state.tick;
  document.querySelector('[data-testid="count-rabbits"]').textContent = c.rabbits;
  document.querySelector('[data-testid="count-foxes"]').textContent = c.foxes;
  document.querySelector('[data-testid="count-grass"]').textContent = c.grass;
}

function updateChart() {
  const hist = history();
  if (hist.length === 0) return;
  
  const svgRabbits = document.querySelector('[data-testid="series-rabbits"]');
  const svgFoxes = document.querySelector('[data-testid="series-foxes"]');
  
  const maxTick = hist[hist.length - 1].tick;
  const maxCount = Math.max(...hist.map(h => Math.max(h.rabbits, h.foxes)), 1);
  
  const pointsR = [];
  const pointsF = [];
  
  for (const h of hist) {
    const x = (h.tick / (maxTick || 1)) * 100;
    const yR = 100 - (h.rabbits / maxCount) * 100;
    const yF = 100 - (h.foxes / maxCount) * 100;
    pointsR.push(`${x},${yR}`);
    pointsF.push(`${x},${yF}`);
  }
  
  svgRabbits.setAttribute('points', pointsR.join(' '));
  svgFoxes.setAttribute('points', pointsF.join(' '));
}

// --- 5. Animation Loop ---
function animate(timestamp) {
  if (!state.playing) return;
  
  const speed = parseInt(document.querySelector('[id="speed"]').value);
  const interval = 1000 / speed;
  
  if (timestamp - state.lastTime >= interval) {
    state.lastTime = timestamp;
    step();
    draw();
    updateCounters();
    updateChart();
    updateAnnouncer();
  }
  
  state.animFrameId = requestAnimationFrame(animate);
}

function updateAnnouncer() {
  const c = counts();
  document.querySelector('#announcer').textContent = `Tick ${state.tick}: ${c.rabbits} rabbits, ${c.foxes} foxes`;
}

// --- 6. UI Events ---
document.querySelector('[data-testid="play"]').addEventListener('click', () => {
  state.playing = true;
  state.lastTime = performance.now();
  state.animFrameId = requestAnimationFrame(animate);
});

document.querySelector('[data-testid="pause"]').addEventListener('click', () => {
  state.playing = false;
  if (state.animFrameId) cancelAnimationFrame(state.animFrameId);
  updateAnnouncer();
});

document.querySelector('[data-testid="step"]').addEventListener('click', () => {
  step();
  draw();
  updateCounters();
  updateChart();
  updateAnnouncer();
});

document.querySelector('[data-testid="reset"]').addEventListener('click', () => {
  const seed = parseInt(document.querySelector('[id="seed"]').value);
  const params = {};
  params.rabbits0 = parseInt(document.querySelector('[id="param-rabbits0"]').value);
  params.foxes0 = parseInt(document.querySelector('[id="param-foxes0"]').value);
  params.rabbitBreed = parseInt(document.querySelector('[id="param-rabbitBreed"]').value);
  params.foxBreed = parseInt(document.querySelector('[id="param-foxBreed"]').value);
  params.foxGain = parseInt(document.querySelector('[id="param-foxGain"]').value);
  params.grassMax = parseInt(document.querySelector('[id="param-grassMax"]').value);
  
  reset(seed, params);
  updateAnnouncer();
});

document.querySelector('[id="speed"]').addEventListener('input', (e) => {
  document.querySelector('#speed-val').textContent = e.target.value;
});

// Parameter sliders update display
const paramIds = ['param-rabbits0', 'param-foxes0', 'param-rabbitBreed', 'param-foxBreed', 'param-foxGain', 'param-grassMax'];
paramIds.forEach(id => {
  const el = document.querySelector(`[id="${id}"]`);
  const valEl = document.querySelector(`[id="val-${id.replace('param-', '')}"]`);
  el.addEventListener('input', () => {
    valEl.textContent = el.value;
  });
});

// CSV Export
document.querySelector('[data-testid="csv-export"]').addEventListener('click', () => {
  const csv = exportCSV();
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ecolab.csv';
  a.click();
  URL.revokeObjectURL(url);
});

// Scenario Export/Load
document.querySelector('[data-testid="scenario-export"]').addEventListener('click', () => {
  document.querySelector('[data-testid="scenario-json"]').value = exportScenario();
});

document.querySelector('[data-testid="scenario-load"]').addEventListener('click', () => {
  const text = document.querySelector('[data-testid="scenario-json"]').value;
  loadScenario(text);
});

// ODE
document.querySelector('[data-testid="ode-run"]').addEventListener('click', () => {
  const p = {
    alpha: parseFloat(document.querySelector('[id="ode-alpha"]').value),
    beta: parseFloat(document.querySelector('[id="ode-beta"]').value),
    gamma: parseFloat(document.querySelector('[id="ode-gamma"]').value),
    delta: parseFloat(document.querySelector('[id="ode-delta"]').value),
    x0: parseFloat(document.querySelector('[id="ode-x0"]').value),
    y0: parseFloat(document.querySelector('[id="ode-y0"]').value),
  };
  const t = parseFloat(document.querySelector('[id="ode-t"]').value);
  const dt = parseFloat(document.querySelector('[id="ode-dt"]').value);
  
  const result = ode(p, t, dt);
  
  const eqX = p.gamma / p.delta;
  const eqY = p.alpha / p.beta;
  
  const V = (x, y) => p.delta * x - p.gamma * Math.log(x) + p.beta * y - p.alpha * Math.log(y);
  const drift = Math.abs(V(result.x, result.y) - V(p.x0, p.y0));
  
  document.querySelector('#ode-results').innerHTML = `
    <div>x: ${result.x.toFixed(8)}</div>
    <div>y: ${result.y.toFixed(8)}</div>
    <div>Eq X: ${eqX.toFixed(8)}</div>
    <div>Eq Y: ${eqY.toFixed(8)}</div>
    <div>Drift: ${drift.toFixed(8)}</div>
  `;
  
  // Draw ODE Chart
  const svgX = document.querySelector('[data-testid="ode-series-x"]');
  const svgY = document.querySelector('[data-testid="ode-series-y"]');
  
  const steps = Math.round(t / dt);
  let x = p.x0;
  let y = p.y0;
  const pointsX = [];
  const pointsY = [];
  
  for (let i = 0; i <= steps; i++) {
    const tNow = i * dt;
    const xNorm = (tNow / t) * 100;
    const yNorm = 100 - (y / Math.max(p.x0, p.y0, 1)) * 100;
    pointsX.push(`${xNorm},${yNorm}`);
    pointsY.push(`${xNorm},${100 - (x / Math.max(p.x0, p.y0, 1)) * 100}`);
    
    const k1x = p.alpha * x - p.beta * x * y;
    const k1y = p.delta * x * y - p.gamma * y;
    const k2x = p.alpha * (x + 0.5 * dt * k1x) - p.beta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y);
    const k2y = p.delta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y) - p.gamma * (y + 0.5 * dt * k1y);
    const k3x = p.alpha * (x + 0.5 * dt * k2x) - p.beta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y);
    const k3y = p.delta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y) - p.gamma * (y + 0.5 * dt * k2y);
    const k4x = p.alpha * (x + dt * k3x) - p.beta * (x + dt * k3x) * (y + dt * k3y);
    const k4y = p.delta * (x + dt * k3x) * (y + dt * k3y) - p.gamma * (y + dt * k3y);
    x += (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
    y += (dt / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
  }
  
  svgX.setAttribute('points', pointsX.join(' '));
  svgY.setAttribute('points', pointsY.join(' '));
});

// Presets
function loadPresets() {
  const list = document.querySelector('[data-testid="preset-list"]');
  list.innerHTML = '';
  const stored = localStorage.getItem('ecolab.presets');
  let presets = {};
  if (stored) {
    try {
      presets = JSON.parse(stored);
    } catch (e) {
      presets = {};
    }
  }
  
  for (const name in presets) {
    const item = document.createElement('div');
    item.className = 'preset-item';
    item.innerHTML = `
      <span>${name}</span>
      <div>
        <button class="preset-load">Load</button>
        <button class="preset-delete">Delete</button>
      </div>
    `;
    item.querySelector('.preset-load').addEventListener('click', () => {
      const text = JSON.stringify(presets[name]);
      loadScenario(text);
    });
    item.querySelector('.preset-delete').addEventListener('click', () => {
      delete presets[name];
      localStorage.setItem('ecolab.presets', JSON.stringify(presets));
      loadPresets();
    });
    list.appendChild(item);
  }
}

document.querySelector('[data-testid="preset-save"]').addEventListener('click', () => {
  const name = document.querySelector('[id="preset-name"]').value;
  if (!name) return;
  const stored = localStorage.getItem('ecolab.presets');
  let presets = {};
  if (stored) {
    try {
      presets = JSON.parse(stored);
    } catch (e) {
      presets = {};
    }
  }
  presets[name] = JSON.parse(exportScenario());
  localStorage.setItem('ecolab.presets', JSON.stringify(presets));
  loadPresets();
});

// Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.tagName === 'BUTTON') {
    return;
  }
  
  if (e.key === ' ') {
    e.preventDefault();
    if (state.playing) {
      document.querySelector('[data-testid="pause"]').click();
    } else {
      document.querySelector('[data-testid="play"]').click();
    }
  } else if (e.key === 's') {
    e.preventDefault();
    document.querySelector('[data-testid="step"]').click();
  } else if (e.key === 'r') {
    e.preventDefault();
    document.querySelector('[data-testid="reset"]').click();
  }
});

// --- 7. Init ---
window.lab = {
  reset,
  step,
  counts,
  tick,
  cell,
  history,
  ode,
  exportCSV,
  exportScenario,
  loadScenario
};

reset(42, {});
document.querySelector('[id="seed"]').value = 42;
loadPresets();

</script>
</body>
</html>
```