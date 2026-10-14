## Plan

**Data Model**
- **World**: A 2D grid of `width × height` cells. Each cell holds an integer `grass` (0–`grassMax`) and at most one `rabbit` and one `fox`. Animals have an `id`, `energy`, and position `(x, y)`.
- **State**: `tick` (integer), `history` (array of `{tick, rabbits, foxes, grass}`), `seed` (integer), `params` (object with all configurable values).
- **Randomness**: A single `mulberry32` generator seeded once at reset. All randomness (grass init, animal placement, movement picks) draws from this stream.
- **IDs**: A shared counter starting at 1, incremented for every animal created (including children).

**Tick Order**
1. **Grass**: `grass = min(grassMax, grass + 1)`.
2. **Rabbits** (sorted by ascending id):
   - Move to a neighbour with no rabbit (pick one).
   - Eat grass: `energy += rabbitGain * grass`, set cell grass to 0.
   - Lose energy: `energy -= rabbitCost`.
   - Breed if `energy >= rabbitBreed`: pick a neighbour with no rabbit, create child with `energy / 2`, parent loses that amount.
   - Die if `energy <= 0`.
3. **Foxes** (sorted by ascending id):
   - Move: prefer neighbours with a rabbit and no fox; if none, neighbours with no fox; else stay.
   - Eat: if cell has a rabbit, remove it, `energy += foxGain`.
   - Lose energy: `energy -= foxCost`.
   - Breed if `energy >= foxBreed`: pick a neighbour with no fox, create child, parent loses `energy / 2`.
   - Die if `energy <= 0`.
4. Increment `tick`, record history point.

**Components**
- **Canvas** (`data-testid="world"`): Renders grass (green gradient), rabbits (white), foxes (purple over rabbits).
- **Controls**: Play/Pause/Step/Reset buttons, Seed input, Speed slider, Parameter sliders (rabbits0, foxes0, rabbitBreed, foxBreed, foxGain, grassMax), Counters (tick, rabbits, foxes, grass).
- **Chart** (`data-testid="chart"`): SVG polyline for rabbits and foxes over ticks.
- **Lotka–Volterra Panel**: Inputs for α, β, γ, δ, x0, y0, t, dt; Run button; displays final x, y, equilibrium values, drift, and an SVG chart.
- **Scenario Tools**: Textarea (`scenario-json`), Export/Load buttons, Error message.
- **Presets**: Save/Load/Delete buttons, list of saved preset items.
- **Announcer**: `aria-live="polite"` element for status updates.
- **Keyboard shortcuts**: Space (toggle play/pause), `s` (step), `r` (reset) when no input/button is focused.

The app is fully self-contained: no external libraries, fonts, or images. All logic runs in vanilla JavaScript with inline CSS.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Ecosystem Lab</title>
<style>
  :root { --bg: #f5f5f0; --panel: #fff; --text: #222; --border: #ccc; --accent: #4a90d9; }
  body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); }
  .app { display: flex; flex-direction: column; height: 100vh; }
  header { padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 1.1rem; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button { padding: 6px 10px; border: 1px solid var(--border); background: #fff; cursor: pointer; border-radius: 4px; font-size: 0.9rem; }
  button:hover { background: #f0f0f0; }
  button:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
  input[type="number"], input[type="text"], textarea { padding: 6px; border: 1px solid var(--border); border-radius: 4px; font-size: 0.9rem; }
  textarea { width: 100%; min-height: 60px; font-family: monospace; }
  .panel-world { flex: 1; display: flex; flex-direction: column; padding: 8px; gap: 8px; overflow: hidden; }
  .canvas-wrap { position: relative; background: #e8e8e0; border: 1px solid var(--border); border-radius: 6px; flex: 1; display: flex; align-items: center; justify-content: center; }
  canvas { display: block; }
  .counters { display: flex; gap: 12px; font-variant-numeric: tabular-nums; }
  .counter { background: var(--panel); padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border); font-size: 0.85rem; }
  .panel-side { flex: 0 0 420px; background: var(--panel); border-left: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .panel-side.bottom { flex-direction: column; }
  .section { padding: 10px; border-bottom: 1px solid var(--border); }
  .section:last-child { border-bottom: none; }
  .section h2 { margin: 0 0 8px; font-size: 1rem; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .row label { font-size: 0.85rem; color: #555; }
  .row input[type="range"] { flex: 1; min-width: 120px; }
  .row input[type="number"] { width: 70px; }
  .row input[type="text"] { flex: 1; min-width: 120px; }
  .row textarea { flex: 1; min-width: 120px; }
  .chart-wrap { height: 180px; border: 1px solid var(--border); border-radius: 6px; background: #fafafa; margin-top: 8px; }
  .chart-wrap svg { width: 100%; height: 100%; }
  .ode-panel { padding: 10px; border-bottom: 1px solid var(--border); }
  .ode-panel h2 { margin: 0 0 8px; font-size: 1rem; }
  .ode-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 6px; }
  .ode-row label { font-size: 0.8rem; }
  .ode-row input[type="number"] { width: 70px; }
  .ode-results { font-size: 0.85rem; margin-top: 6px; }
  .ode-results .eq { color: #666; }
  .ode-chart { height: 120px; border: 1px solid var(--border); border-radius: 6px; margin-top: 8px; background: #fafafa; }
  .ode-chart svg { width: 100%; height: 100%; }
  .scenario-tools { padding: 10px; border-bottom: 1px solid var(--border); }
  .scenario-tools h2 { margin: 0 0 8px; font-size: 1rem; }
  .scenario-tools .row { gap: 6px; }
  .scenario-tools textarea { min-height: 60px; font-family: monospace; font-size: 0.85rem; }
  .presets { padding: 10px; }
  .presets h2 { margin: 0 0 8px; font-size: 1rem; }
  .preset-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .preset-item { background: #f9f9f9; border: 1px solid var(--border); padding: 6px 10px; border-radius: 4px; font-size: 0.85rem; display: flex; align-items: center; gap: 6px; }
  .preset-item button { padding: 2px 6px; font-size: 0.75rem; }
  .preset-item button.delete { color: #d00; }
  .preset-item button:hover { background: #eee; }
  .preset-item button.delete:hover { background: #ffe0e0; }
  .announcer { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
  @media (max-width: 700px) {
    .app { flex-direction: column; }
    .panel-side { border-left: none; border-top: 1px solid var(--border); }
    .panel-world { flex: 0 0 auto; }
    .panel-side { flex: 1; }
  }
</style>
</head>
<body>
<div class="app">
<header>
<h1>Ecosystem Lab</h1>
<div class="controls">
<button data-testid="play">Play</button>
<button data-testid="pause">Pause</button>
<button data-testid="step">Step</button>
<button data-testid="reset">Reset</button>
<input type="number" id="seed" data-testid="seed" value="42">
<span>Seed:</span>
<input type="range" id="speed" data-testid="speed" min="1" max="60" value="10">
<span id="speed-val">10</span>
</div>
</header>
<div class="panel-world">
<div class="canvas-wrap">
<canvas data-testid="world" width="400" height="300"></canvas>
</div>
<div class="counters">
<div class="counter"><span data-testid="tick">Tick</span>: <span data-testid="count-tick">0</span></div>
<div class="counter"><span data-testid="count-rabbits">Rabbits</span>: <span data-testid="count-rabbits">0</span></div>
<div class="counter"><span data-testid="count-foxes">Foxes</span>: <span data-testid="count-foxes">0</span></div>
<div class="counter"><span data-testid="count-grass">Grass</span>: <span data-testid="count-grass">0</span></div>
</div>
</div>
<div class="panel-side">
<div class="section">
<h2>Population Chart</h2>
<div class="chart-wrap">
<svg data-testid="chart" width="300" height="180">
<polyline data-testid="series-rabbits"></polyline>
<polyline data-testid="series-foxes"></polyline>
</svg>
</div>
</div>
<div class="section ode-panel">
<h2>Lotka–Volterra</h2>
<div class="ode-row">
<label for="ode-alpha">α</label><input type="number" id="ode-alpha" data-testid="ode-alpha" value="1.1">
<label for="ode-beta">β</label><input type="number" id="ode-beta" data-testid="ode-beta" value="0.4">
<label for="ode-gamma">γ</label><input type="number" id="ode-gamma" data-testid="ode-gamma" value="0.4">
<label for="ode-delta">δ</label><input type="number" id="ode-delta" data-testid="ode-delta" value="0.1">
</div>
<div class="ode-row">
<label for="ode-x0">x₀</label><input type="number" id="ode-x0" data-testid="ode-x0" value="10">
<label for="ode-y0">y₀</label><input type="number" id="ode-y0" data-testid="ode-y0" value="10">
<label for="ode-t">t</label><input type="number" id="ode-t" data-testid="ode-t" value="50">
<label for="ode-dt">dt</label><input type="number" id="ode-dt" data-testid="ode-dt" value="0.01">
</div>
<div class="row">
<button data-testid="ode-run">Run</button>
</div>
<div class="ode-results">
<span id="ode-x"></span>, <span id="ode-y"></span>
<div class="eq">Eq: x = <span id="ode-eq-x"></span>, y = <span id="ode-eq-y"></span></div>
<div>Drift: <span id="ode-drift"></span></div>
</div>
<div class="ode-chart">
<svg data-testid="ode-chart" width="280" height="120">
<polyline data-testid="ode-series-x"></polyline>
<polyline data-testid="ode-series-y"></polyline>
</svg>
</div>
</div>
<div class="section scenario-tools">
<h2>Scenario</h2>
<div class="row">
<textarea id="scenario-json" data-testid="scenario-json"></textarea>
<button data-testid="scenario-export">Export</button>
<button data-testid="scenario-load">Load</button>
<span id="scenario-error" data-testid="scenario-error"></span>
</div>
</div>
<div class="section presets">
<h2>Presets</h2>
<div class="row">
<input type="text" id="preset-name" placeholder="Preset name">
<button data-testid="preset-save">Save</button>
</div>
<div class="preset-list" id="preset-list"></div>
</div>
</div>
<div class="announcer" id="announcer"></div>
</body>
<script>
(function(){
  // --- constants and defaults ---
  const defaults = {
    width: 40, height: 30, grassMax: 4,
    rabbits0: 100, foxes0: 6,
    rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
    foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
  };
  let params = {...defaults};
  let seed = 42;
  let rand = null;
  let tick = 0;
  let history = [];
  let cells = []; // [x][y] = {grass, rabbit, fox}
  let rabbits = []; // {id, x, y, energy}
  let foxes = []; // {id, x, y, energy}
  let idCounter = 1;
  let playing = false;
  let lastTime = 0;
  let tickAccum = 0;
  let speed = 10;
  let canvas, ctx;
  let announcer;
  let chartSvg, chartPolyRab, chartPolyFox;
  let odeSvg, odePolyX, odePolyY;
  let presetListEl, presetNameEl, presetSaveBtn;
  let scenarioJsonEl, scenarioExportBtn, scenarioLoadBtn, scenarioErrorEl;
  let worldCanvasEl;

  // --- mulberry32 ---
  function mulberry32(s) {
    let a = s | 0;
    return function() {
      a = (a + 0x6D2B79F5) | 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // --- world init ---
  function initWorld() {
    cells = new Array(params.width);
    for (let x = 0; x < params.width; x++) {
      cells[x] = new Array(params.height);
      for (let y = 0; y < params.height; y++) {
        cells[x][y] = { grass: 0, rabbit: null, fox: null };
      }
    }
    rabbits = [];
    foxes = [];
    idCounter = 1;
  }

  // --- reset ---
  function reset() {
    const seedVal = parseInt(document.getElementById('seed').value, 10) || 42;
    seed = seedVal;
    rand = mulberry32(seed);
    tick = 0;
    history = [];
    initWorld();
    // grass
    for (let y = 0; y < params.height; y++) {
      for (let x = 0; x < params.width; x++) {
        cells[x][y].grass = Math.floor(rand() * (params.grassMax + 1));
      }
    }
    // rabbits
    let placed = 0;
    while (placed < params.rabbits0) {
      const free = [];
      for (let y = 0; y < params.height; y++) {
        for (let x = 0; x < params.width; x++) {
          if (!cells[x][y].rabbit) free.push({x, y});
        }
      }
      if (free.length === 0) break;
      const p = free[Math.floor(rand() * free.length)];
      cells[p.x][p.y].rabbit = { id: idCounter++, energy: params.rabbitStart };
      rabbits.push(cells[p.x][p.y].rabbit);
      placed++;
    }
    // foxes
    placed = 0;
    while (placed < params.foxes0) {
      const free = [];
      for (let y = 0; y < params.height; y++) {
        for (let x = 0; x < params.width; x++) {
          if (!cells[x][y].fox) free.push({x, y});
        }
      }
      if (free.length === 0) break;
      const p = free[Math.floor(rand() * free.length)];
      cells[p.x][p.y].fox = { id: idCounter++, energy: params.foxStart };
      foxes.push(cells[p.x][p.y].fox);
      placed++;
    }
    // record history
    history.push({ tick, rabbits: rabbits.length, foxes: foxes.length, grass: sumGrass() });
    drawWorld();
    updateChart();
    updateCounters();
    announcer.textContent = '';
  }

  function sumGrass() {
    let s = 0;
    for (let x = 0; x < params.width; x++) {
      for (let y = 0; y < params.height; y++) s += cells[x][y].grass;
    }
    return s;
  }

  // --- neighbours ---
  function getNeighbours(x, y) {
    const dirs = [{x:0,y:-1},{x:1,y:0},{x:0,y:1},{x:-1,y:0}];
    const res = [];
    for (const d of dirs) {
      const nx = x + d.x, ny = y + d.y;
      if (nx >= 0 && nx < params.width && ny >= 0 && ny < params.height) {
        res.push({x: nx, y: ny});
      }
    }
    return res;
  }

  // --- tick ---
  function doTick() {
    // grass
    for (let x = 0; x < params.width; x++) {
      for (let y = 0; y < params.height; y++) {
        cells[x][y].grass = Math.min(params.grassMax, cells[x][y].grass + 1);
      }
    }
    // rabbits
    const rabbitList = [...rabbits].sort((a,b) => a.id - b.id);
    for (const r of rabbitList) {
      // move
      const free = getNeighbours(r.x, r.y).filter(p => !cells[p.x][p.y].rabbit);
      if (free.length) {
        const p = free[Math.floor(rand() * free.length)];
        r.x = p.x; r.y = p.y;
        cells[p.x][p.y].rabbit = r;
      }
      // eat
      const g = cells[r.x][r.y].grass;
      r.energy += params.rabbitGain * g;
      cells[r.x][r.y].grass = 0;
      // cost
      r.energy -= params.rabbitCost;
      // breed
      if (r.energy >= params.rabbitBreed) {
        const free = getNeighbours(r.x, r.y).filter(p => !cells[p.x][p.y].rabbit);
        if (free.length) {
          const p = free[Math.floor(rand() * free.length)];
          const child = Math.floor(r.energy / 2);
          r.energy -= child;
          cells[p.x][p.y].rabbit = { id: idCounter++, energy: child };
          rabbits.push(cells[p.x][p.y].rabbit);
        }
      }
      // die
      if (r.energy <= 0) {
        cells[r.x][r.y].rabbit = null;
        rabbits = rabbits.filter(x => x !== r);
      }
    }
    // foxes
    const foxList = [...foxes].sort((a,b) => a.id - b.id);
    for (const f of foxList) {
      // move
      const withRabbit = getNeighbours(f.x, f.y).filter(p => cells[p.x][p.y].rabbit && !cells[p.x][p.y].fox);
      if (withRabbit.length) {
        const p = withRabbit[Math.floor(rand() * withRabbit.length)];
        f.x = p.x; f.y = p.y;
        cells[p.x][p.y].fox = f;
      } else {
        const free = getNeighbours(f.x, f.y).filter(p => !cells[p.x][p.y].fox);
        if (free.length) {
          const p = free[Math.floor(rand() * free.length)];
          f.x = p.x; f.y = p.y;
          cells[p.x][p.y].fox = f;
        }
      }
      // eat
      if (cells[f.x][f.y].rabbit) {
        const r = cells[f.x][f.y].rabbit;
        cells[f.x][f.y].rabbit = null;
        rabbits = rabbits.filter(x => x !== r);
        f.energy += params.foxGain;
      }
      // cost
      f.energy -= params.foxCost;
      // breed
      if (f.energy >= params.foxBreed) {
        const free = getNeighbours(f.x, f.y).filter(p => !cells[p.x][p.y].fox);
        if (free.length) {
          const p = free[Math.floor(rand() * free.length)];
          const child = Math.floor(f.energy / 2);
          f.energy -= child;
          cells[p.x][p.y].fox = { id: idCounter++, energy: child };
          foxes.push(cells[p.x][p.y].fox);
        }
      }
      // die
      if (f.energy <= 0) {
        cells[f.x][f.y].fox = null;
        foxes = foxes.filter(x => x !== f);
      }
    }
    tick++;
    history.push({ tick, rabbits: rabbits.length, foxes: foxes.length, grass: sumGrass() });
    drawWorld();
    updateChart();
    updateCounters();
  }

  // --- API ---
  window.lab = {
    reset,
    step(n=1) {
      for (let i=0; i<n; i++) doTick();
      return counts();
    },
    counts() {
      return { rabbits: rabbits.length, foxes: foxes.length, grass: sumGrass() };
    },
    tick() { return tick; },
    cell(x,y) {
      const c = cells[x][y];
      return { grass: c.grass, rabbit: c.rabbit || null, fox: c.fox || null };
    },
    history() { return history; },
    ode(p, t, dt) {
      const {alpha, beta, gamma, delta, x0, y0} = p;
      const n = Math.round(t / dt);
      let x = x0, y = y0;
      for (let i=0; i<n; i++) {
        const k1x = alpha*x - beta*x*y;
        const k1y = delta*x*y - gamma*y;
        const x2 = x + 0.5*dt*k1x, y2 = y + 0.5*dt*k1y;
        const k2x = alpha*x2 - beta*x2*y2;
        const k2y = delta*x2*y2 - gamma*y2;
        const x3 = x + 0.5*dt*k2x, y3 = y + 0.5*dt*k2y;
        const k3x = alpha*x3 - beta*x3*y3;
        const k3y = delta*x3*y3 - gamma*y3;
        const x4 = x + dt*k3x, y4 = y + dt*k3y;
        const k4x = alpha*x4 - beta*x4*y4;
        const k4y = delta*x4*y4 - gamma*y4;
        x = x + dt*(k1x + 2*k2x + 2*k3x + k4x)/6;
        y = y + dt*(k1y + 2*k2y + 2*k3y + k4y)/6;
      }
      return {x, y};
    },
    exportCSV() {
      let out = 'tick,rabbits,foxes,grass\n';
      for (const h of history) out += `${h.tick},${h.rabbits},${h.foxes},${h.grass}\n`;
      return out;
    },
    exportScenario() {
      return JSON.stringify({ version: 1, seed, params });
    },
    loadScenario(text) {
      try {
        const obj = JSON.parse(text);
        if (obj.version !== 1) throw new Error('bad version');
        if (!Number.isInteger(obj.seed)) throw new Error('bad seed');
        const p = {...defaults};
        for (const k of Object.keys(obj.params)) if (obj.params.hasOwnProperty(k)) p[k] = obj.params[k];
        seed = obj.seed;
        params = p;
        reset();
        return true;
      } catch {
        document.getElementById('scenario-error').textContent = 'Invalid scenario';
        return false;
      }
    }
  };

  // --- rendering ---
  function drawWorld() {
    const w = params.width * 10, h = params.height * 10;
    worldCanvasEl.width = w; worldCanvasEl.height = h;
    ctx = worldCanvasEl.getContext('2d');
    ctx.clearRect(0,0,w,h);
    // grass
    for (let y=0; y<params.height; y++) {
      for (let x=0; x<params.width; x++) {
        const g = cells[x][y].grass;
        const G = 60 + Math.round(160 * g / params.grassMax);
        ctx.fillStyle = `rgb(30,${G},30)`;
        ctx.fillRect(x*10, y*10, 10, 10);
      }
    }
    // rabbits
    for (const r of rabbits) {
      ctx.fillStyle = 'rgb(240,240,240)';
      ctx.fillRect(r.x*10+2, r.y*10+2, 6, 6);
    }
    // foxes
    for (const f of foxes) {
      ctx.fillStyle = 'rgb(220,80,20)';
      ctx.fillRect(f.x*10+2, f.y*10+2, 6, 6);
    }
  }

  function updateChart() {
    const svg = chartSvg;
    const w = svg.clientWidth, h = svg.clientHeight;
    const maxCount = Math.max(...history.map(h => Math.max(h.rabbits, h.foxes)), 1);
    const pad = 10;
    const scaleX = (t) => pad + (t / (history.length - 1 || 1)) * (w - 2*pad);
    const scaleY = (c) => h - pad - (c / maxCount) * (h - 2*pad);
    const ptsR = history.map(h => `${scaleX(h.tick)},${scaleY(h.rabbits)}`).join(' ');
    const ptsF = history.map(h => `${scaleX(h.tick)},${scaleY(h.foxes)}`).join(' ');
    chartPolyRab.setAttribute('points', ptsR);
    chartPolyFox.setAttribute('points', ptsF);
    // axis labels
    const textX = `<text x="${w-12}" y="${h-4}" text-anchor="end" font-size="10">tick</text>`;
    const textY = `<text x="${12}" y="${12}" text-anchor="start" font-size="10">count</text>`;
    svg.innerHTML = `<polyline data-testid="series-rabbits" points="${ptsR}"/><polyline data-testid="series-foxes" points="${ptsF}"/><text x="${w-12}" y="${h-4}" text-anchor="end" font-size="10">tick</text><text x="${12}" y="${12}" text-anchor="start" font-size="10">count</text>`;
  }

  function updateCounters() {
    const c = window.lab.counts();
    document.getElementById('count-tick').textContent = tick;
    document.getElementById('count-rabbits').textContent = c.rabbits;
    document.getElementById('count-foxes').textContent = c.foxes;
    document.getElementById('count-grass').textContent = c.grass;
  }

  // --- UI wiring ---
  const playBtn = document.getElementById('play');
  const pauseBtn = document.getElementById('pause');
  const stepBtn = document.getElementById('step');
  const resetBtn = document.getElementById('reset');
  const speedSlider = document.getElementById('speed');
  const speedVal = document.getElementById('speed-val');
  const seedInput = document.getElementById('seed');

  playBtn.addEventListener('click', () => {
    if (!playing) {
      playing = true;
      lastTime = performance.now();
      tickAccum = 0;
      requestAnimationFrame(loop);
    }
  });
  pauseBtn.addEventListener('click', () => {
    playing = false;
    announcer.textContent = '';
  });
  stepBtn.addEventListener('click', () => {
    if (playing) {
      playing = false;
      announcer.textContent = '';
    }
    doTick();
    updateCounters();
  });
  resetBtn.addEventListener('click', reset);
  speedSlider.addEventListener('input', () => {
    speed = parseInt(speedSlider.value, 10);
    speedVal.textContent = speed;
  });
  seedInput.addEventListener('change', reset);

  // --- loop ---
  function loop(now) {
    if (!playing) return;
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    tickAccum += dt * speed;
    while (tickAccum >= 1) {
      doTick();
      tickAccum -= 1;
      updateCounters();
    }
    announcer.textContent = `Tick ${tick}: ${rabbits.length} rabbits, ${foxes.length} foxes`;
    requestAnimationFrame(loop);
  }

  // --- Lotka–Volterra ---
  const odeAlpha = document.getElementById('ode-alpha');
  const odeBeta = document.getElementById('ode-beta');
  const odeGamma = document.getElementById('ode-gamma');
  const odeDelta = document.getElementById('ode-delta');
  const odeX0 = document.getElementById('ode-x0');
  const odeY0 = document.getElementById('ode-y0');
  const odeT = document.getElementById('ode-t');
  const odeDt = document.getElementById('ode-dt');
  const odeRunBtn = document.getElementById('ode-run');
  const odeXOut = document.getElementById('ode-x');
  const odeYOut = document.getElementById('ode-y');
  const odeEqX = document.getElementById('ode-eq-x');
  const odeEqY = document.getElementById('ode-eq-y');
  const odeDrift = document.getElementById('ode-drift');
  const odeSvg = document.querySelector('#ode-chart svg');
  const odePolyX = document.querySelector('#ode-chart polyline[data-testid="ode-series-x"]');
  const odePolyY = document.querySelector('#ode-chart polyline[data-testid="ode-series-y"]');

  odeRunBtn.addEventListener('click', () => {
    const p = {
      alpha: parseFloat(odeAlpha.value), beta: parseFloat(odeBeta.value),
      gamma: parseFloat(odeGamma.value), delta: parseFloat(odeDelta.value),
      x0: parseFloat(odeX0.value), y0: parseFloat(odeY0.value),
      t: parseFloat(odeT.value), dt: parseFloat(odeDt.value)
    };
    const res = window.lab.ode(p, p.t, p.dt);
    odeXOut.textContent = res.x.toFixed(8);
    odeYOut.textContent = res.y.toFixed(8);
    odeEqX.textContent = (p.gamma / p.delta).toFixed(8);
    odeEqY.textContent = (p.alpha / p.beta).toFixed(8);
    // drift
    const V = (x,y) => p.delta*x - p.gamma*Math.log(x) + p.beta*y - p.alpha*Math.log(y);
    const startV = V(p.x0, p.y0);
    const endV = V(res.x, res.y);
    odeDrift.textContent = (Math.abs(endV - startV)).toFixed(8);
    // chart
    const w = odeSvg.clientWidth, h = odeSvg.clientHeight;
    const pad = 10;
    const maxT = p.t;
    const maxV = Math.max(startV, endV, 1);
    const scaleX = (t) => pad + (t / maxT) * (w - 2*pad);
    const scaleY = (v) => h - pad - (v / maxV) * (h - 2*pad);
    const ptsX = p.dt ? Array.from({length: Math.ceil(p.t/p.dt)}, (_,i)=>{
      const t = i * p.dt;
      let x = p.x0, y = p.y0;
      for (let j=0; j<i; j++) {
        const k1x = p.alpha*x - p.beta*x*y;
        const k1y = p.delta*x*y - p.gamma*y;
        const x2 = x + 0.5*p.dt*k1x, y2 = y + 0.5*p.dt*k1y;
        const k2x = p.alpha*x2 - p.beta*x2*y2;
        const k2y = p.delta*x2*y2 - p.gamma*y2;
        const x3 = x + 0.5*p.dt*k2x, y3 = y + 0.5*p.dt*k2y;
        const k3x = p.alpha*x3 - p.beta*x3*y3;
        const k3y = p.delta*x3*y3 - p.gamma*y3;
        const x4 = x + p.dt*k3x, y4 = y + p.dt*k3y;
        const k4x = p.alpha*x4 - p.beta*x4*y4;
        const k4y = p.delta*x4*y4 - p.gamma*y4;
        x = x + p.dt*(k1x + 2*k2x + 2*k3x + k4x)/6;
        y = y + p.dt*(k1y + 2*k2y + 2*k3y + k4y)/6;
      }
      return `${scaleX(t)},${scaleY(V(x,y))}`;
    }).join(' ') : '';
    const ptsY = p.dt ? Array.from({length: Math.ceil(p.t/p.dt)}, (_,i)=>{
      const t = i * p.dt;
      let x = p.x0, y = p.y0;
      for (let j=0; j<i; j++) {
        const k1x = p.alpha*x - p.beta*x*y;
        const k1y = p.delta*x*y - p.gamma*y;
        const x2 = x + 0.5*p.dt*k1x, y2 = y + 0.5*p.dt*k1y;
        const k2x = p.alpha*x2 - p.beta*x2*y2;
        const k2y = p.delta*x2*y2 - p.gamma*y2;
        const x3 = x + 0.5*p.dt*k2x, y3 = y + 0.5*p.dt*k2y;
        const k3x = p.alpha*x3 - p.beta*x3*y3;
        const k3y = p.delta*x3*y3 - p.gamma*y3;
        const x4 = x + p.dt*k3x, y4 = y + p.dt*k3y;
        const k4x = p.alpha*x4 - p.beta*x4*y4;
        const k4y = p.delta*x4*y4 - p.gamma*y4;
        x = x + p.dt*(k1x + 2*k2x + 2*k3x + k4x)/6;
        y = y + p.dt*(k1y + 2*k2y + 2*k3y + k4y)/6;
      }
      return `${scaleX(t)},${scaleY(V(x,y))}`;
    }).join(' ') : '';
    odePolyX.setAttribute('points', ptsX);
    odePolyY.setAttribute('points', ptsY);
  });

  // --- Scenario ---
  const scenarioExportBtn = document.getElementById('scenario-export');
  scenarioExportBtn.addEventListener('click', () => {
    scenarioJsonEl.value = window.lab.exportScenario();
  });
  const scenarioLoadBtn = document.getElementById('scenario-load');
  scenarioLoadBtn.addEventListener('click', () => {
    const ok = window.lab.loadScenario(scenarioJsonEl.value);
    if (!ok) scenarioErrorEl.textContent = 'Invalid scenario';
    else scenarioErrorEl.textContent = '';
  });

  // --- Presets ---
  const presetNameEl = document.getElementById('preset-name');
  const presetSaveBtn = document.getElementById('preset-save');
  presetSaveBtn.addEventListener('click', () => {
    const name = presetNameEl.value.trim();
    if (!name) return;
    const store = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
    store[name] = window.lab.exportScenario();
    localStorage.setItem('ecolab.presets', JSON.stringify(store));
    presetNameEl.value = '';
    renderPresets();
  });
  function renderPresets() {
    const store = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
    presetListEl.innerHTML = '';
    for (const [name, data] of Object.entries(store)) {
      const item = document.createElement('div');
      item.className = 'preset-item';
      item.innerHTML = `
        <span>${name}</span>
        <button data-testid="preset-load">Load</button>
        <button data-testid="preset-delete" class="delete">Delete</button>
      `;
      item.querySelector('[data-testid="preset-load"]').addEventListener('click', () => {
        window.lab.loadScenario(data);
        renderPresets();
      });
      item.querySelector('[data-testid="preset-delete"]').addEventListener('click', () => {
        delete store[name];
        localStorage.setItem('ecolab.presets', JSON.stringify(store));
        renderPresets();
      });
      presetListEl.appendChild(item);
    }
  }

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', (e) => {
    const focusable = document.activeElement;
    const isInput = focusable && (focusable.tagName === 'INPUT' || focusable.tagName === 'TEXTAREA' || focusable.tagName === 'SELECT');
    const isButton = focusable && focusable.tagName === 'BUTTON';
    if (isInput || isButton) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (playing) { pauseBtn.click(); } else { playBtn.click(); }
    } else if (e.key === 's') {
      e.preventDefault();
      stepBtn.click();
    } else if (e.key === 'r') {
      e.preventDefault();
      resetBtn.click();
    }
  });

  // --- init ---
  worldCanvasEl = document.querySelector('[data-testid="world"]');
  chartSvg = document.querySelector('[data-testid="chart"]');
  chartPolyRab = document.querySelector('[data-testid="series-rabbits"]');
  chartPolyFox = document.querySelector('[data-testid="series-foxes"]');
  odeSvg = document.querySelector('#ode-chart svg');
  odePolyX = document.querySelector('#ode-chart polyline[data-testid="ode-series-x"]');
  odePolyY = document.querySelector('#ode-chart polyline[data-testid="ode-series-y"]');
  announcer = document.getElementById('announcer');
  presetListEl = document.getElementById('preset-list');
  presetNameEl = document.getElementById('preset-name');
  presetSaveBtn = document.getElementById('preset-save');
  scenarioJsonEl = document.getElementById('scenario-json');
  scenarioExportBtn = document.getElementById('scenario-export');
  scenarioLoadBtn = document.getElementById('scenario-load');
  scenarioErrorEl = document.getElementById('scenario-error');

  reset();
  renderPresets();
})();
</script>
</body>
</html>
```