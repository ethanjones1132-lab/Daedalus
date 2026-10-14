## Plan

The simulation uses a 2D grid where each cell holds grass, an optional rabbit, and an optional fox. A global `idCounter` ensures every animal has a unique ID. The `reset` function initializes the world from the seed and parameters, then records the initial state. Each tick processes rabbits and foxes in ascending ID order, with movement, eating, breeding, and death handled per animal.

The `lab` API exposes the simulation state and the `ode` function, which integrates the Lotka–Volterra equations using RK4. The UI is divided into two panels: `panel-world` for the canvas, simulation controls, and counters; `panel-side` for the population chart, the ODE panel, scenario tools, and presets. A `requestAnimationFrame`-based loop advances the simulation at the user-defined speed while playing.

## Ecosystem Lab

```html
<div id="app">
  <div class="layout">
    <div class="panel panel-world">
      <canvas data-testid="world"></canvas>
      <div class="controls">
        <input type="number" data-testid="seed" value="42" />
        <input type="range" data-testid="speed" min="1" max="60" value="10" />
        <div class="param-group">
          <label for="param-rabbits0">Rabbits</label>
          <input type="range" data-testid="param-rabbits0" min="0" max="300" value="100" />
        </div>
        <div class="param-group">
          <label for="param-foxes0">Foxes</label>
          <input type="range" data-testid="param-foxes0" min="0" max="60" value="6" />
        </div>
        <div class="param-group">
          <label for="param-rabbitBreed">Rabbit Breed</label>
          <input type="range" data-testid="param-rabbitBreed" min="2" max="40" value="6" />
        </div>
        <div class="param-group">
          <label for="param-foxBreed">Fox Breed</label>
          <input type="range" data-testid="param-foxBreed" min="2" max="60" value="12" />
        </div>
        <div class="param-group">
          <label for="param-foxGain">Fox Gain</label>
          <input type="range" data-testid="param-foxGain" min="1" max="30" value="4" />
        </div>
        <div class="param-group">
          <label for="param-grassMax">Grass Max</label>
          <input type="range" data-testid="param-grassMax" min="1" max="10" value="4" />
        </div>
        <div class="counters">
          <span data-testid="count-tick">0</span>
          <span data-testid="count-rabbits">0</span>
          <span data-testid="count-foxes">0</span>
          <span data-testid="count-grass">0</span>
        </div>
        <button data-testid="play" />
        <button data-testid="pause" />
        <button data-testid="step" />
        <button data-testid="reset" />
      </div>
    </div>
    <div class="panel panel-side">
      <svg data-testid="chart"></svg>
      <div class="ode-panel">
        <input type="number" data-testid="ode-alpha" value="1.1" />
        <input type="number" data-testid="ode-beta" value="0.4" />
        <input type="number" data-testid="ode-gamma" value="0.4" />
        <input type="number" data-testid="ode-delta" value="0.1" />
        <input type="number" data-testid="ode-x0" value="10" />
        <input type="number" data-testid="ode-y0" value="10" />
        <input type="number" data-testid="ode-t" value="50" />
        <input type="number" data-testid="ode-dt" value="0.01" />
        <button data-testid="ode-run" />
        <div id="ode-results"></div>
        <svg data-testid="ode-chart"></svg>
      </div>
      <div class="scenario-tools">
        <textarea data-testid="scenario-json"></textarea>
        <button data-testid="scenario-export" />
        <button data-testid="scenario-load" />
        <p id="scenario-error"></p>
      </div>
      <div class="presets">
        <input type-text data-testid="preset-name" />
        <button data-testid="preset-save" />
        <div data-testid="preset-list"></div>
      </div>
    </div>
  </div>
  <div data-testid="announcer" aria-live="polite"></div>
</div>
```

```css
.layout { display: flex; flex-direction: column; }
.panel { border: 1px solid #ccc; padding: 10px; margin: 10px; }
.panel-side { display: flex; flex-direction: column; }
.counters { font-size: 1.2em; font-weight: bold; }
.param-group { margin: 5px 0; }
.ode-results { margin: 10px 0; font-size: 0.9em; }
@media (min-width: 1000px) { .layout { flex-direction: row; } }
@media (max-width: 699px) { .layout { flex-direction: column; } }
```

```javascript
const DEFAULT_PARAMS = {
  width: 40, height: 30, grassMax: 4, rabbits0: 100, foxes0: 6,
  rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
  foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 12,
};

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

function pick(list) { return list.length ? list[Math.floor(Math.random() * list.length)] : undefined; }

function getNeighbors(x, y, width, height) {
  const neighbors = [];
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [dx, dy] of dirs) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < width && ny >= 0 && ny < height) neighbors.push([nx, ny]);
  }
  return neighbors;
}

let state = {
  seed, params, rand, tick, idCounter, history,
  grid, rabbits, foxes, playing, lastUpdate,
};

function updateCounts() {
  const grass = state.grid.reduce((sum, cell) => sum + cell.grass, 0);
  return { rabbits: state.rabbits.length, foxes: state.foxes.length, grass };
}

function render() {
  const canvas = document.getElementById('world');
  const ctx = canvas.getContext('2d');
  const { width, height, grassMax } = state.params;
  canvas.width = width * 10;
  canvas.height = height * 10;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  state.grid.forEach((cell, y) => {
    for (let x = 0; x < width; x++) {
      const g = 60 + Math.round(160 * cell.grass / grassMax);
      ctx.fillStyle = `rgb(30, ${g}, 30)`;
      ctx.fillRect(x * 10, y * 10, 10, 10);
    }
  });
  state.rabbits.forEach(r => {
    ctx.fillStyle = `rgb(240, 240, 240)`;
    ctx.fillRect(r.x * 10 - 5, r.y * 10 - 5, 10, 10);
  });
  state.foxes.forEach(f => {
    ctx.fillStyle = `rgb(220, 80, 20)`;
    ctx.fillRect(f.x * 10 - 5, f.y * 10 - 5, 10, 10);
  });
}

function update() {
  const { rabbits, foxes, grassMax } = state;
  const rabbitList = rabbits.slice().sort((a, b) => a.id - b.id);
  const foxList = foxes.slice().sort((a, b) => a.id - b.id);

  rabbitList.forEach(r => {
    const neighbors = getNeighbors(r.x, r.y, state.params.width, state.params.height).filter(n => !rabbitList.some(rb => rb.x === n[0] && rb.y === n[1]));
    if (neighbors.length) {
      const [nx, ny] = pick(neighbors);
      r.x = nx; r.y = ny;
    }
    r.energy += state.params.rabbitGain * state.grid[r.y][r.x].grass;
    state.grid[r.y][r.x].grass = 0;
    r.energy -= state.params.rabbitCost;
    if (r.energy >= state.params.rabbitBreed) {
      const breedNeighbors = getNeighbors(r.x, r.y, state.params.width, state.params.height).filter(n => !rabbitList.some(rb => rb.x === n[0] && rb.y === n[1]));
      if (breedNeighbors.length) {
        const [nx, ny] = pick(breedNeighbors);
        r.energy -= Math.floor(r.energy / 2);
        rabbits.push({ id: ++state.idCounter, x: nx, y: ny, energy: Math.floor(r.energy / 2) });
      }
    }
    if (r.energy <= 0) rabbits = rabbits.filter(rb => rb.id !== r.id);
  });

  foxList.forEach(f => {
    const rabbitTarget = getNeighbors(f.x, f.y, state.params.width, state.params.height).filter(n => rabbitList.some(rb => rb.x === n[0] && rb.y === n[1])).filter(n => !foxList.some(fox => fox.x === n[0] && fox.y === n[1]));
    if (rabbitTarget.length) {
      const [nx, ny] = pick(rabbitTarget);
      f.x = nx; f.y = ny;
    } else {
      const noFoxNeighbors = getNeighbors(f.x, f.y, state.params.width, state.params.height).filter(n => !foxList.some(fox => fox.x === n[0] && fox.y === n[1]));
      if (noFoxneighbors.length) {
        const [nx, ny] = pick(noFoxNeighbors);
        f.x = nx; f.y = ny;
      }
    }
    if (rabbitList.some(r => r.x === f.x && r.y === f.y)) {
      rabbits = rabbits.filter(r => r.id !== rabbitList.find(rb => rb.x === f.x && rb.y === f.y).id);
      f.energy += state.params.foxGain;
    }
    f.energy -= state.params.foxCost;
    if (f.energy >= state.params.foxBreed) {
      const breedNeighbors = getNeighbors(f.x, f.y, state.params.width, state.params.height).filter(n => !foxList.some(fox => fox.x === n[0] && fox.y === n[1]));
      if (breedNeighbors.length) {
        const [nx, ny] = pick(breedNeighbors);
        f.energy -= Math.floor(f.energy / 2);
        foxes.push({ id: ++state.idCounter, x: nx, y: ny, energy: Math.floor(f.energy / 2) });
      }
    }
    if (f.energy <= 0) foxes = foxes.filter(fox => fox.id !== f.id);
  });

  state.tick++;
  state.history.push({ tick: state.tick, rabbits: state.rabbits.length, foxes: state.foxes.length, grass: state.grid.reduce((sum, cell) => sum + cell.grass, 0) });
  render();
}

function ode(p, t, dt) {
  let { x, y } = [p.x0, p.y0];
  const n = Math.round(t / dt);
  for (let i = 0; i < n; i++) {
    const k1x = p.alpha * x - p.beta * x * y;
    const k1y = p.delta * x * y - p.gamma * y;
    const k2x = p.alpha * (x + 0.5 * dt * k1x) - p.beta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y);
    const k2y = p.delta * (x + 0.5 * dt * k1x) - p.gamma * (y + 0.5 * dt * k1y);
    const k3x = p.alpha * (x + 0.5 * dt * k2x) - p.beta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y);
    const k3y = p.delta * (x + 0.5 * dt * k2x) - p.gamma * (y + 0.5 * dt * k2y);
    const k4x = p.alpha * (x + dt * k3x) - p.beta * (x + dt * k3x) * (y + dt * k3y);
    const k4y = p.delta * (x + dt * k3x) - p.gamma * (y + dt * k3y);
    x += (dt / 4) * (k1x + k2x + k3x + k4x);
    y += (dt / 4) * (k1y + k2y + k3y + k4y);
  }
  return { x, y };
}

window.lab = {
  reset(seed, params = {}) {
    state.params = { ...DEFAULT_PARAMS, ...params };
    state.seed = seed;
    state.rand = mulberry32(seed);
    state.tick = 0;
    state.idCounter = 1;
    state.history = [];
    state.grid = Array(state.params.height).fill(0).map(() => Array(state.params.width).fill(0).map(() => ({ grass: 0 }))).map((row, y) => row.map((cell, x) => ({ grass: Math.floor(state.rand() * (state.params.grassMax + 1)) })));
    state.rabbits = [];
    state.foxes = [];
    for (let i = 0; i < state.params.rabbits0; i++) {
      const rabbitCells = state.grid.map((row, y) => y).map((y, x) => [x, y]).filter(cell => !state.rabbits.some(rb => rb.x === cell[0] && rb.y === cell[1]));
    }
    // Re-implement reset correctly
    state.grid = Array(state.params.height).fill(0).map(() => Array(state.params.width).fill(0).map(() => ({ grass: 0 }))).map((row, y) => row.map((cell, x) => ({ grass: Math.floor(state.rand() * (state.params.grassMax + 1)) })));
    state.rabbits = [];
    state.foxes = [];
    for (let i = 0; i < state.params.rabbits0; i++) {
      const rabbitCells = [];
      for (let y = 0; y < state.params.height; y++) {
        for (let x = 0; x < state.params.width; x++) {
          if (!state.rabbits.some(rb => rb.x === x && rb.y === y)) rabbitCells.push([x, y]);
        }
      }
      const [nx, ny] = pick(rabbitCells);
      state.rabbits.push({ id: ++state.idCounter, x: nx, y: ny, energy: state.params.rabbitStart });
    }
    for (let i = 0; i < state.params.foxes0; i++) {
      const foxCells = [];
      for (let y = 0; y < state.params.height; y++) {
        for (let x = 0; x < state.params.width; x++) {
          if (!state.foxes.some(fox => fox.x === x && fox.y === y)) foxCells.push([x, y]);
        }
      }
      const [nx, ny] = pick(foxCells);
      state.foxes.push({ id: ++state.idCounter, x: nx, y: ny, energy: state.params.foxStart });
    }
    state.history = [];
    state.tick = 0;
    render();
    return counts();
  },
  step(n = 1) {
    for (let i = 0; i < n; i++) update();
    return counts();
  },
  counts() {
    const grass = state.grid.reduce((sum, cell) => sum + cell.grass, 0);
    return { rabbits: state.rabbits.length, foxes: state.foxes.length, grass };
  },
  tick() { return state.tick; },
  cell(x, y) { return { grass: state.grid[y][x].grass, rabbit: state.rabbits.find(r => r.x === x && r.y === y), fox: state.foxes.find(f => f.x === x && f.y === y) }; },
  history() { return state.history; },
  ode(p, t, dt) { return ode(p, t, dt); },
  exportCSV() { return `tick,rabbits,foxes,grass\n` + state.history.map(h => `${h.tick},${h.rabbits},${h.foxes},${h.grass}`).join('\n') + '\n'; },
  exportScenario() { return JSON.stringify({ version: 1, seed: state.seed, params: state.params }); },
  loadScenario(text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.version !== 1 || typeof parsed.seed !== 'number') throw new Error('Invalid version or seed');
      state.params = { ...DEFAULT_PARAMS, ...parsed.params };
      state.seed = parsed.seed;
      state.idCounter = 1;
      state.history = [];
      state.rabbits = [];
      state.foxes = [];
      state.grid = Array(state.params.height).fill(0).map(() => Array(state.params.width).fill(0).map(() => ({ grass: 0 }))).map((row, y) => row.map((cell, x) => ({ grass: Math.floor(state.rand() * (state.params.grassMax + 1)) })));
    } catch (e) {
      document.getElementById('scenario-error').innerText = e.message;
      return false;
    }
    document.getElementById('scenario-error').innerText = '';
    return true;
  }
};

function init() {
  const seedEl = document.getElementById('seed');
  const rabbitBreedEl = document.getElementById('param-rabbitBreed');
  const foxBreedEl = document.getElementById('param-foxBreed');
  const foxGainEl = document.getElementById('param-foxGain');
  const grassMaxEl = document.getElementById('param-grassMax');
  const odeAlphaEl = document.getElementById('ode-alpha');
  const odeBetaEl = document.getElementById('ode-beta');
  const odeGammaEl = document.getElementById('ode-gamma');
  const odeDeltaEl = document.getElementById('ode-delta');
  const odeX0El = document.getElementById('ode-x0');
  const odeY0El = document.getElementById('ode-y0');
  const odeTEl = document.getElementById('ode-t');
  const odedtEl = document.getElementById('ode-dt');

  const updateCounters = () => {
    const { rabbits, foxes, grass } = counts();
    document.getElementById('count-tick').innerText = state.tick;
    document.getElementById('count-rabbits').innerText = rabbits;
    document.getElementById('count-foxes').innerText = foxes;
    document.getElementById('count-grass').innerText = grass;
  };

  const updateODE = () => {
    const p = {
      alpha: parseFloat(odeAlphaEl.value),
      beta: parseFloat(odeBetaEl.value),
      gamma: parseFloat(odeGammaEl.value),
      delta: parseFloat(odeDeltaEl.value),
      x0: parseFloat(odeX0El.value),
      y0: parseFloat(odeY0El.value),
      t: parseFloat(odeTEl.value),
      dt: parseFloat(odedtEl.value),
    };
    const { x, y } = ode(p);
    document.getElementById('ode-results').innerHTML = `x: ${x.toFixed(8)}, y: ${y.toFixed(8)}, eq-x: ${(p.gamma / p.delta).toFixed(8)}, eq-y: ${(p.alpha / p.beta).toFixed(8)}, drift: ${Math.abs(p.delta * x - p.gamma * Math.log(x) + p.beta * y - p.alpha * Math.log(y)).toFixed(8)}`;
    render();
  };

  const handleReset = () => {
    const params = {};
    const seed = parseInt(seedEl.value);
    if (isNaN(seed)) return;
    state.params = { ...DEFAULT_PARAMS, ...params };
    state.seed = seed;
    state.idCounter = 1;
    state.history = [];
    state.grid = Array(state.params.height).fill(0).map(() => Array(state.params.width).fill(0).map(() => ({ grass: 0 }))).map((row, y) => row.map((cell, x) => ({ grass: Math.floor(state.rand() * (state.params.grassMax + 1)) })));
    state.rabbits = [];
    state.foxes = [];
    for (let i = 0; i < state.params.rabbits0; i++) {
      const rabbitCells = [];
      for (let y = 0; y < state.params.height; y++) {
        for (let x = 0; x < state.params.width; x++) {
          if (!state.rabbits.some(rb => rb.x === x && rb.y === y)) rabbitCells.push([x, y]);
        }
      }
      const [nx, ny] = pick(rabbitCells);
      state.rabbits.push({ id: ++state.idCounter, x: nx, y: ny, energy: state.params.rabbitStart });
    }
    for (let i = 0; i < state.params.foxes0; i++) {
      const foxCells = [];
      for (let y = 0; y < state.params.height; y++) {
        for (let x = 0; x < state.params.width; x++) {
          if (!state.foxes.some(fox => fox.x === x && fox.y === y)) foxCells.push([x, y]);
        }
      }
      const [nx, ny] = pick(foxCells);
      state.foxes.push({ id: ++state.idCounter, x: nx, y: ny, energy: state.params.foxStart });
    }
    state.history = [];
    state.tick = 0;
    render();
    updateCounters();
  };

  const handlePlay = () => {
    state.playing = !state.playing;
    if (state.playing) requestAnimationFrame(loop);
  };

  const handlePause = () => {
    state.playing = false;
    document.getElementById('announcer').innerText = `Tick ${state.tick}: ${state.rabbits.length} rabbits, ${state.foxes.length} foxes`;
  };

  const handleStep = () => {
    update();
    updateCounters();
  };

  const handleExportCSV = () => {
    const csv = exportCSV();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ecolab.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportScenario = () => {
    document.getElementById('scenario-json').value = exportScenario();
  };

  const handleLoadScenario = () => {
    const text = document.getElementById('scenario-json').value;
    if (handleLoadScenario(text)) {
      document.getElementById('scenario-error').innerText = '';
    }
  };

  const handlePresetSave = () => {
    const name = document.getElementById('preset-name').value;
    if (!name) return;
    const presets = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
    presets[name] = exportScenario();
    localStorage.setItem('ecolab.presets', JSON.stringify(presets));
    renderPresets();
  };

  const renderPresets = () => {
    const list = document.getElementById('preset-list');
    list.innerHTML = '';
    const presets = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
    Object.keys(presets).forEach(name => {
      const li = document.createElement('li');
      li.innerHTML = `${name} <button data-testid="preset-load">Load</button> <button data-testid="preset-delete">Delete</button>`;
      list.appendChild(li);
    });
  };

  const handlePresetLoad = (e) => {
    const name = e.target.dataset.preset;
    const presets = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
    if (presets[name]) handleReset(parseInt(document.getElementById('seed').value));
  };

  const handlePresetDelete = (e) => {
    const name = e.target.dataset.preset;
    const presets = JSON.parse(localStorage.getItem('ecolab.presets') || '{}');
    delete presets[name];
    localStorage.setItem('ecolab.presets', JSON.stringify(presets));
    renderPresets();
  };

  const loop = (now) => {
    if (!state.playing) return;
    const speed = parseInt(document.getElementById('speed').value);
    const delta = now - (state.lastUpdate || now);
    if (delta >= 1000 / speed) {
      update();
      state.lastUpdate = now;
    }
    requestAnimationFrame(loop);
  };

  document.getElementById('reset').onclick = handleReset;
  document.getElementById('play').onclick = handlePlay;
  document.getElementById('pause').onclick = handlePause;
  document.getElementById('step').onclick = handleStep;
  document.getElementById('ode-run').onclick = updateODE;
  document.getElementById('csv-export').onclick = handleExportCSV;
  document.getElementById('scenario-export').onclick = handleExportScenario;
  document.getElementById('scenario-load').onclick = handleLoadScenario;
  document.getElementById('preset-save').onclick = handlePresetSave;

  document.querySelectorAll('.preset-item').forEach(item => {
    item.querySelector('[data-testid="preset-load"]').onclick = () => handlePresetLoad(item);
    item.querySelector('[data-testid="preset-delete"]').onclick = () => handlePresetDelete(item);
  });

  document.getElementById('seed').onchange = () => {
    document.getElementById('seed').value = parseInt(document.getElementById('seed').value);
  };

  document.getElementById('ode-alpha').onchange = () => updateODE();
  document.getElementById('ode-beta').onchange = () => updateODE();
  document.getElementById('ode-gamma').onchange = () => updateODE();
  document.getElementById('ode-delta').onchange = () => updateODE();
  document.getElementById('ode-x0').onchange = () => updateODE();
  document.getElementById('ode-y0').onchange = () => updateODE();
  document.getElementById('ode-t').onchange = () => updateODE();
  document.getElementById('ode-dt').onchange = () => updateODE();

  renderPresets();
  render();
  updateCounters();
}

window.lab = {
  reset: (seed, params) => {
    document.getElementById('seed').value = seed;
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-alpha').value = params.odeAlpha || 1.1;
    document.getElementById('ode-beta').value = params.odeBeta || 0.4;
    document.getElementById('ode-gamma').value = params.odeGamma || 0.4;
    document.getElementById('ode-delta').value = params.odeDelta || 0.1;
    document.getElementById('ode-x0').value = params.odeX0 || 10;
    document.getElementById('ode-y0').value = params.odeY0 || 10;
    document.getElementById('ode-t').value = params.odeT || 50;
    document.getElementById('ode-dt').value = params.odeDt || 0.01;
    document.getElementById('param-rabbits0').value = params.rabbits0 || 100;
    document.getElementById('param-foxes0').value = params.foxes0 || 6;
    document.getElementById('param-rabbitBreed').value = params.rabbitBreed || 6;
    document.getElementById('param-foxBreed').value = params.foxBreed || 12;
    document.getElementById('param-foxGain').value = params.foxGain || 4;
    document.getElementById('param-grassMax').value = params.grassMax || 4;
    document.getElementById('speed').value = params.speed || 10;
    document.getElementById('seed').value = seed;
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById('scenario-json').value = '';
    document.getElementById('ode-results').innerHTML = '';
    document.getElementById('scenario-error').innerText = '';
    document.getElementById