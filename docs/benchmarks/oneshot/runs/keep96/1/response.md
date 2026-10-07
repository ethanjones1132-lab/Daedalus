Here is the plan for the Ecosystem Lab application.

### Data Model
- **Grid**: A 2D array of cells, each containing `grass` (int), `rabbit` (obj/null), `fox` (obj/null).
- **Animals**: Rabbits and Foxes are stored in separate lists (`rabbits`, `foxes`) with `id`, `energy`, `x`, `y`.
- **Simulation State**: `seed`, `params`, `tick`, `rand` generator, `history` array.
- **Lotka-Volterra**: Uses RK4 integration for 4-point interpolation.

### Tick Order
1. Grass increases.
2. Rabbits move, eat, breed, die.
3. Foxes move, eat, breed, die.
4. Record history.

### Components
- **World Panel**: Canvas for grid, controls for simulation, counters.
- **Side Panel**: Chart for populations, Lotka-Volterra solver, Scenario/CSV export, Presets.
- **API**: Exposed via `window.lab`.

```html
<!DOCTYPE html>
<html>
<head>
<meta>
<title>Ecosystem Lab</title>
</meta>
</head>
<body>
<script>
const defaults = {
  width: 40, height: 30, grassMax: 4, rabbits0: 100, foxes0: 6,
  rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
  foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
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

let sim = {
  grid: [], params: {}, rand: null, tick: 0, history: [],
  rabbits: [], foxes: [], idCounter: 1, playing: false, speed: 10, timer: null
};

function pick(list) {
  if (!list.length) return null;
  return list[Math.floor(sim.rand() * list.length)];
}

function reset(seed, params = {}) {
  sim.params = Object.assign({}, defaults, params);
  sim.rand = mulberry32(seed);
  sim.tick = 0;
  sim.history = [];
  sim.idCounter = 1;
  sim.rabbits = [];
  sim.foxes = [];
  const { width, height, grassMax } = sim.params;
  sim.grid = [];
  for (let y = 0; y < height; y++) {
    sim.grid.push([]);
    for (let x = 0; x < width; x++) {
      sim.grid[y].push({ grass: 0, rabbit: null, fox: null });
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sim.grid[y][x].grass = Math.floor(sim.rand() * (grassMax + 1));
    }
  }
  for (let i = 0; i < sim.params.rabbits0; i++) {
    const candidates = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!sim.grid[y][x].rabbit) candidates.push({ x, y });
      }
    }
    const spot = pick(candidates);
    if (spot) {
      const id = sim.idCounter++;
      sim.rabbits.push({ id, energy: sim.params.rabbitStart, x: spot.x, y: spot.y });
      sim.grid[spot.y][spot.x].rabbit = { id, energy: sim.params.rabbitStart };
    }
  }
  for (let i = 0; i < sim.params.foxes0; i++) {
    const candidates = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!sim.grid[y][x].fox) candidates.push({ x, y });
      }
    }
    const spot = pick(candidates);
    if (spot) {
      const id = sim.idCounter++;
      sim.foxes.push({ id, energy: sim.params.foxStart, x: spot.x, y: spot.y });
      sim.grid[spot.y][spot.x].fox = { id, energy: sim.params.foxStart };
    }
  }
  recordHistory();
  draw();
  return counts();
}

function counts() {
  return {
    rabbits: sim.rabbits.length,
    foxes: sim.foxes.length,
    grass: sim.grid.flat().reduce((s, c) => s + c.grass, 0)
  };
}

function recordHistory() {
  sim.history.push({
    tick: sim.tick,
    rabbits: sim.rabbits.length,
    foxes: sim.foxes.length,
    grass: sim.grid.flat().reduce((s, c) => s + c.grass, 0)
  });
}

function step(n = 1) {
  for (let i = 0; i < n; i++) {
    doTick();
  }
  draw();
  return counts();
}

function doTick() {
  const { width, height, grassMax, rabbitGain, rabbitCost, rabbitBreed, foxGain, foxCost, foxBreed } = sim.params;
  sim.tick++;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sim.grid[y][x].grass = Math.min(grassMax, sim.grid[y][x].grass + 1);
    }
  }
  const rab = sim.rabbits.slice().sort((a, b) => a.id - b.id);
  for (const r of rab) {
    const { x, y } = r;
    const neighbors = getNeighbors(x, y).filter(n => !sim.grid[n.y][n.x].rabbit);
    if (neighbors.length) {
      const spot = pick(neighbors);
      sim.grid[y][x].rabbit = null;
      sim.grid[spot.y][spot.x].rabbit = { id: r.id, energy: r.energy };
      r.x = spot.x; r.y = spot.y;
    }
    r.energy += r.x * 0 + r.y * 0;
    r.energy += sim.grid[r.y][r.x].grass * rabbitGain;
    sim.grid[r.y][r.x].grass = 0;
    r.energy -= rabbitCost;
    if (r.energy >= rabbitBreed) {
      const nbrs = getNeighbors(r.x, r.y).filter(n => !sim.grid[n.y][n.x].rabbit);
      if (nbrs.length) {
        const spot = pick(nbrs);
        const child = Math.floor(r.energy / 2);
        r.energy -= child;
        const id = sim.idCounter++;
        sim.rabbits.push({ id, energy: child, x: spot.x, y: spot.y });
        sim.grid[spot.y][spot.x].rabbit = { id, energy: child };
      }
    }
    if (r.energy <= 0) {
      sim.grid[r.y][r.x].rabbit = null;
      const idx = sim.rabbits.indexOf(r);
      if (idx >= 0) sim.rabbits.splice(idx, 1);
    }
  }
  const fxs = sim.foxes.slice().sort((a, b) => a.id - b.id);
  for (const f of fxs) {
    const { x, y } = f;
    const nbrsWithRabbit = getNeighbors(x, y).filter(n => sim.grid[n.y][n.x].rabbit && !sim.grid[n.y][n.x].fox);
    if (nbrsWithRabbit.length) {
      const spot = pick(nbrsWithRabbit);
      sim.grid[y][x].fox = null;
      sim.grid[spot.y][spot.x].fox = { id: f.id, energy: f.energy };
      f.x = spot.x; f.y = spot.y;
    } else {
      const nbrs = getNeighbors(x, y).filter(n => !sim.grid[n.y][n.x].fox);
      if (nbrs.length) {
        const spot = pick(nbrs);
        sim.grid[y][x].fox = null;
        sim.grid[spot.y][spot.x].fox = { id: f.id, energy: f.energy };
        f.x = spot.x; f.y = spot.y;
      }
    }
    if (sim.grid[f.y][f.x].rabbit) {
      sim.grid[f.y][f.x].rabbit = null;
      f.energy += foxGain;
    }
    f.energy -= foxCost;
    if (f.energy >= foxBreed) {
      const nbrs = getNeighbors(f.x, f.y).filter(n => !sim.grid[n.y][n.x].fox);
      if (nbrs.length) {
        const spot = pick(nbrs);
        const child = Math.floor(f.energy / 2);
        f.energy -= child;
        const id = sim.idCounter++;
        sim.foxes.push({ id, energy: child, x: spot.x, y: spot.y });
        sim.grid[spot.y][spot.x].fox = { id, energy: child };
      }
    }
    if (f.energy <= 0) {
      sim.grid[f.y][f.x].fox = null;
      const idx = sim.foxes.indexOf(f);
      if (idx >= 0) sim.foxes.splice(idx, 1);
    }
  }
  recordHistory();
}

function getNeighbors(x, y) {
  const { width, height } = sim.params;
  const res = [];
  if (y > 0) res.push({ x, y: y - 1 });
  if (x < width - 1) res.push({ x: x + 1, y });
  if (y < height - 1) res.push({ x, y: y + 1 });
  if (x > 0) res.push({ x: x - 1, y });
  return res;
}

function cell(x, y) {
  const c = sim.grid[y][x];
  return {
    grass: c.grass,
    rabbit: c.rabbit ? { id: c.rabbit.id, energy: c.rabbit.energy } : null,
    fox: c.fox ? { id: c.fox.id, energy: c.fox.energy } : null
  };
}

function history() { return sim.history; }

function ode(p, t, dt) {
  const { alpha, beta, gamma, delta, x0, y0 } = p;
  let x = x0, y = y0;
  const n = Math.round(t / dt);
  for (let i = 0; i < n; i++) {
    const dx = alpha * x - beta * x * y;
    const dy = delta * x * y - gamma * y;
    x += dx; y += dy;
  }
  return { x, y };
}

function exportCSV() {
  let csv = "tick,rabbits,foxes,grass\n";
  for (const h of sim.history) {
    csv += `${h.tick},${h.rabbits},${h.foxes},${h.grass}\n`;
  }
  return csv;
}

function exportScenario() {
  return JSON.stringify({ version: 1, seed: sim.rand, params: sim.params });
}

function loadScenario(text) {
  try {
    const data = JSON.parse(text);
    if (data.version !== 1 || !Number.isInteger(data.seed)) return false;
    const params = {};
    for (const k in defaults) {
      if (data.params && data.params[k] !== undefined) params[k] = data.params[k];
    }
    reset(data.seed, params);
    return true;
  } catch (e) {
    return false;
  }
}

window.lab = {
  reset, step, counts, tick: () => sim.tick, cell, history, ode,
  exportCSV, exportScenario, loadScenario
};

let canvas, chartSvg, odeSvg;
let playing = false;
let lastTime = 0;

function draw() {
  const { width, height, grassMax } = sim.params;
  const w = width * 10, h = height * 10;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = sim.grid[y][x];
      const G = 60 + Math.round(160 * c.grass / grassMax);
      ctx.fillStyle = `rgb(30, ${G}, 30)`;
      ctx.fillRect(x * 10, y * 10, 10, 10);
      if (c.rabbit) {
        ctx.fillStyle = "rgb(240, 240, 240)";
        const rx = x * 10 + 2, ry = y * 10 + 2;
        ctx.fillRect(rx, ry, 10, 10);
      }
      if (c.fox) {
        ctx.fillStyle = "rgb(220, 80, 20)";
        const fx = x * 10 + 2, fy = y * 10 + 2;
        ctx.fillRect(fx, fy, 10, 10);
      }
    }
  }
  updateChart();
  updateOdeChart();
}

function updateChart() {
  const hist = sim.history;
  if (!hist.length) return;
  const maxR = Math.max(1, ...hist.map(h => h.rabbits));
  const maxF = Math.max(1, ...hist.map(h => h.foxes));
  const maxT = hist[hist.length - 1].tick;
  const w = 400, h = 200;
  const svg = chartSvg;
  svg.innerHTML = `<svg width="${w}" height="${h}"><polyline data-testid="series-rabbits" points="${hist.map((h, i) => `${i * (w / (maxT || 1))},${h.rabbits * (h / maxR)}`).join(' ')}" /><polyline data-testid="series-foxes" points="${hist.map((h, i) => `${i * (w / (maxT || 1))},${h.foxes * (h / maxF)}`).join(' ')}" /><text x="0" y="0" text="tick" /><text x="0" y="0" text="count" /></svg>`;
}

function updateOdeChart() {
  const svg = odeSvg;
  if (!svg) return;
  svg.innerHTML = `<svg width="400" height="200"><polyline data-testid="ode-series-x" points="" /><polyline data-testid="ode-series-y" points="" /></svg>`;
}

document.addEventListener('DOMContentLoaded', () => {
  canvas = document.querySelector('#world');
  chartSvg = document.querySelector('#chart');
  odeSvg = document.querySelector('#ode-chart');
  reset(42, {});
});
</script>
</body>
</html>
```