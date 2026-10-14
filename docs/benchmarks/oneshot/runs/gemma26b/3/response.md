## Plan

**Data Model**
- **State:** `tick` (int), `idCounter` (int), `rand` (function), `history` (array of objects), `params` (object).
- **Grid:** A 1D array of size `width * height`. Each cell contains `grass` (int), `rabbit` (object `{id, energy}` or `null`), and `fox` (object `{id, energy}` or `null`).
- **Parameters:** A flat object containing all 13 simulation constants.
- **Presets:** A `Map` stored in `localStorage` under `ecolab.presets`.

**Tick Order**
1. **Grass:** Increment every cell's grass level up to `grassMax`.
2. **Rabbits:** 
   - Identify rabbits alive at start of phase.
   - Sort by ID ascending.
   - For each: Move (to empty neighbor), Eat (gain energy from grass), Lose energy, Breed (if energy $\ge$ threshold, create child in empty neighbor), Die (if energy $\le$ 0).
3. **Foxes:**
   - Identify foxes alive at start of phase.
   - Sort by ID ascending.
   - For each: Move (prefer rabbit-containing neighbor, else empty), Eat (remove rabbit, gain energy), Lose energy, Breed (if energy $\ge$ threshold, create child in empty neighbor), Die (if energy $\le$ 0).
4. **Record:** Append `{tick, rabbits, foxes, grass}` to history.

**Components**
- **Simulation Engine:** Handles `reset`, `step`, and the `mulberry32` PRNG.
- **Renderer:** Canvas drawing logic for grass, rabbits, and foxes.
- **Chart Component:** SVG-based line charts for population history and ODE trajectories.
5. **UI Controller:** Manages DOM updates, sliders, playback loop (using `requestAnimationFrame`), and keyboard shortcuts.
6. **ODE Solver:** RK4 integrator for the Lotka–Volterra equations.
7. **Scenario/Preset Manager:** Handles JSON export/import and `localStorage` persistence.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ecosystem Lab</title>
<style>
:root { --bg: #1a1a1a; --panel: #2a2a2a; --text: #e0e0e0; --accent: #4a90e2; --border: #444; }
body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; display: flex; justify-content: center; }
#app { display: flex; flex-direction: column; gap: 20px; max-width: 1200px; width: 100%; }
@media (min-width: 1000px) { #app { flex-direction: row; align-items: flex-start; } }
#panel-world { flex: 1; display: flex; flex-direction: column; gap: 15px; }
#panel-side { flex: 0 0 450px; display: flex; flex-direction: column; gap: 20px; }
@media (max-width: 700px) { #panel-side { flex: 0 0 auto; } }
.card { background: var(--panel); padding: 15px; border-radius: 8px; border: 1px solid var(--border); }
canvas { width: 100%; height: auto; background: #000; display: block; border-radius: 4px; }
svg { width: 100%; height: 200px; background: #111; border-radius: 4px; display: block; }
.controls { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
.control-group { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; }
.counter-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; text-align: center; font-weight: bold; }
.counter-val { font-size: 1.2rem; color: var(--accent); }
button { cursor: pointer; padding: 8px 12px; border: none; border-radius: 4px; background: #444; color: white; transition: background 0.2s; }
button:hover { background: #555; }
button:focus { outline: 2px solid var(--accent); }
input[type="range"] { width: 100%; }
input[type="number"], textarea { width: 100%; background: #333; border: 1px solid var(--border); color: white; padding: 4px; box-sizing: border border-box; }
textarea { height: 80px; font-family: monospace; font-size: 0.8rem; }
.error { color: #ff6b6b; font-size: 0.8rem; margin-top: 5px; }
.preset-item { display: flex; justify-content: space-between; align-items: center; padding: 5px; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
.preset-item:last-child { border-bottom: none; }
.ode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 0.8rem; }
.ode-result { grid-column: span 2; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
polyline { fill: none; stroke-width: 2; }
[data-testid="series-rabbits"] { stroke: #eee; }
[data-testid="series-foxes"] { stroke: #e45013; }
[data-testid="ode-series-x"] { stroke: #eee; }
[data-testid="ode-series-y"] { stroke: #e45013; }
</style>
</head>
<body>
<div id="app">
<div id="panel-world">
<div class="card">
<canvas id="world" data-testid="world"></canvas>
</div>
<div class="card">
<div class="counter-grid">
<div>Tick<div id="tick" class="counter-val">0</div></div>
<div>Rabbits<div id="count-rabbits" class="counter-val">0</div></div>
<div>Foxes<div id="count-foxes" class="counter-val">0</div></div>
<div>Grass<div id="count-grass" class="counter-val">0</div></div>
</div>
</div>
<div class="card">
<div class="controls">
<button data-testid="play">Play</button>
<button data-testid="pause">Pause</button>
<button data-testid="step">Step</button>
<button data-testid="reset">Reset</button>
</div>
<div style="margin-top: 15px;" class="control-group">
<label for="seed">Seed</label>
<input type="number" id="seed" value="42">
</div>
<div style="margin-top: 15px;" class="control-group">
<label for="speed">Speed (ticks/sec)</label>
<input type="range" id="speed" min="1" max="60" value="10">
</div>
<div style="margin-top: 15px;" class="controls" id="params-container">
<!-- Dynamic sliders -->
</div>
</div>
</div>

<div id="panel-side">
<div class="card">
<svg data-testid="chart" viewBox="0 0 400 200" preserveAspectRatio="none">
<polyline data-testid="series-rabbits" points="" />
<polyline data-testid="series-foxes" points="" />
<text x="5" y="190" fill="#aaa" font-size="12">tick</text>
<text x="370" y="20" fill="#aaa" font-size="12">count</text>
</svg>
</div>

<div class="card">
<h3 style="margin:0 0 10px 0; font-size: 1rem;">Lotka–Volterra</h3>
<div class="ode-grid">
<div class="control-group"><label>α</label><input type="number" step="0.1" id="ode-alpha" value="1.1"></div>
<div class="control-group"><label>β</label><input type="number" step="0.1" id="ode-beta" value="0.4"></div>
<div class="control-group"><label>γ</label><input type="number" step="0.1" id="ode-gamma" value="0.4"></div>
<div class="control-group"><label>δ</label><input type="number" step="0.1" id="ode-delta" value="0.1"></div>
<div class="control-group"><label>x0</label><input type="number" id="ode-x0" value="10"></div>
<div class="control-group"><label>y0</label><input type="number" id="ode-y0" value="10"></div>
<div class="control-group"><label>t</label><input type="number" id="ode-t" value="50"></div>
<div class="control-group"><label>dt</label><input type="number" step="0.01" id="ode-dt" value="0.01"></div>
</div>
<button id="ode-run" style="width:100%; margin-top:10px;">Run ODE</button>
<div class="ode-result" id="ode-results">
  <div id="ode-vals"></div>
  <div id="ode-eq"></div>
  <div id="ode-drift"></div>
</div>
<svg data-testid="ode-chart" viewBox="0 0 400 200" preserveAspectRatio="none">
<polyline data-testid="ode-series-x" points="" />
<polyline data-testid="ode-series-y" points="" />
</svg>
</div>

<div class="card">
<h3 style="margin:0 0 10px 0; font-size: 1rem;">Scenario</h3>
<textarea id="scenario-json" placeholder="JSON scenario..."></textarea>
<div style="display:flex; gap:5px; margin-top:5px;">
<button id="scenario-export">Export</button>
<button id="scenario-load">Load</button>
</div>
<div id="scenario-error" class="error"></div>
<button id="csv-export" style="width:100%; margin-top:10px;">Download CSV</button>
</div>

<div class="card">
<h3 style="margin:0 0 10px 0; font-size: 1rem;">Presets</h3>
<div style="display:flex; gap:5px; margin-bottom:10px;">
<input type="text" id="preset-name" placeholder="Name" style="flex:1">
<button id="preset-save">Save</button>
</div>
<div id="preset-list"></div>
</div>
</div>
<div id="announcer" ariaroll="polite" style="position:absolute; left:-9999px;"></div>
</div>

<script>
"use strict";

const DEFAULTS = {
  width: 40, height: 30, grassMax: 4, rabbits0: 100, foxes0: 6,
  rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
  foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
};

const PARAM_CONFIG = [
  { id: 'rabbits0', label: 'Rabbits 0', min: 0, max: 300 },
  { id: 'foxes0', label: 'Foxes 0', min: 0, max: 60 },
  { id: 'rabbitBreed', label: 'Rabbit Breed', min: 2, max: 40 },
  { id: 'foxBreed', label: 'Fox Breed', min: 2, max: 60 },
  { id: 'foxGain', label: 'Fox Gain', min: 1, max: 30 },
  { id: 'grassMax', label: 'Grass Max', min: 1, max: 10 }
];

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

const pick = (list, rand) => list.length > 0 ? list[Math.floor(rand() * list.length)] : null;

class Ecosystem {
  constructor() {
    this.reset(42, {});
  }

  reset(seed, params) {
    this.params = { ...DEFAULTS, ...params };
    this.rand = mulberry32(seed);
    this.seed = seed;
    this.tick = 0;
    this.idCounter = 1;
    this.history = [];
    this.width = this.params.width;
    this.height = this.params.height;
    
    this.grid = Array.from({ length: this.width * this.height }, () => ({
      grass: 0, rabbit: null, fox: null
    }));

    // Grass
    for (let i = 0; i < this.grid.length; i++) {
      this.grid[i].grass = Math.floor(this.rand() * (this.params.grassMax + 1));
    }

    // Rabbits
    for (let i = 0; i < this.params.rabbits0; i++) {
      const empty = [];
      for (let j = 0; j < this.grid.length; j++) if (!this.grid[j].rabbit) empty.push(j);
      const idx = pick(empty, this.rand);
      if (idx !== null) {
        this.grid[idx].rabbit = { id: this.idCounter++, energy: this.params.rabbitStart };
      }
    }

    // Foxes
    for (let i = 0; i < this.params.foxes0; i++) {
      const empty = [];
      for (let j = 0; j < this.grid.length; j++) if (!this.grid[j].fox) empty.push(j);
      const idx = pick(empty, this.rand);
      if (idx !== null) {
        this.grid[idx].fox = { id: this.idCounter++, energy: this.params.foxStart };
      }
    }

    this.recordHistory();
  }

  recordHistory() {
    let gSum = 0;
    let rCount = 0;
      let fCount = 0;
    for (const cell of this.grid) {
      gSum += cell.grass;
      if (cell.rabbit) rCount++;
      if (cell.fox) fCount++;
    }
    this.history.push({ tick: this.tick, rabbits: rCount, foxes: fCount, grass: gSum });
  }

  getNeighbors(idx) {
    const x = idx % this.width;
    const y = Math.floor(idx / this.width);
    const ns = [];
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // up, right, down, left
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
        ns.push(ny * this.width + nx);
      }
    }
    return ns;
  }

  step() {
    // 1. Grass
    for (let i = 0; i < this.grid.length; i++) {
      this.grid[i].grass = Math.min(this.params.grassMax, this.grid[i].grass + 1);
    }

    // 2. Rabbits
    const startRabbits = [];
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i].rabbit) startRabbits.push({ idx: i, ...this.grid[i].rabbit });
    }
    startRabbits.sort((a, b) => a.id - b.id);

    for (const r of startRabbits) {
      // Check if still alive (might have been eaten by fox in same tick? No, foxes act after)
      // But wait, the rules say "Take the rabbits alive at the start of this phase".
      // We must check if the rabbit is still in the grid at its original position.
      if (this.grid[r.idx].rabbit?.id !== r.id) continue;

      // Move
      const ns = this.getNeighbors(r.idx);
      const moveTargets = ns.filter(nIdx => !this.grid[nIdx].rabbit);
      let newIdx = r.idx;
      if (moveTargets.length > 0) {
        const target = pick(moveTargets, this.rand);
        // To move, we must clear old position and set new. 
        // But we must be careful not to overwrite a rabbit that just moved here? 
        // The rule says "move to pick(those)".
        // We'll handle this by updating the grid reference.
        const oldIdx = r.idx;
        const targetIdx = target;
        
        // If target is the same as current, no change.
        // If we move, we need to update the grid.
        // Since we process by ID, we must ensure we don't break the loop.
        // We'll update the local object and the grid.
        this.grid[oldIdx].rabbit = null;
        this.grid[targetIdx].rabbit = { ...r, idx: targetIdx }; 
        // Note: the 'r' object in the loop is a snapshot.
        // We need to update the actual grid.
        newIdx = targetIdx;
      }

      // Eat
      let currentIdx = newIdx;
      // If we moved, the rabbit is now at currentIdx.
      // The loop uses 'r.idx' which is the OLD index.
      // Let's re-sync.
      const activeR = this.grid[currentIdx].rabbit;
      if (!activeR || activeR.id !== r.id) continue;

      activeR.energy += this.params.rabbitGain * this.grid[currentIdx].grass;
      this.grid[currentIdx].grass = 0;

      // Cost
      activeR.energy -= this.params.rabbitCost;

      // Breed
      if (activeR.energy >= this.params.rabbitBreed) {
        const breedNs = this.getNeighbors(currentIdx).filter(n => !this.grid[n].rabbit);
        if (breedNs.length > 0) {
          const spot = pick(breedNs, this.rand);
          const childEnergy = Math.floor(activeR.energy / 2);
          activeR.energy -= childEnergy;
          this.grid[spot].rabbit = { id: this.idCounter++, energy: childEnergy };
        }
      }

      // Die
      if (activeR.energy <= 0) {
        this.grid[currentIdx].rabbit = null;
      } else {
        // Update the rabbit's position in the grid if it moved
        // (Already handled by the move logic)
      }
    }

    // 3. Foxes
    const startFoxes = [];
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i].fox) startFoxes.push({ idx: i, ...this.grid[i].fox });
    }
    startFoxes.sort((a, b) => a.id - b.id);

    for (const f of startFoxes) {
      // Check if fox still exists
      let currentIdx = f.idx;
      // If the fox moved during the rabbit phase? No, rabbits don't move foxes.
      // But the fox might have been eaten? No, rabbits are eaten by foxes.
      // A fox is only removed if it dies.
      if (!this.grid[currentIdx].fox || this.grid[currentIdx].fox.id !== f.id) continue;

      const foxObj = this.grid[currentIdx].fox;

      // Move
      const ns = this.getNeighbors(currentIdx);
      const rabbitNs = ns.filter(n => this.grid[n].rabbit && !this.grid[n].fox);
      const emptyNs = ns.filter(n => !this.grid[n].fox);
      
      let targetIdx = currentIdx;
      if (rabbitNs.length > 0) {
        targetIdx = pick(rabbitNs, this.rand);
      } else if (emptyNs.length > 0) {
        targetIdx = pick(emptyNs, this.rand);
      }

      if (targetIdx !== currentIdx) {
        this.grid[currentIdx].fox = null;
        this.grid[targetIdx].fox = { ...foxObj, idx: targetIdx };
        currentIdx = targetIdx;
      }

      // Eat
      const activeFox = this.grid[currentIdx].fox;
      if (activeFox && this.grid[currentIdx].rabbit) {
        this.grid[currentIdx].rabbit = null;
        activeFox.energy += this.params.foxGain;
      }

      // Cost
      activeFox.energy -= this.params.foxCost;

      // Breed
      if (activeFox.energy >= this.params.foxBreed) {
        const breedNs = this.getNeighbors(currentIdx).filter(n => !this.grid[n].fox);
        if (breedNs.length > 0) {
          const spot = pick(breedNs, this.rand);
          const childEnergy = Math.floor(activeFox.energy / 2);
          activeFox.energy -= childEnergy;
          this.grid[spot].fox = { id: this.idCounter++, energy: childEnergy };
        }
      }

      // Die
      if (activeFox.energy <= 0) {
        this.grid[currentIdx].fox = null;
      }
    }

    this.tick++;
    this.recordHistory();
  }

  counts() {
    let r = 0, f = 0, g = 0;
    for (const cell of this.grid) {
      if (cell.rabbit) r++;
      if (cell.fox) f++;
      g += cell.grass;
    }
    return { rabbits: r, foxes: f, grass: g };
  }

  cell(x, y) {
    const idx = y * this.width + x;
    const cell = this.grid[idx];
    return {
      grass: cell.grass,
      rabbit: cell.rabbit ? { id: cell.rabbit.id, energy: cell.rabbit.energy } : null,
      fox: cell.fox ? { id: cell.fox.id, energy: cell.fox.energy } : null
    };
  }

  history() { return this.history; }

  ode(p, t, dt) {
    const { alpha, beta, gamma, delta, x0, y0 } = p;
    const steps = Math.round(t / dt);
    let x = x0, y = y0;

    const f = (x, y) => ({
      dx: alpha * x - beta * x * y,
      dy: delta * x * y - gamma * y
    });

    for (let i = 0; i < steps; i++) {
      const k1 = f(x, y);
      const k2 = f(x + 0.5 * dt * k1.dx, y + 0.5 * dt * k1.dy);
      const k3 = f(x + 0.5 * dt * k2.dx, y + 0.5 * dt * k2.dy);
      const k4 = f(x + dt * k3.dx, y + dt * k3.dy);

      x += (dt / 6) * (k1.dx + 2 * k2.dx + 2 * k3.dx + k4.dx);
      y += (dt / 6) * (k1.dy + 2 * k2.dy + 2 * k3.dy + k4.dy);
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
      seed: this.seed,
      params: this.params
    });
  }

  loadScenario(text) {
    try {
      const data = JSON.parse(text);
      if (data.version !== 1 || typeof data.seed !== 'number') throw new Error();
      this.reset(data.seed, data.params);
      return true;
    } catch (e) {
      return false;
    }
  }
}

// --- UI & Orchestration ---

const lab = new Ecosystem();
window.lab = lab;

const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const chartSvg = document.querySelector('[data-testid="chart"]');
const odeSvg = document.querySelector('[data-testid="ode-chart"]');

function renderWorld() {
  canvas.width = lab.width * 10;
  canvas.height = lab.height * 10;
  for (let y = 0; y < lab.height; y++) {
    for (let x = 0; x < lab.width; x++) {
      const cell = lab.cell(x, y);
      const idx = y * lab.width + x;
      
      // Grass
      const g = 60 + Math.round(160 * cell.grass / lab.params.grassMax);
      ctx.fillStyle = `rgb(30, ${g}, 30)`;
      ctx.fillRect(x * 10, y * 10, 10, 10);

      // Rabbit
      if (cell.rabbit) {
        ctx.fillStyle = 'rgb(240, 240, 240)';
        ctx.beginPath();
        ctx.arc(x * 10 + 5, y * 10 + 5, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      // Fox
      if (cell.fox) {
        ctx.fillStyle = 'rgb(220, 80, 20)';
        ctx.beginPath();
        ctx.arc(x * 10 + 5, y * 10 + 5, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function updateUI() {
  const counts = lab.counts();
  document.getElementById('tick').textContent = lab.tick;
  document.getElementById('count-rabbits').textContent = counts.rabbits;
  document.getElementById('count-foxes').textContent = counts.foxes;
  document.getElementById('count-grass').textContent = counts.grass;

  // Chart
  const history = lab.history;
  if (history.length > 0) {
    const maxT = history[history.length - 1].tick;
    const maxVal = Math.max(...history.map(h => Math.max(h.rabbits, h.foxes, h.grass / 10 || 1)), 10);
    
    const getPoints = (key) => {
      return history.map((h, i) => {
        const x = (i / (history.length - 1 || 1)) * 400;
        const y = 200 - (h[key] / maxVal) * 180;
        return `${x},${y}`;
      }).join(' ');
    };

    document.querySelector('[data-testid="series-rabbits"]').setAttribute('points', getPoints('rabbits'));
    document.querySelector('[data-testid="series-foxes"]').setAttribute('points', getPoints('foxes'));
  }
}

function updateAnnouncer() {
  const counts = lab.counts();
  document.getElementById('announcer').textContent = `Tick ${lab.tick}: ${counts.rabbits} rabbits, ${counts.foxes} foxes`;
}

// Playback logic
let isPlaying = false;
let lastTickTime = 0;
let speed = 10;

function playLoop(timestamp) {
  if (!isPlaying) return;
  if (timestamp - lastTickTime >= 1000 / speed) {
    lab.step();
    renderWorld();
    updateUI();
    updateAnnouncer();
    lastTickTime = timestamp;
  }
  requestAnimationFrame(playLoop);
}

// Initialization
function init() {
  // Setup sliders
  const container = document.getElementById('params-container');
  PARAM_CONFIG.forEach(cfg => {
    const div = document.createElement('div');
    div.className = 'control-group';
    div.innerHTML = `<label for="param-${cfg.id}">${cfg.label}</label>
                     <input type="range" id="param-${cfg.id}" min="${cfg.min}" max="${cfg.max}" value="${lab.params[cfg.id]}">
                     <span id="val-${cfg.id}">${lab.params[cfg.id]}</span>`;
    container.appendChild(div);
    
    const slider = div.querySelector('input');
    slider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      document.getElementById(`val-${cfg.id}`).textContent = val;
      lab.params[cfg.id] = val;
    });
  });

  // Seed input
  document.getElementById('seed').addEventListener('change', (e) => {
    const s = parseInt(e.target.value);
    lab.reset(s, {});
    renderWorld();
    updateUI();
  });

  // Speed input
  document.getElementById('speed').addEventListener('input', (e) => {
    speed = parseInt(e.target.value);
  });

  // Buttons
  document.getElementById('play').onclick = () => { if(!isPlaying) { isPlaying = true; lastTickTime = performance.now(); requestAnimationFrame(playLoop); } };
  document.getElementById('pause').onclick = () => { isPlaying = false; };
  document.getElementById('step').onclick = () => { lab.step(); renderWorld(); updateUI(); updateAnnouncer(); };
  document.getElementById('reset').onclick = () => {
    const s = parseInt(document.getElementById('seed').value);
    // Merge current slider values into params
    const currentParams = {};
    PARAM_CONFIG.forEach(cfg => {
      currentParams[cfg.id] = parseInt(document.getElementById(`param-${cfg.id}`).value);
    });
    lab.reset(s, currentParams);
    renderWorld();
    updateUI();
  };

  // Scenario
  document.getElementById('scenario-export').onclick = () => {
    document.getElementById('scenario-json').value = lab.exportScenario();
  };
  document.getElementById('scenario-load').onclick = () => {
    const txt = document.getElementById('scenario-json').value;
    const err = document.getElementById('scenario-error');
    const success = lab.loadScenario(txt);
    if (!success) {
      err.textContent = "Invalid scenario JSON or version.";
    } else {
      err.textContent = "";
      // Sync sliders
      PARAM_CONFIG.forEach(cfg => {
        const val = lab.params[cfg.id];
        const el = document.getElementById(`param-${cfg.id}`);
        el.value = val;
        document.getElementById(`val-${cfg.id}`).textContent = val;
      });
      document.getElementById('seed').value = lab.seed;
      renderWorld();
      updateUI();
    }
  };
  document.getElementById('csv-export').onclick = () => {
    const blob = new Blob([lab.exportCSV()], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ecolab.csv';
    a.click();
  };

  // ODE
  document.getElementById('ode-run').onclick = () => {
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
    
    const res = lab.ode(p, p.t, p.dt);
    document.getElementById('ode-vals').innerHTML = `x: ${res.x.toFixed(8)}<br>y: ${res.y.toFixed(8)}`;
    document.getElementById('ode-eq').innerHTML = `eq_x: ${(p.gamma/p.delta).toFixed(4)}<br>eq_y: ${(p.alpha/p.beta).toFixed(4)}`;
    
    // Drift
    const V = (x, y) => p.delta * x - p.gamma * Math.log(x) + p.beta * y - p.alpha * Math.log(y);
    const drift = Math.abs(V(res.x, res.y) - V(p.x0, p.y0));
    document.getElementById('ode-drift').textContent = `drift: ${drift.toFixed(8)}`;

    // ODE Charting
    const ptsX = [], ptsY = [];
    const steps = Math.round(p.t / p.dt);
    let cx = p.x0, cy = p.y0;
    for(let i=0; i<=steps; i++) {
      ptsX.push(`${(i/steps)*400},${200 - (cx/Math.max(cx,cy,1))*180}`);
      ptsY.push(`${(i/steps)*400},${200 - (cy/Math.max(cx,cy,1))*180}`);
      // RK4 step
      const f = (x, y) => ({ dx: p.alpha*x - p.beta*x*y, dy: p.delta*x*y - p.gamma*y });
      const k1 = f(cx, cy);
      const k2 = f(cx + 0.5*p.dt*k1.dx, cy + 0.5*p.dt*k1.dy);
      const k3 = f(cx + 0.5*p.dt*k2.dx, cy + 0.5*p.dt*k2.dy);
      const k4 = f(cx + p.dt*k3.dx, cy + p.dt*k3.dy);
      cx += (p.dt/6)*(k1.dx + 2*k2.dx + 2*k3.dx + k4.dx);
      cy += (p.dt/6)*(k1.dy + 2*k2.dy + 2*k3.dy + k4.dy);
    }
    document.querySelector('[data-testid="ode-series-x"]').setAttribute('points', ptsX.join(' '));
    document.querySelector('[data-testid="ode-series-y"]').setAttribute('points', ptsY.join(' '));
  };

  // Presets
  const loadPresets = () => {
    const container = document.getElementById('preset-list');
    container.innerHTML = '';
    const data = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
    for (const [name, scenario] of Object.entries(data)) {
      const div = document.createElement('div');
      div.className = 'preset-item';
      div.innerHTML = `<span>${name}</span>
        <div>
          <button class="preset-load" data-name="${name}">Load</button>
          <button class="preset-delete" data-name="${name}">×</button>
        </div>`;
      container.appendChild(div);
    }
    
    container.querySelectorAll('.preset-load').forEach(btn => {
      btn.onclick = () => lab.loadScenario(JSON.stringify(data[btn.dataset.name]));
    });
    container.querySelectorAll('.preset-delete').forEach(btn => {
      btn.onclick = () => {
        const name = btn.dataset.name;
        const data = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
        delete data[name];
        localStorage.setItem('ecolab.presets', JSON.stringify(data));
        loadPresets();
      };
    });
  };

  document.getElementById('preset-save').onclick = () => {
    const name = document.getElementById('preset-name').value;
    if (!name) return;
    const data = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
    data[name] = lab.exportScenario();
    localStorage.setItem('ecolab.presets', JSON.stringify(data));
    loadPresets();
  };

  loadPresets();
  renderWorld();
  updateUI();
}

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'BUTTON') return;
  if (e.code === 'Space') {
    e.preventDefault();
    const btnPause = document.getElementById('pause');
    if (isPlaying) btnPause.click(); else document.getElementById('play').click();
  }
  if (e.key === 's') {
    e.preventDefault();
    document.getElementById('step').click();
  }
  if (e.key === 'r') {
    e.preventDefault();
    document.getElementById('reset').click();
  }
});

init();
</script>
</body>
</html>
```