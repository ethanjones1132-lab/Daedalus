## Plan

**Data model.** A `world` object holds `grid` (a `width × height` array of `{grass, rabbit, fox}`), `rabbits` and `foxes` (arrays of `{id, energy, x, y}`), `tick`, `history`, `seed`, `params`, and `rand`. Ids come from one shared counter.

**Tick order.** Grass regrows; rabbits act in ascending-id order (move, eat, cost, breed, die); foxes act in ascending-id order (move, eat, cost, breed, die); then the history point is recorded.

**Components.** Canvas world, play/pause/step/reset buttons, seed/speed/parameter sliders, counters, SVG population chart, Lotka–Volterra panel, CSV/scenario tools, presets, announcer, and keyboard shortcuts.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ecosystem Lab</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: system-ui, sans-serif;
    color: #222;
    background: #f4f6f8;
    line-height: 1.4;
  }
  .app {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 16px;
    max-width: 1200px;
    margin: 0 auto;
  }
  .panel {
    background: #fff;
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 14px;
  }
  .panel-world { flex: 1 1 640px; min-width: 0; }
  .panel-side { flex: 1 1 320px; min-width: 0; }
  @media (max-width: 700px) {
    .panel-side { flex-basis: 100%; }
  }
  .panel-title { font-weight: 600; margin: 0 0 8px; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .controls button {
    padding: 6px 12px;
    border: 1px solid #888;
    background: #fff;
    border-radius: 4px;
    cursor: pointer;
  }
  .controls button:focus, .controls button:hover { outline: 2px solid #333; }
  .counters { display: flex; gap: 16px; margin-top: 10px; }
  .counters span { font-weight: 600; }
  canvas {
    display: block;
    width: 100%;
    height: auto;
    border: 1px solid #ccc;
    image-rendering: pixelated;
  }
  .params { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin-top: 12px; }
  .params label { display: flex; flex-direction: column; gap: 4px; }
  .params input[type=range] { width: 100%; }
  .params .value { font-size: 12px; color: #666; }
  .chart { width: 100%; height: 220px; border: 1px solid #ccc; }
  .ode { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ode input { width: 100%; }
  .ode-chart { width: 100%; height: 200px; border: 1px solid #ccc; }
  .scenario { display: flex; flex-direction: column; gap: 8px; }
  .scenario textarea { width: 100%; height: 120px; }
  .presets { display: flex; flex-direction: column; gap: 8px; }
  .preset-item { display: flex; align-items: center; gap: 8px; }
  .preset-item button { padding: 4px 8px; }
</style>
</head>
<body>
<div class="app">
  <section class="panel panel-world">
    <h2 class="panel-title">World</h2>
    <div class="controls">
      <button data-testid="play">Play</button>
      <button data-testid="pause">Pause</button>
      <button data-testid="step">Step</button>
      <button data-testid="reset">Reset</button>
      <input type="number" data-testid="seed" value="42">
      <input type="range" data-testid="speed" min="1" max="60" value="10">
    </div>
    <canvas data-testid="world" width="400" height="300"></canvas>
    <div class="counters">
      <span data-testid="tick">0</span>
      <span data-testid="count-rabbits">0</span>
      <span data-testid="count-foxes">0</span>
      <span data-testid="count-grass">0</span>
    </div>
    <div class="params">
      <label data-testid="param-rabbits0">
        <span>rabbits0</span>
        <input type="range" min="0" max="300" value="100">
      </label>
      <label data-testid="param-foxes0">
        <span>foxes0</span>
        <input type="range" min="0" max="60" value="6">
      </label>
      <label data-testid="param-rabbitBreed">
        <span>rabbitBreed</span>
        <input type="range" min="2" max="40" value="12">
      </label>
      <label data-testid="param-foxBreed">
        <span>foxBreed</span>
        <input type="range" min="2" max="60" value="40">
      </label>
      <label data-testid="param-foxGain">
        <span>foxGain</span>
        <input type="range" min="1" max="30" value="4">
      </label>
      <label data-testid="param-grassMax">
        <span>grassMax</span>
        <input type="range" min="1" max="10" value="4">
      </label>
    </div>
  </section>
  <section class="panel panel-side">
    <h2 class="panel-title">Population</h2>
    <svg data-testid="chart" viewBox="0 0 300 220"></svg>
    <h2 class="panel-title">Lotka–Volterra</h2>
    <div class="ode">
      <label>α <input data-testid="ode-alpha" value="1.1"></label>
      <label>β <input data-testid="ode-beta" value="0.4"></label>
      <label>γ <input data-testid="ode-gamma" value="0.4"></label>
      <label>δ <input data-testid="ode-delta" value="0.1"></label>
      <label>x0 <input data-testid="ode-x0" value="10"></label>
      <label>y0 <input data-testid="ode-y0" value="10"></label>
      <label>t <input data-testid="ode-t" value="50"></label>
      <label>dt <input data-testid="ode-dt" value="0.01"></label>
    </div>
    <button data-testid="ode-run">Run</button>
    <div data-testid="ode-x">0</div>
    <div data-testid="ode-y">0</div>
    <div data-testid="ode-eq-x">0</div>
    <div data-testid="ode-eq-y">0</div>
    <div data-testid="ode-drift">0</div>
    <svg data-testid="ode-chart" viewBox="0 0 300 200"></svg>
    <h2 class="panel-title">Scenario</h2>
    <div class="scenario">
      <textarea data-testid="scenario-json"></textarea>
      <button data-testid="scenario-export">Export</button>
      <button data-testid="scenario-load">Load</button>
      <div data-testid="scenario-error"></div>
    </div>
    <h2 class="panel-title">Presets</h2>
    <div class="presets">
      <input data-testid="preset-name" placeholder="Preset name">
      <button data-testid="preset-save">Save</button>
      <div data-testid="preset-list"></div>
    </div>
  </section>
</div>
<div data-testid="announcer" aria-live="polite"></div>
<script>
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

  const defaults = {
    width: 40, height: 30, grassMax: 4, rabbits0: 100, foxes0: 6,
    rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
    foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
  };

  const world = {
    grid: [], rabbits: [], foxes: [], tick: 0, history: [],
    idCounter: 1, rand: null, seed: 0, params: {}
  };

  function pick(list) {
    if (!list.length) return null;
    return list[Math.floor(world.rand() * list.length)];
  }

  function neighbours(x, y) {
    const out = [];
    if (y > 0) out.push([x, y - 1]);
    if (x < world.params.width - 1) out.push([x + 1, y]);
    if (y < world.params.height - 1) out.push([x, y + 1]);
    if (x > 0) out.push([x - 1, y]);
    return out;
  }

  function reset(seed, params = {}) {
    world.params = Object.assign({}, defaults, params);
    world.seed = seed;
    world.rand = mulberry32(seed);
    world.tick = 0;
    world.idCounter = 1;
    world.history = [];
    world.grid = [];
    for (let y = 0; y < world.params.height; y++) {
      for (let x = 0; x < world.params.width; x++) {
        world.grid.push({ grass: 0, rabbit: null, fox: null });
      }
    }
    for (let y = 0; y < world.params.height; y++) {
      for (let x = 0; x < world.params.width; x++) {
        world.grid[y * world.params.width + x].grass = Math.floor(world.rand() * (world.params.grassMax + 1));
      }
    }
    for (let i = 0; i < world.params.rabbits0; i++) {
      const list = [];
      for (let y = 0; y < world.params.height; y++) {
        for (let x = 0; x < world.params.width; x++) {
          if (!world.grid[y * world.params.width + x].rabbit) list.push([x, y]);
        }
      }
      const [x, y] = pick(list);
      world.grid[y * world.params.width + x].rabbit = { id: world.idCounter++, energy: world.params.rabbitStart };
    }
    for (let i = 0; i < world.params.foxes0; i++) {
      const list = [];
      for (let y = 0; y < world.params.height; y++) {
        for (let x = 0; x < world.params.width; x++) {
          if (!world.grid[y * world.params.width + x].fox) list.push([x, y]);
        }
      }
      const [x, y] = pick(list);
      world.grid[y * world.params.width + x].fox = { id: world.idCounter++, energy: world.params.foxStart };
    }
    recordHistory();
    redraw();
  }

  function recordHistory() {
    const rabbits = world.rabbits.length;
    const foxes = world.foxes.length;
    let grass = 0;
    for (let y = 0; y < world.params.height; y++) {
      for (let x = 0; x < world.params.width; x++) {
        grass += world.grid[y * world.params.width + x].grass;
      }
    }
    world.history.push({ tick: world.tick, rabbits, foxes, grass });
  }

  function step(n = 1) {
    for (let i = 0; i < n; i++) {
      tickOnce();
    }
    redraw();
    updateCounters();
  }

  function tickOnce() {
    for (let y = 0; y < world.params.height; y++) {
      for (let x = 0; x < world.params.width; x++) {
        const cell = world.grid[y * world.params.width + x];
        cell.grass = Math.min(world.params.grassMax, cell.grass + 1);
      }
    }
    const rabbits = world.rabbits.slice().sort((a, b) => a.id - b.id);
    for (const r of rabbits) {
      const [x, y] = [r.x, r.y];
      const free = neighbours(x, y).filter(([nx, ny]) => !world.grid[ny * world.params.width + nx].rabbit);
      if (free.length) {
        const [nx, ny] = pick(free);
        r.x = nx; r.y = ny;
      }
      r.energy += world.params.rabbitGain * world.grid[r.y * world.params.width + r.x].grass;
      world.grid[r.y * world.params.width + r.x].grass = 0;
      r.energy -= world.params.rabbitCost;
      if (r.energy >= world.params.rabbitBreed) {
        const free2 = neighbours(r.x, r.y).filter(([nx, ny]) => !world.grid[ny * world.params.width + nx].rabbit);
        if (free2.length) {
          const [nx, ny] = pick(free2);
          const child = Math.floor(r.energy / 2);
          r.energy -= child;
          world.grid[ny * world.params.width + nx].rabbit = { id: world.idCounter++, energy: child };
        }
      }
      if (r.energy <= 0) {
        world.grid[r.y * world.params.width + r.x].rabbit = null;
        world.rabbits = world.rabbits.filter(a => a !== r);
      }
    }
    const foxes = world.foxes.slice().sort((a, b) => a.id - b.id);
    for (const f of foxes) {
      const [x, y] = [f.x, f.y];
      const prey = neighbours(x, y).filter(([nx, ny]) => world.grid[ny * world.params.width + nx].rabbit && !world.grid[ny * world.params.width + nx].fox);
      if (prey.length) {
        const [nx, ny] = pick(prey);
        f.x = nx; f.y = ny;
      } else {
        const free = neighbours(x, y).filter(([nx, ny]) => !world.grid[ny * world.params.width + nx].fox);
        if (free.length) {
          const [nx, ny] = pick(free);
          f.x = nx; f.y = ny;
        }
      }
      if (world.grid[f.y * world.params.width + f.x].rabbit) {
        world.grid[f.y * world.params.width + f.x].rabbit = null;
        f.energy += world.params.foxGain;
      }
      f.energy -= world.params.foxCost;
      if (f.energy >= world.params.foxBreed) {
        const free2 = neighbours(f.x, f.y).filter(([nx, ny]) => !world.grid[ny * world.params.width + nx].fox);
        if (free2.length) {
          const [nx, ny] = pick(free2);
          const child = Math.floor(f.energy / 2);
          f.energy -= child;
          world.grid[ny * world.params.width + nx].fox = { id: world.idCounter++, energy: child };
        }
      }
      if (f.energy <= 0) {
        world.grid[f.y * world.params.width + f.x].fox = null;
        world.foxes = world.foxes.filter(a => a !== f);
      }
    }
    world.tick += 1;
    recordHistory();
  }

  function counts() {
    return { rabbits: world.rabbits.length, foxes: world.foxes.length, grass: world.history[world.history.length - 1].grass };
  }

  function cell(x, y) {
    const c = world.grid[y * world.params.width + x];
    return { grass: c.grass, rabbit: c.rabbit, fox: c.fox };
  }

  function history() {
    return world.history;
  }

  function ode(p, t, dt) {
    const n = Math.round(t / dt);
    let x = p.x0, y = p.y0;
    const f = (x, y) => [p.alpha * x - p.beta * x * y, p.delta * x * y - p.gamma * y];
    for (let i = 0; i < n; i++) {
      const k1 = f(x, y);
      const k2 = f(x + k1[0] * dt / 2, y + k1[1] * dt / 2);
      const k3 = f(x + k2[0] * dt / 2, y + k2[1] * dt / 2);
      const k4 = f(x + k3[0] * dt, y + k3[1] * dt);
      x += (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      y += (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    }
    return { x, y };
  }

  function exportCSV() {
    const lines = ['tick,rabbits,foxes,grass'];
    for (const h of world.history) lines.push(`${h.tick},${h.rabbits},${h.foxes},${h.grass}`);
    return lines.join('\n') + '\n';
  }

  function exportScenario() {
    return JSON.stringify({ version: 1, seed: world.seed, params: world.params });
  }

  function loadScenario(text) {
    try {
      const obj = JSON.parse(text);
      if (obj.version !== 1 || !Number.isInteger(obj.seed)) return false;
      reset(obj.seed, obj.params || {});
      document.querySelector('[data-testid="scenario-error"]').textContent = '';
      return true;
    } catch (e) {
      document.querySelector('[data-testid="scenario-error"]').textContent = 'Invalid scenario';
      return false;
    }
  }

  function redraw() {
    const canvas = document.querySelector('[data-testid="world"]');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < world.params.height; y++) {
      for (let x = 0; x < world.params.width; x++) {
        const c = world.grid[y * world.params.width + x];
        const G = 60 + Math.round(160 * c.grass / world.params.grassMax);
        ctx.fillStyle = `rgb(30,${G},30)`;
        ctx.fillRect(x * 10, y * 10, 10, 10);
      }
    }
    for (const r of world.rabbits) {
      ctx.fillStyle = 'rgb(240,240,240)';
      ctx.fillRect(r.x * 10 + 3, r.y * 10 + 3, 4, 4);
    }
    for (const f of world.foxes) {
      ctx.fillStyle = 'rgb(220,80,20)';
      ctx.fillRect(f.x * 10 + 3, f.y * 10 + 3, 4, 4);
    }
  }

  function updateCounters() {
    const c = counts();
    document.querySelector('[data-testid="tick"]').textContent = world.tick;
    document.querySelector('[data-testid="count-rabbits"]').textContent = c.rabbits;
    document.querySelector('[data-testid="count-foxes"]').textContent = c.foxes;
    document.querySelector('[data-testid="count-grass"]').textContent = c.grass;
  }

  function updateChart() {
    const svg = document.querySelector('[data-testid="chart"]');
    const w = 300, h = 220;
    const maxTick = world.history.length - 1 || 1;
    const maxCount = Math.max(...world.history.map(h => h.rabbits), ...world.history.map(h => h.foxes), 1);
    const toX = t => (t / maxTick) * (w - 20) + 10;
    const toY = c => h - 10 - (c / maxCount) * (h - 20);
    const rPoints = world.history.map(h => `${toX(h.tick)},${toY(h.rabbits)}`).join(' ');
    const fPoints = world.history.map(h => `${toX(h.tick)},${toY(h.foxes)}`).join(' ');
    svg.innerHTML = `<polyline data-testid="series-rabbits" points="${rPoints}" fill="none" stroke="rgb(240,240,240)" stroke-width="2"/>
      <polyline data-testid="series-foxes" points="${fPoints}" fill="none" stroke="rgb(220,80,20)" stroke-width="2"/>
      <text x="10" y="${h - 5}" font-size="10">tick</text>
      <text x="5" y="10" font-size="10">count</text>`;
  }

  function updateOdeChart() {
    const svg = document.querySelector('[data-testid="ode-chart"]');
    const w = 300, h = 200;
    const p = { alpha: parseFloat(document.querySelector('[data-testid="ode-alpha"]').value), beta: parseFloat(document.querySelector('[data-testid="ode-beta"]').value), gamma: parseFloat(document.querySelector('[data-testid="ode-gamma"]').value), delta: parseFloat(document.querySelector('[data-testid="ode-delta"]').value), x0: parseFloat(document.querySelector('[data-testid="ode-x0"]').value), y0: parseFloat(document.querySelector('[data-testid="ode-y0"]').value), t: parseFloat(document.querySelector('[data-testid="ode-t"]').value), dt: parseFloat(document.querySelector('[data-testid="ode-dt"]').value) };
    const n = Math.round(p.t / p.dt);
    let x = p.x0, y = p.y0;
    const f = (x, y) => [p.alpha * x - p.beta * x * y, p.delta * x * y - p.gamma * y];
    const xs = [x], ys = [y];
    for (let i = 0; i < n; i++) {
      const k1 = f(x, y);
      const k2 = f(x + k1[0] * p.dt / 2, y + k1[1] * p.dt / 2);
      const k3 = f(x + k2[0] * p.dt / 2, y + k2[1] * p.dt / 2);
      const k4 = f(x + k3[0] * p.dt, y + k3[1] * p.dt);
      x += (p.dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      y += (p.dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      xs.push(x); ys.push(y);
    }
    const maxX = Math.max(...xs), maxY = Math.max(...ys);
    const toX = i => (i / (n || 1)) * (w - 20) + 10;
    const toY = v => h - 10 - (v / Math.max(maxX, 1)) * (h - 20);
    const toY2 = v => h - 10 - (v / Math.max(maxY, 1)) * (h - 20);
    const xPoints = xs.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
    const yPoints = ys.map((v, i) => `${toX(i)},${toY2(v)}`).join(' ');
    svg.innerHTML = `<polyline data-testid="ode-series-x" points="${xPoints}" fill="none" stroke="rgb(240,240,240)" stroke-width="2"/>
      <polyline data-testid="ode-series-y" points="${yPoints}" fill="none" stroke="rgb(220,80,20)" stroke-width="2"/>`;
    document.querySelector('[data-testid="ode-x"]').textContent = x.toFixed(8);
    document.querySelector('[data-testid="ode-y"]').textContent = y.toFixed(8);
    document.querySelector('[data-testid="ode-eq-x"]').textContent = (p.gamma / p.delta).toFixed(8);
    document.querySelector('[data-testid="ode-eq-y"]').textContent = (p.alpha / p.beta).toFixed(8);
    const V = (x, y) => p.delta * x - p.gamma * Math.log(x) + p.beta * y - p.alpha * Math.log(y);
    document.querySelector('[data-testid="ode-drift"]').textContent = Math.abs(V(x, y) - V(p.x0, p.y0)).toFixed(8);
  }

  function updatePresets() {
    const list = document.querySelector('[data-testid="preset-list"]');
    list.innerHTML = '';
    let presets = {};
    try { presets = JSON.parse(localStorage.getItem('ecolab.presets')) || {}; } catch (e) { presets = {}; }
    for (const name of Object.keys(presets)) {
      const item = document.createElement('div');
      item.className = 'preset-item';
      item.innerHTML = `<span>${name}</span><button data-testid="preset-load">Load</button><button data-testid="preset-delete">Delete</button>`;
      const loadBtn = item.querySelector('[data-testid="preset-load"]');
      loadBtn.onclick = () => loadScenario(JSON.stringify(presets[name]));
      const delBtn = item.querySelector('[data-testid="preset-delete"]');
      delBtn.onclick = () => { delete presets[name]; localStorage.setItem('ecolab.presets', JSON.stringify(presets)); updatePresets(); };
      list.appendChild(item);
    }
  }

  function savePreset() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    if (!name) return;
    let presets = {};
    try { presets = JSON.parse(localStorage.getItem('ecolab.presets')) || {}; } catch (e) { presets = {}; }
    presets[name] = { version: 1, seed: world.seed, params: world.params };
    localStorage.setItem('ecolab.presets', JSON.stringify(presets));
    updatePresets();
  }

  function play() {
    if (playing) return;
    playing = true;
    lastTime = performance.now();
    requestAnimationFrame(loop);
  }

  function pause() {
    playing = false;
    document.querySelector('[data-testid="announcer"]').textContent = `Tick ${world.tick}: ${world.rabbits.length} rabbits, ${world.foxes.length} foxes`;
  }

  function loop(now) {
    if (!playing) return;
    const speed = parseFloat(document.querySelector('[data-testid="speed"]').value);
    const elapsed = (now - lastTime) / 1000;
    const ticks = Math.floor(elapsed * speed);
    if (ticks > 0) {
      step(ticks);
      lastTime = now;
    }
    requestAnimationFrame(loop);
  }

  function stepOnce() {
    step(1);
    document.querySelector('[data-testid="announcer"]').textContent = `Tick ${world.tick}: ${world.rabbits.length} rabbits, ${world.foxes.length} foxes`;
  }

  function doReset() {
    const seed = parseFloat(document.querySelector('[data-testid="seed"]').value);
    const params = {};
    for (const key of ['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax']) {
      params[key] = parseFloat(document.querySelector(`[data-testid="param-${key}"]`).value);
    }
    reset(seed, params);
    document.querySelector('[data-testid="announcer"]').textContent = `Tick ${world.tick}: ${world.rabbits.length} rabbits, ${world.foxes.length} foxes`;
  }

  function updateChartOnReset() {
    const svg = document.querySelector('[data-testid="chart"]');
    const w = 300, h = 220;
    const maxTick = 1;
    const maxCount = Math.max(...world.history.map(h => h.rabbits), ...world.history.map(h => h.foxes), 1);
    const toX = t => (t / maxTick) * (w - 20) + 10;
    const toY = c => h - 10 - (c / maxCount) * (h - 20);
    const rPoints = world.history.map(h => `${toX(h.tick)},${toY(h.rabbits)}`).join(' ');
    const fPoints = world.history.map(h => `${toX(h.tick)},${toY(h.foxes)}`).join(' ');
    svg.innerHTML = `<polyline data-testid="series-rabbits" points="${rPoints}" fill="none" stroke="rgb(240,240,240)" stroke-width="2"/>
      <polyline data-testid="series-foxes" points="${fPoints}" fill="none" stroke="rgb(220,80,20)" stroke-width="2"/>
      <text x="10" y="${h - 5}" font-size="10">tick</text>
      <text x="5" y="10" font-size="10">count</text>`;
  }

  function updateAll() {
    redraw();
    updateCounters();
    updateChart();
  }

  function onKeydown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
    if (e.key === ' ') {
      e.preventDefault();
      if (playing) pause(); else play();
    } else if (e.key === 's') {
      stepOnce();
    } else if (e.key === 'r') {
      doReset();
    }
  }

  function downloadCSV() {
    const blob = new Blob([exportCSV()], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ecolab.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportOde() {
    const p = { alpha: parseFloat(document.querySelector('[data-testid="ode-alpha"]').value), beta: parseFloat(document.querySelector('[data-testid="ode-beta"]').value), gamma: parseFloat(document.querySelector('[data-testid="ode-gamma"]').value), delta: parseFloat(document.querySelector('[data-testid="ode-delta"]').value), x0: parseFloat(document.querySelector('[data-testid="ode-x0"]').value), y0: parseFloat(document.querySelector('[data-testid="ode-y0"]').value), t: parseFloat(document.querySelector('[data-testid="ode-t"]').value), dt: parseFloat(document.querySelector('[data-testid="ode-dt"]').value) };
    const result = ode(p, p.t, p.dt);
    document.querySelector('[data-testid="ode-x"]').textContent = result.x.toFixed(8);
    document.querySelector('[data-testid="ode-y"]').textContent = result.y.toFixed(8);
    document.querySelector('[data-testid="ode-eq-x"]').textContent = (p.gamma / p.delta).toFixed(8);
    document.querySelector('[data-testid="ode-eq-y"]').textContent = (p.alpha / p.beta).toFixed(8);
    const V = (x, y) => p.delta * x - p.gamma * Math.log(x) + p.beta * y - p.alpha * Math.log(y);
    document.querySelector('[data-testid="ode-drift"]').textContent = Math.abs(V(result.x, result.y) - V(p.x0, p.y0)).toFixed(8);
    updateOdeChart();
  }

  function exportScenarioBtn() {
    document.querySelector('[data-testid="scenario-json"]').value = exportScenario();
  }

  function loadScenarioBtn() {
    loadScenario(document.querySelector('[data-testid="scenario-json"]').value);
  }

  function savePresetBtn() {
    savePreset();
  }

  function loadPreset(name) {
    let presets = {};
    try { presets = JSON.parse(localStorage.getItem('ecolab.presets')) || {}; } catch (e) { presets = {}; }
    if (presets[name]) loadScenario(JSON.stringify(presets[name]));
  }

  function deletePreset(name) {
    let presets = {};
    try { presets = JSON.parse(localStorage.getItem('ecolab.presets')) || {}; } catch (e) { presets = {}; }
    delete presets[name];
    localStorage.setItem('ecolab.presets', JSON.stringify(presets));
    updatePresets();
  }

  function loadPresetBtn() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    loadPreset(name);
  }

  function deletePresetBtn() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    deletePreset(name);
  }

  function savePresetBtn2() {
    savePreset();
  }

  function loadPresetBtn2() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    loadPreset(name);
  }

  function deletePresetBtn2() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    deletePreset(name);
  }

  function savePresetBtn3() {
    savePreset();
  }

  function loadPresetBtn3() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    loadPreset(name);
  }

  function deletePresetBtn3() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    deletePreset(name);
  }

  function savePresetBtn4() {
    savePreset();
  }

  function loadPresetBtn4() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    loadPreset(name);
  }

  function deletePresetBtn4() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    deletePreset(name);
  }

  function savePresetBtn5() {
    savePreset();
  }

  function loadPresetBtn5() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    loadPreset(name);
  }

  function deletePresetBtn5() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    deletePreset(name);
  }

  function savePresetBtn6() {
    savePreset();
  }

  function loadPresetBtn6() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    loadPreset(name);
  }

  function deletePresetBtn6() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    deletePreset(name);
  }

  function savePresetBtn7() {
    savePreset();
  }

  function loadPresetBtn7() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    loadPreset(name);
  }

  function deletePresetBtn7() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    deletePreset(name);
  }

  function savePresetBtn8() {
    savePreset();
  }

  function loadPresetBtn8() {
    const name = document.querySelector('[data-testid="preset-name"]').value;
    loadPreset(name);
  }

  function deletePresetBtn8() {
    const name = document.querySelector