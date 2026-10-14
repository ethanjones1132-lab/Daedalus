## Plan

**Data Model**
- Simulation state: grid (width×height cells, each with grass 0–grassMax), rabbits/foxes arrays (each with id, x, y, energy), shared id counter, seed, RNG generator, current tick, history array.
- Parameters: defaults object + user params merged (13 keys).
- History: array of {tick, rabbits, foxes, grass} (grass = sum of cell grass).
- Lotka–Volterra: separate ODE state with RK4 integration.

**Tick Order**
1. Grass regrows (min(grassMax, grass+1)).
2. Rabbits act (sorted by id): move, eat, breed, die.
3. Foxes act (sorted by id): move, eat, breed, die.
4. Tick increments, history recorded.

**Components**
- Canvas renderer (`panel-world`): grid cells with grass/rabbit/fox colors.
- Controls: play/pause/step/reset buttons, seed/speed inputs, parameter sliders.
- Counters: tick, rabbits, foxes, grass.
- Chart (`panel-side`): SVG polyline series for rabbits/foxes.
- Lotka–Volterra panel: ODE inputs, run button, results, ode-chart SVG.
- Scenario tools: export/load JSON, error display, presets list/save/delete.
- Announcer: live text updates on pause.
- Keyboard shortcuts (body focus): Space toggle, s step, r reset.

---

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ecosystem Lab</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #f0f2f5; color: #333; line-height: 1.5;
    padding: 16px;
  }
  .container {
    max-width: 1400px; margin: 0 auto;
    display: flex; flex-direction: column;
  }
  .panel-world, .panel-side {
    background: #fff; border-radius: 8px; padding: 16px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  }
  .panel-world {
    display: flex; flex-direction: column; gap: 12px;
  }
  .panel-side {
    display: flex; flex-direction: column; gap: 16px;
  }
  @media (min-width: 1000px) {
    .container { flex-direction: row; }
    .panel-world, .panel-side { flex: 1; }
  }
  @media (max-width: 700px) {
    .container { flex-direction: column; }
  }
  canvas { display: block; border: 1px solid #ddd; }
  .controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  button, input[type="number"], input[type="range"] {
    padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px;
    background: #fff; cursor: pointer;
  }
  button { background: #4a90e2; color: #fff; }
  button:hover { background: #357abd; }
  button:disabled { background: #ccc; cursor: not-allowed; }
  .counters { display: flex; gap: 16px; font-weight: bold; }
  .counters label { font-size: 0.85em; color: #666; }
  .chart-container, .ode-panel, .scenario-tools, .presets {
    background: #f9fafc; padding: 12px; border-radius: 6px;
  }
  .chart-container svg { width: 100%; height: 200px; }
  .ode-panel { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .ode-panel label { display: block; font-size: 0.85em; margin-bottom: 4px; }
  .ode-panel input[type="number"] { width: 100%; padding: 4px; }
  .ode-results { grid-column: 1 / -1; margin-top: 8px; font-family: monospace; }
  .scenario-tools textarea { width: 100%; height: 100px; font-family: monospace; }
  .presets { display: flex; flex-direction: column; gap: 8px; }
  .preset-item { display: flex; justify-content: space-between; align-items: center; }
  .preset-item button { padding: 4px 8px; font-size: 0.85em; }
  .announcer { margin-top: 8px; font-style: italic; }
  input[type="range"] { margin-right: 8px; }
  .param-label { display: block; font-size: 0.85em; margin-bottom: 4px; }
  .param-value { font-weight: bold; }
</style>
</head>
<body>
<div class="container">
  <div class="panel-world">
    <canvas data-testid="world" width="400" height="300"></canvas>
    <div class="controls">
      <button data-testid="play">Play</button>
      <button data-testid="pause">Pause</button>
      <button data-testid="step">Step</button>
      <button data-testid="reset">Reset</button>
      <input type="number" data-testid="seed" value="42">
      <input type="range" data-testid="speed" min="1" max="60" value="10">
      <div class="param-label">Rabbits0</div>
      <input type="range" data-testid="param-rabbits0" min="0" max="300" value="100">
      <div class="param-label">Foxes0</div>
      <input type="range" data-testid="param-foxes0" min="0" max="60" value="6">
      <div class="param-label">Rabbit Breed</div>
      <input type="range" data-testid="param-rabbitBreed" min="2" max="40" value="12">
      <div class="param-label">Fox Breed</div>
      <input type="range" data-testid="param-foxBreed" min="2" max="60" value="40">
      <div class="param-label">Fox Gain</div>
      <input type="range" data-testid="param-foxGain" min="1" max="30" value="4">
      <div class="param-label">Grass Max</div>
      <input type="range" data-testid="param-grassMax" min="1" max="10" value="4">
    </div>
    <div class="counters">
      <div><label>Tick</label><span data-testid="tick">0</span></div>
      <div><label>Rabbits</label><span data-testid="count-rabbits">0</span></div>
      <div><label>Foxes</label><span data-testid="count-foxes">0</span></div>
      <div><label>Grass</label><span data-testid="count-grass">0</span></div>
    </div>
    <div class="announcer" data-testid="announcer"></div>
  </div>
  <div class="panel-side">
    <div class="chart-container">
      <svg data-testid="chart"><polyline data-testid="series-rabbits"></polyline><polyline data-testid="series-foxes"></polyline></svg>
    </div>
    <div class="ode-panel">
      <div>
        <label for="ode-alpha">α</label><input type="number" id="ode-alpha" value="1.1">
        <label for="ode-beta">β</label><input type="number" id="ode-beta" value="0.4">
        <label for="ode-gamma">γ</label><input type="number" id="ode-gamma" value="0.4">
        <label for="ode-delta">δ</label><input type="number" id="ode-delta" value="0.1">
      </div>
      <div>
        <label for="ode-x0">x₀</label><input type="number" id="ode-x0" value="10">
        <label for="ode-y0">y₀</label><input type="number" id="ode-y0" value="10">
        <label for="ode-t">t</label><input type="number" id="ode-t" value="50">
        <label for="ode-dt">dt</label><input type="number" id="ode-dt" value="0.01">
      </div>
      <button data-testid="ode-run">Run ODE</button>
      <div class="ode-results">
        ode-x: <span data-testid="ode-x">0</span><br>
        ode-y: <span data-testid="ode-y">0</span><br>
        ode-eq-x: <span data-testid="ode-eq-x">0</span><br>
        ode-eq-y: <span data-testid="ode-eq-y">0</span><br>
        ode-drift: <span data-testid="ode-drift">0</span>
      </div>
      <div><svg data-testid="ode-chart"><polyline data-testid="ode-series-x"></polyline><polyline data-testid="ode-series-y"></polyline></svg></div>
    </div>
    <div class="scenario-tools">
      <button data-testid="scenario-export">Export Scenario</button>
      <textarea data-testid="scenario-json"></textarea>
      <button data-testid="scenario-load">Load Scenario</button>
      <div data-testid="scenario-error"></div>
    </div>
    <div class="presets">
      <input type="text" id="preset-name" placeholder="Preset name">
      <button data-testid="preset-save">Save Preset</button>
      <div id="preset-list"></div>
    </div>
  </div>
</div>

<script>
// ======================
// Data Model & Constants
// ======================
const DEFAULTS = {
  width: 40, height: 30, grassMax: 4, rabbits0: 100, foxes0: 6,
  rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
  foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
};

// ======================
// RNG Generator
// ======================
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

// ======================
// Simulation Core
// ======================
let sim = {
  width: DEFAULTS.width, height: DEFAULTS.height,
  grassMax: DEFAULTS.grassMax,
  rabbits: [], foxes: [], idCounter: 1, tick: 0,
  rand: null, history: [],
  playing: false, speed: 10, lastTime: 0,
  params: {}
};

function reset(seed, params = {}) {
  // Merge params over defaults
  sim.params = { ...DEFAULTS, ...params };
  sim.width = sim.params.width;
  sim.height = sim.params.height;
  sim.grassMax = sim.params.grassMax;
  sim.rabbits0 = sim.params.rabbits0;
  sim.foxes0 = sim.params.foxes0;
  sim.rabbitStart = sim.params.rabbitStart;
  sim.rabbitGain = sim.params.rabbitGain;
  sim.rabbitCost = sim.params.rabbitCost;
  sim.rabbitBreed = sim.params.rabbitBreed;
  sim.foxStart = sim.params.foxes0;
  sim.foxGain = sim.params.foxGain;
  sim.foxCost = sim.params.foxCost;
  sim.foxBreed = sim.params.foxes0;

  sim.rand = mulberry32(seed);
  sim.tick = 0;
  sim.idCounter = 1;
  sim.history = [];
  sim.rabbits = [];
  sim.foxes = [];

  // Initialize grid
  let grid = Array(sim.height).fill().map(() => Array(sim.width).fill(0));

  // Grass
  for (let y = 0; y < sim.height; y++) {
    for (let x = 0; x < sim.width; x++) {
      grid[y][x] = Math.floor(sim.rand() * (sim.grassMax + 1));
    }
  }

  // Rabbits
  for (let i = 0; i < sim.rabbits0; i++) {
    let cells = [];
    for (let y = 0; y < sim.height; y++) {
      for (let x = 0; x < sim.width; x++) {
        if (!sim.rabbits.some(r => r.x === x && r.y === y)) cells.push({x, y});
      }
    }
    if (cells.length === 0) break;
    let {x, y} = cells[Math.floor(sim.rand() * cells.length)];
    sim.rabbits.push({ id: sim.idCounter++, x, y, energy: sim.rabbitStart });
  }

  // Foxes
  for (let i = 0; i < sim.foxes0; i++) {
    let cells = [];
    for (let y = 0; y < sim.height; y++) {
      for (let x = 0; x < sim.width; x++) {
        if (!sim.foxes.some(f => f.x === x && f.y === y)) cells.push({x, y});
      }
    }
    if (cells.length === 0) break;
    let {x, y} = cells[Math.floor(sim.rand() * cells.length)];
    sim.foxes.push({ id: sim.idCounter++, x, y, energy: sim.foxStart });
  }

  // Record tick 0 history
  sim.history.push({ tick: 0, rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: grid.flat().reduce((a,b)=>a+b,0) });
  updateUI();
  updateChart();
  return { rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: grid.flat().reduce((a,b)=>a+b,0) };
}

function step() {
  for (let i = 0; i < 1; i++) {
    // 1. Grass regrows
    for (let y = 0; y < sim.height; y++) {
      for (let x = 0; x < sim.width; x++) {
        grid[y][x] = Math.min(sim.grassMax, grid[y][x] + 1);
      }
    }

    // 2. Rabbits
    let rabbitActions = [...sim.rabbits].sort((a,b) => a.id - b.id);
    let newRabbits = [];
    for (let rabbit of rabbitActions) {
      // Move
      let neighbors = getNeighbors(rabbit.x, rabbit.y);
      let noRabbitNeighbors = neighbors.filter(n => !sim.rabbits.some(r => r.x === n.x && r.y === n.y));
      if (noRabbitNeighbors.length > 0) {
        rabbit.x = noRabbitNeighbors[Math.floor(sim.rand() * noRabbitNeighbors.length)].x;
        rabbit.y = noRabbitNeighbors[Math.floor(sim.rand() * noRabbitNeighbors.length)].y;
      }

      // Eat
      rabbit.energy += sim.rabbitGain * grid[rabbit.y][rabbit.x];
      grid[rabbit.y][rabbit.x] = 0;

      // Energy cost
      rabbit.energy -= sim.rabbitCost;

      // Breed
      if (rabbit.energy >= sim.rabbitBreed) {
        let breedNeighbors = neighbors.filter(n => !sim.rabbits.some(r => r.x === n.x && r.y === n.y));
        if (breedNeighbors.length > 0) {
          let spot = breedNeighbors[Math.floor(sim.rand() * breedNeighbors.length)];
          let child = Math.floor(rabbit.energy / 2);
          rabbit.energy -= child;
          newRabbits.push({ id: sim.idCounter++, x: spot.x, y: spot.y, energy: child });
        }
      }

      // Die
      if (rabbit.energy <= 0) {
        sim.rabbits = sim.rabbits.filter(r => !(r.id === rabbit.id));
      }
    }
    sim.rabbits.push(...newRabbits);

    // 3. Foxes
    let foxActions = [...sim.foxes].sort((a,b) => a.id - b.id);
    let newFoxes = [];
    for (let fox of foxActions) {
      // Move
      let rabbitNeighbors = getNeighbors(fox.x, fox.y).filter(n => 
        sim.rabbits.some(r => r.x === n.x && r.y === n.y) && !sim.foxes.some(f => f.x === n.x && f.y === n.y)
      );
      let fallbackNeighbors = getNeighbors(fox.x, fox.y).filter(n => !sim.foxes.some(f => f.x === n.x && f.y === n.y));
      if (rabbitNeighbors.length > 0) {
        fox.x = rabbitNeighbors[Math.floor(sim.rand() * rabbitNeighbors.length)].x;
        fox.y = rabbitNeighbors[Math.floor(sim.rand() * rabbitNeighbors.length)].y;
      } else if (fallbackNeighbors.length > 0) {
        fox.x = fallbackNeighbors[Math.floor(sim.rand() * fallbackNeighbors.length)].x;
        fox.y = fallbackNeighbors[Math.floor(sim.rand() * fallbackNeighbors.length)].y;
      }

      // Eat
      let rabbitHere = sim.rabbits.find(r => r.x === fox.x && r.y === fox.y);
      if (rabbitHere) {
        sim.rabbits = sim.rabbits.filter(r => !(r.id === rabbitHere.id));
        fox.energy += sim.foxGain;
      }

      // Energy cost
      fox.energy -= sim.foxCost;

      // Breed
      if (fox.energy >= sim.foxBreed) {
        let breedNeighbors = getNeighbors(fox.x, fox.y).filter(n => !sim.foxes.some(f => f.x === n.x && f.y === n.y));
        if (breedNeighbors.length > 0) {
          let spot = breedNeighbors[Math.floor(sim.rand() * breedNeighbors.length)];
          let child = Math.floor(fox.energy / 2);
          fox.energy -= child;
          newFoxes.push({ id: sim.idCounter++, x: spot.x, y: spot.y, energy: child });
        }
      }

      // Die
      if (fox.energy <= 0) {
        sim.foxes = sim.foxes.filter(f => !(f.id === fox.id));
      }
    }
    sim.foxes.push(...newFoxes);

    // 4. Tick increment & history
    sim.tick++;
    sim.history.push({
      tick: sim.tick,
      rabbits: sim.rabbits.length,
      foxes: sim.foxes.length,
      grass: grid.flat().reduce((a,b)=>a+b,0)
    });
  }
  updateUI();
  updateChart();
}

function getNeighbors(x, y) {
  return [
    {x, y: y-1},
    {x: x+1, y},
    {x, y: y+1},
    {x: x-1, y}
  ].filter(n => n.x >= 0 && n.x < sim.width && n.y >= 0 && n.y < sim.height);
}

// ======================
// window.lab API
// ======================
window.lab = {
  reset: reset,
  step: step,
  counts: () => ({
    rabbits: sim.rabbits.length,
    foxes: sim.foxes.length,
    grass: sim.history[sim.history.length-1].grass
  }),
  tick: () => sim.tick,
  cell: (x, y) => {
    let rabbit = sim.rabbits.find(r => r.x === x && r.y === y);
    let fox = sim.foxes.find(f => f.x === x && f.y === y);
    return { grass: grid[y][x], rabbit: rabbit || null, fox: fox || null };
  },
  history: () => [...sim.history],
  ode: (p, t, dt) => {
    let { alpha, beta, gamma, delta, x0, y0 } = p;
    let n = Math.round(t / dt);
    let x = x0, y = y0;
    for (let i = 0; i < n; i++) {
      let k1x = alpha * x - beta * x * y;
      let k1y = delta * x * y - gamma * y;
      let k2x = alpha * (x + dt * k1x) - beta * (x + dt * k1x) * y;
      let k2y = delta * (x + dt * k1x) * y - gamma * (y + dt * k1y);
      let k3x = alpha * (x + dt * k2x) - beta * (x + dt * k2x) * (y + dt * k2y);
      let k3y = delta * (x + dt * k2x) * (y + dt * k2y) - gamma * (y + dt * k2y);
      let k4x = alpha * (x + dt * k3x) - beta * (x + dt * k3x) * (y + dt * k3y);
      let k4y = delta * (x + dt * k3x) * (y + dt * k3y) - gamma * (y + dt * k3y);
      x += dt * (k1x + 2*k2x + 2*k3x + k4x) / 6;
      y += dt * (k1y + 2*k2y + 2*k3y + k4y) / 6;
    }
    return { x, y };
  },
  exportCSV: () => {
    let csv = "tick,rabbits,foxes,grass\n";
    sim.history.forEach(h => {
      csv += `${h.tick},${h.rabbits},${h.foxes},${h.grass}\n`;
    });
    return csv;
  },
  exportScenario: () => {
    return JSON.stringify({ version: 1, seed: 42, params: { ...DEFAULTS, ...sim.params } });
  },
  loadScenario: (text) => {
    let valid = false;
    try {
      let parsed = JSON.parse(text);
      if (parsed.version === 1 && typeof parsed.seed === 'number' && Number.isInteger(parsed.seed)) {
        reset(parsed.seed, parsed.params || {});
        valid = true;
      }
    } catch (e) {}
    document.querySelector('[data-testid="scenario-error"]').textContent = valid ? '' : 'Invalid scenario: version must be 1 and seed must be an integer.';
    return valid;
  }
};

// ======================
// UI & Rendering
// ======================
function updateUI() {
  document.querySelector('[data-testid="tick"]').textContent = sim.tick;
  document.querySelector('[data-testid="count-rabbits"]').textContent = sim.rabbits.length;
  document.querySelector('[data-testid="count-foxes"]').textContent = sim.foxes.length;
  document.querySelector('[data-testid="count-grass"]').textContent = sim.history[sim.history.length-1].grass;
  document.querySelector('[data-testid="announcer]').textContent = `Tick ${sim.tick}: ${sim.rabbits.length} rabbits, ${sim.foxes.length} foxes`;
}

function updateChart() {
  let chart = document.querySelector('[data-testid="chart"]');
  let maxTick = Math.max(...sim.history.map(h => h.tick), 1);
  let maxCount = Math.max(...sim.history.map(h => Math.max(h.rabbits, h.foxes)), 1);
  let width = chart.clientWidth || 400;
  let height = 200;

  let rabbitsPoly = sim.history.map((h, i) => {
    let x = (h.tick / maxTick) * (width - 20) + 10;
    let y = height - (h.rabbits / maxCount) * (height - 40) - 20;
    return `${x},${y}`;
  }).join(' ');
  let foxesPoly = sim.history.map((h, i) => {
    let x = (h.tick / maxTick) * (width - 20) + 10;
    let y = height - (h.foxes / maxCount) * (height - 40) - 20;
    return `${x},${y}`;
  }).join(' ');

  document.querySelector('[data-testid="series-rabbits"]').setAttribute('d', rabbitsPoly);
  document.querySelector('[data-testid="series-foxes"]').setAttribute('d', foxesPoly);
}

function renderCanvas() {
  let canvas = document.querySelector('[data-testid="world"]');
  let ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < sim.height; y++) {
    for (let x = 0; x < sim.width; x++) {
      // Grass
      let grassColor = `rgb(30, ${60 + Math.round(160 * grid[y][x] / sim.grassMax)}, 30)`;
      ctx.fillStyle = grassColor;
      ctx.fillRect(x * 10, y * 10, 10, 10);

      // Rabbit
      let rabbit = sim.rabbits.find(r => r.x === x && r.y === y);
      if (rabbit) {
        ctx.fillStyle = '#242424';
        ctx.fillRect(x * 10 + 2, y * 10 + 2, 6, 6);
      }

      // Fox (over rabbit)
      let fox = sim.foxes.find(f => f.x === x && f.y === y);
      if (fox) {
        ctx.fillStyle = '#d45020';
        ctx.fillRect(x * 10 + 2, y * 10 + 2, 6, 6);
      }
    }
  }
}

// ======================
// Event Listeners & Initialization
// ======================
function setupControls() {
  // Reset button
  document.querySelector('[data-testid="reset"]').addEventListener('click', () => {
    let seed = parseInt(document.querySelector('[data-testid="seed"]').value) || 42;
    let params = {};
    ['param-rabbits0', 'param-foxes0', 'param-rabbitBreed', 'param-foxBreed', 'param-foxGain', 'param-grassMax'].forEach(id => {
      params[id] = parseInt(document.querySelector(`[data-testid="${id}"]`).value) || DEFAULTS[id.replace('param-', '')];
    });
    reset(seed, params);
  });

  // Play/Pause
  let playBtn = document.querySelector('[data-testid="play"]');
  let pauseBtn = document.querySelector('[data-testid="pause"]');
  playBtn.addEventListener('click', () => {
    sim.playing = true;
    sim.lastTime = performance.now();
    playLoop();
  });
  pauseBtn.addEventListener('click', () => {
    sim.playing = false;
    cancelAnimationFrame(sim.rafId);
  });

  // Step
  document.querySelector('[data-testid="step"]').addEventListener('click', step);

  // Speed change while playing
  document.querySelector('[data-testid="speed"]').addEventListener('input', (e) => {
    sim.speed = parseInt(e.target.value);
  });

  // Slider updates (for reset)
  ['param-rabbits0', 'param-foxes0', 'param-rabbitBreed', 'param-foxBreed', 'param-foxGain', 'param-grassMax'].forEach(id => {
    document.querySelector(`[data-testid="${id}"]`).addEventListener('input', (e) => {
      let key = id.replace('param-', '');
      sim.params[key] = parseInt(e.target.value);
    });
  });

  // Scenario tools
  document.querySelector('[data-testid="scenario-export"]').addEventListener('click', () => {
    document.querySelector('[data-testid="scenario-json"]').value = window.lab.exportScenario();
  });
  document.querySelector('[data-testid="scenario-load"]').addEventListener('click', () => {
    window.lab.loadScenario(document.querySelector('[data-testid="scenario-json"]').value);
  });

  // Presets
  document.querySelector('[data-testid="preset-save"]').addEventListener('click', () => {
    let name = document.getElementById('preset-name').value.trim();
    if (!name) return;
    let presets = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
    presets[name] = window.lab.exportScenario();
    localStorage.setItem('ecolab.presets', JSON.stringify(presets));
    renderPresets();
  });

  function renderPresets() {
    let list = document.getElementById('preset-list');
    let presets = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
    list.innerHTML = Object.keys(presets).map(name => `
      <div class="preset-item">
        <span>${name}</span>
        <div>
          <button data-testid="preset-load">Load</button>
          <button data-testid="preset-delete">Delete</button>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('[data-testid="preset-load"]').forEach(btn => {
      btn.addEventListener('click', () => {
        let name = btn.closest('.preset-item').querySelector('span').textContent;
        let scenario = JSON.parse(presets[name]);
        reset(scenario.seed, scenario.params);
      });
    });
    list.querySelectorAll('[data-testid="preset-delete"]').forEach(btn => {
      let item = btn.closest('.preset-item');
      let name = item.querySelector('span').textContent;
      delete presets[name];
      localStorage.setItem('ecolab.presets', JSON.stringify(presets));
      renderPresets();
    });
  }
  renderPresets();

  // ODE
  document.querySelector('[data-testid="ode-run"]').addEventListener('click', () => {
    let p = {
      alpha: parseFloat(document.getElementById('ode-alpha').value),
      beta: parseFloat(document.getElementById('ode-beta').value),
      gamma: parseFloat(document.getElementById('ode-gamma').value),
      delta: parseFloat(document.getElementById('ode-delta').value),
      x0: parseFloat(document.getElementById('ode-x0').value),
      y0: parseFloat(document.getElementById('ode-y0').value),
      t: parseFloat(document.getElementById('ode-t').value),
      dt: parseFloat(document.getElementById('ode-dt').value)
    };
    let result = window.lab.ode(p, p.t, p.dt);
    document.querySelector('[data-testid="ode-x"]').textContent = result.x.toPrecision(8);
    document.querySelector('[data-testid="ode-y"]').textContent = result.y.toPrecision(8);
    document.querySelector('[data-testid="ode-eq-x"]').textContent = (p.gamma / p.delta).toPrecision(8);
    document.querySelector('[data-testid="ode-eq-y"]').textContent = (p.alpha / p.beta).toPrecision(8);
    let V_start = p.delta * p.x0 - p.gamma * Math.log(p.x0) + p.beta * p.y0 - p.alpha * Math.log(p.y0);
    let V_end = p.delta * result.x - p.gamma * Math.log(result.x) + p.beta * result.y - p.alpha * Math.log(result.y);
    document.querySelector('[data-testid="ode-drift"]').textContent = (Math.abs(V_end - V_start)).toPrecision(8);

    // ODE chart
    let odeChart = document.querySelector('[data-testid="ode-chart"]');
    let maxT = p.t;
    let maxX = Math.max(...result.x.split('').map(Number).reduce((a,b)=>a+b,0), 1);
    let maxY = Math.max(...result.y.split('').map(Number).reduce((a,b)=>a+b,0), 1);
    let width = odeChart.clientWidth || 400;
    let height = 200;
    let ox = [];
    let oy = [];
    for (let i = 0; i <= p.t / p.dt; i++) {
      let t = i * p.dt;
      let r = window.lab.ode(p, t, p.dt);
      ox.push((t / maxT) * (width - 20) + 10);
      oy.push(height - (r.x / maxX) * (height - 40) - 20);
    }
    document.querySelector('[data-testid="ode-series-x"]').setAttribute('d', ox.join(' '));
    document.querySelector('[data-testid="ode-series-y"]').setAttribute('d', oy.join(' '));
  });

  // Keyboard shortcuts (body focus)
  document.body.addEventListener('keydown', (e) => {
    if (e.target.tagName !== 'BODY' && !e.target.matches('input, textarea, button')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (sim.playing) pauseBtn.click();
      else playBtn.click();
    } else if (e.code === 'KeyS') {
      e.preventDefault();
      step();
    } else if (e.code === 'KeyR') {
      e.preventDefault();
      document.querySelector('[data-testid="reset"]').click();
    }
  });
}

function playLoop() {
  if (!sim.playing) return;
  let now = performance.now();
  let elapsed = (now - sim.lastTime) / 1000;
  sim.lastTime = now;
  let ticksToRun = Math.floor(elapsed * sim.speed);
  if (ticksToRun > 0) {
    for (let i = 0; i < ticksToRun; i++) step();
  }
  sim.rafId = requestAnimationFrame(playLoop);
}

// ======================
// Initialize
// ======================
reset(42, {});
setupControls();
renderCanvas();
updateChart();
</script>
</body>
</html>
```