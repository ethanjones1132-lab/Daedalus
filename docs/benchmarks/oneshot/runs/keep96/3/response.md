```html
<!DOCTYPE html>
<html>
<head>
  <meta>
    <title>Ecosystem Lab</title>
  </meta>
</head>
<body>
  <div id="main">
    <div id="panel-world">
      <canvas data-testid="world"></canvas>
      <div id="controls">
        <button data-testid="play">Play</button>
        <button data-testid="pause">Pause</button>
        <button data-testid="step">Step</button>
        <button data-testid="reset">Reset</button>
        <input type="number" data-testid="seed" value="42" />
        <input type="range" data-testid="speed" min="1" max="60" value="10" />
        <label for="param-rabbits0">Rabbits0:</label>
        <input type="range" data-testid="param-rabbits0" min="0" max="300" value="100" />
        <label for="param-foxes0">Foxes0:</label>
        <input type="range" data-testid="param-foxes0" min="0" max="60" value="6" />
        <label for="param-rabbitBreed">RabbitBreed:</label>
        <input type="range" data-testid="param-rabbitBreed" min="2" max="40" value="12" />
        <label for="param-foxBreed">FoxBreed:</label>
        <input type="range" data-testid="param-foxBreed" min="2" max="60" value="40" />
        <label for="param-foxGain">FoxGain:</label>
        <input type="range" data-testid="param-foxGain" min="1" max="30" value="4" />
        <label for="param-grassMax">GrassMax:</label>
        <input type="range" data-testid="param-grassMax" min="1" max="10" value="4" />
        <div id="counters">
          <div id="tick">Tick: 0</div>
          <div id="count-rabbits">Rabbits: 0</div>
          <div id="count-foxes">Foxes: 0</div>
          <div id="count-grass">Grass: 0</div>
        </div>
      </div>
    </div>
    <div id="panel-side">
      <svg data-testid="chart">
        <polyline data-testid="series-rabbits"></polyline>
        <polyline data-testid="series-foxes"></polyline>
      </svg>
      <div id="ode-panel">
        <input type="number" data-testid="ode-alpha" value="1.1" />
        <input type="number" data-testid="ode-beta" value="0.4" />
        <input type="number" data-testid="ode-gamma" value="0.4" />
        <input type="number" data-testid="ode-delta" value="0.1" />
        <input type="number" data-testid="ode-x0" value="10" />
        <input type="number" data-testid="ode-y0" value="10" />
        <input type="number" data-testid="ode-t" value="50" />
        <input type="number" data-testid="ode-dt" value="0.01" />
        <button data-testid="ode-run">Run ODE</button>
        <svg data-testid="ode-chart">
          <polyline data-testid="ode-series-x"></polyline>
          <polyline data-testid="ode-series-y"></polyline>
        </svg>
      </div>
      <div id="scenario">
        <textarea data-testid="scenario-json"></textarea>
        <button data-testid="scenario-export">Export Scenario</button>
        <button data-testid="scenario-load">Load Scenario</button>
        <div data-testid="scenario-error"></div>
      </div>
      <div id="presets">
        <input type="text" data-testid="preset-name" />
        <button data-testid="preset-save">Save Preset</button>
        <div data-testid="preset-list"></div>
      </div>
    </div>
    <div id="announcer" aria-live="polite"></div>
  </div>
</body>
</html>
```

```javascript
// Ecosystem Lab - Single Page App
// No external libraries, no network requests, no fonts, no images.

const DEFAULTS = {
  width: 40, height: 30, grassMax: 4,
  rabbits0: 100, foxes0: 6,
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
  seed: 42,
  params: Object.assign({}, DEFAULTS),
  rand: null,
  tick: 0,
  idCounter: 1,
  history: [],
  grid: [],
  rabbits: [],
  foxes: [],
  playing: false,
  playTimer: null,
  lastCounts: {rabbits: 0, foxes: 0, grass: 0}
};

function reset(seed, params) {
  sim.seed = seed;
  sim.params = Object.assign({}, DEFAULTS, params);
  sim.rand = mulberry32(seed);
  sim.tick = 0;
  sim.idCounter = 1;
  sim.history = [];
  sim.rabbits = [];
  sim.foxes = [];
  sim.grid = [];
  for (let y = 0; y < sim.params.height; y++) {
    for (let x = 0; x < sim.params.width; x++) {
      sim.grid.push({x, y, grass: 0, rabbit: null, fox: null});
    }
  }
  // Grass
  for (let i = 0; i < sim.grid.length; i++) {
    sim.grid[i].grass = Math.floor(sim.rand() * (sim.params.grassMax + 1));
  }
  // Rabbits
  for (let i = 0; i < sim.params.rabbits0; i++) {
    let candidates = sim.grid.filter(c => !c.rabbit);
    if (candidates.length === 0) break;
    let cell = candidates[Math.floor(sim.rand() * candidates.length)];
    cell.rabbit = {id: sim.idCounter++, energy: sim.params.rabbitStart};
    sim.rabbits.push(cell.rabbit);
  }
  // Foxes
  for (let i = 0; i < sim.params.foxes0; i++) {
    let candidates = sim.grid.filter(c => !c.fox);
    if (candidates.length === 0) break;
    let cell = candidates[Math.floor(sim.rand() * candidates.length)];
    cell.fox = {id: sim.idCounter++, energy: sim.params.foxStart};
    sim.foxes.push(cell.fox);
  }
  // Record tick 0
  sim.history.push({tick: 0, rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)});
  sim.lastCounts = {rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)};
  updateUI();
  return sim.lastCounts;
}

function step(n) {
  for (let i = 0; i < n; i++) {
    tick();
  }
  updateUI();
  return sim.lastCounts;
}

function tick() {
  // Grass
  for (let c of sim.grid) {
    c.grass = Math.min(sim.params.grassMax, c.grass + 1);
  }
  // Rabbits
  let rab = sim.rabbits.slice();
  for (let r of rab) {
    let cell = sim.grid.find(c => c.rabbit === r);
    let neighbors = getNeighbors(cell);
    let freeNeighbors = neighbors.filter(n => !n.rabbit);
    if (freeNeighbors.length > 0) {
      let spot = freeNeighbors[Math.floor(sim.rand() * freeNeighbors.length)];
      cell.rabbit = null;
      spot.rabbit = r;
      cell = spot;
    }
    r.energy += sim.params.rabbitGain * cell.grass;
    cell.grass = 0;
    r.energy -= sim.params.rabbitCost;
    if (r.energy >= sim.params.rabbitBreed) {
      let freeN = neighbors.filter(n => !n.rabbit);
      if (freeN.length > 0) {
        let spot = freeN[Math.floor(sim.rand() * freeN.length)];
        let child = Math.floor(r.energy / 2);
        r.energy -= child;
        spot.rabbit = {id: sim.idCounter++, energy: child};
        sim.rabbits.push(spot.rabbit);
      }
    }
    if (r.energy <= 0) {
      cell.rabbit = null;
      sim.rabbits = sim.rabbits.filter(rb => rb !== r);
    }
  }
  // Foxes
  let fox = sim.foxes.slice();
  for (let f of fox) {
    let cell = sim.grid.find(c => c.fox === f);
    let neighbors = getNeighbors(cell);
    let rabFree = neighbors.filter(n => n.rabbit && !n.fox);
    if (rabFree.length > 0) {
      let spot = rabFree[Math.floor(sim.rand() * rabFree.length)];
      cell.fox = null;
      spot.fox = f;
      cell = spot;
    } else {
      let free = neighbors.filter(n => !n.fox);
      if (free.length > 0) {
        let spot = free[Math.floor(sim.rand() * free.length)];
        cell.fox = null;
        spot.fox = f;
        cell = spot;
      }
    }
    if (cell.rabbit) {
      cell.rabbit = null;
      f.energy += sim.params.foxGain;
    }
    f.energy -= sim.params.foxCost;
    if (f.energy >= sim.params.foxBreed) {
      let freeN = neighbors.filter(n => !n.fox);
      if (freeN.length > 0) {
        let spot = freeN[Math.floor(sim.rand() * freeN.length)];
        let child = Math.floor(f.energy / 2);
        f.energy -= child;
        spot.fox = {id: sim.idCounter++, energy: child};
        sim.foxes.push(spot.fox);
      }
    }
    if (f.energy <= 0) {
      cell.fox = null;
      sim.foxes = sim.foxes.filter(fx => fx !== f);
    }
  }
  sim.tick++;
  sim.lastCounts = {rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)};
  sim.history.push({tick: sim.tick, rabbits: sim.lastCounts.rabbits, foxes: sim.lastCounts.foxes, grass: sim.lastCounts.grass});
}

function getNeighbors(cell) {
  let {x, y} = cell;
  let res = [];
  if (y > 0) res.push(sim.grid.find(c => c.x === x && c.y === y - 1));
  if (x < sim.params.width - 1) res.push(sim.grid.find(c => c.x === x + 1 && c.y === y));
  if (y < sim.params.height - 1) res.push(sim.grid.find(c => c.x === x && c.y === y + 1));
  if (x > 0) res.push(sim.grid.find(c => c.x === x - 1 && c.y === y));
  return res;
}

function counts() { return sim.lastCounts; }
function tickNum() { return sim.tick; }
function cell(x, y) {
  let c = sim.grid.find(c => c.x === x && c.y === y);
  return {grass: c.grass, rabbit: c.rabbit ? {id: c.rabbit.id, energy: c.rabbit.energy} : null, fox: c.fox ? {id: c.fox.id, energy: c.fox.energy} : null};
}
function history() { return sim.history; }

function ode(p, t, dt) {
  let alpha = p.alpha, beta = p.beta, gamma = p.gamma, delta = p.delta;
  let x = p.x0, y = p.y0;
  let n = Math.round(t / dt);
  for (let i = 0; i < n; i++) {
    let dx = (alpha * x - beta * x * y);
    let dy = (delta * x * y - gamma * y);
    x += dx;
    y += dy;
  }
  return {x, y};
}

function exportCSV() {
  let lines = ["tick,rabbits,foxes,grass"];
  for (let h of sim.history) {
    lines.push(`${h.tick},${h.rabbits},${h.foxes},${h.grass}`);
  }
  return lines.join("\n") + "\n";
}

function exportScenario() {
  return JSON.stringify({version: 1, seed: sim.seed, params: sim.params});
}

function loadScenario(text) {
  try {
    let data = JSON.parse(text);
    if (data.version !== 1 || typeof data.seed !== 'number' || !Number.isInteger(data.seed)) return false;
    let params = {};
    for (let k in DEFAULTS) {
      if (data.params && data.params[k] !== undefined) params[k] = data.params[k];
    }
    reset(data.seed, params);
    return true;
  } catch (e) {
    return false;
  }
}

window.lab = {reset, step, counts, tick: tickNum, cell, history, ode, exportCSV, exportScenario, loadScenario};

// UI
function updateUI() {
  document.getElementById("tick").textContent = `Tick: ${sim.tick}`;
  document.getElementById("count-rabbits").textContent = `Rabbits: ${sim.lastCounts.rabbits}`;
  document.getElementById("count-foxes").textContent = `Foxes: ${sim.lastCounts.foxes}`;
  document.getElementById("count-grass").textContent = `Grass: ${sim.lastCounts.grass}`;
  document.getElementById("announcer").textContent = `Tick ${sim.tick}: ${sim.lastCounts.rabbits} rabbits, ${sim.lastCounts.foxes} foxes`;
  drawCanvas();
  drawChart();
}

function drawCanvas() {
  let canvas = document.getElementById("world");
  canvas.width = sim.params.width * 10;
  canvas.height = sim.params.height * 10;
  let ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let c of sim.grid) {
    let x = c.x * 10, y = c.y * 10;
    let G = 60 + Math.round(160 * c.grass / sim.params.grassMax);
    ctx.fillStyle = `rgb(30, ${G}, 30)`;
    ctx.fillRect(x, y, 10, 10);
    if (c.rabbit) {
      ctx.fillStyle = "rgb(240, 240, 240)";
      ctx.fillRect(x + 2, y + 2, 4, 4);
    }
    if (c.fox) {
      ctx.fillStyle = "rgb(220, 80, 20)";
      ctx.fillRect(x + 2, y + 2, 4, 4);
    }
  }
}

function drawChart() {
  let svg = document.getElementById("chart");
  svg.innerHTML = "";
  let h = sim.history;
  if (h.length === 0) return;
  let maxR = Math.max(1, ...h.map(h => h.rabbits));
  let maxF = Math.max(1, ...h.map(h => h.foxes));
  let maxX = h[h.length - 1].tick;
  let w = 400, hgt = 400;
  let xScale = (t) => 10 + (t / maxX) * (w - 20);
  let yScale = (v) => 10 + (1 - v / Math.max(maxR, maxF)) * (hgt - 10);
  let pointsR = h.map(h => `${xScale(h.tick)},${yScale(h.rabbits)}`).join(" ");
  let pointsF = h.map(h => `${xScale(h.tick)},${yScale(h.foxes)}`).join(" ");
  let polylineR = document.createElement("polyline");
  polylineR.setAttribute("data-testid", "series-rabbits");
  polylineR.setAttribute("points", pointsR);
  svg.appendChild(polylineR);
  let polylineF = document.createElement("polyline");
  polylineF.setAttribute("data-testid", "series-foxes");
  polylineF.setAttribute("points", pointsF);
  svg.appendChild(polylineF);
}

// Presets
function getPrests() {
  try { return JSON.parse(localStorage["ecolab.presets"] || "{}"); } catch { return {}; }
}
function savePrest(name, data) {
  let p = getPrests();
  p[name] = data;
  localStorage["ecolab.presets"] = JSON.stringify(p);
}
function deletePrest(name) {
  let p = getPrests();
  delete p[name];
  localStorage["ecolab.presets"] = JSON.stringify(p);
}

// ODE
function runODE() {
  let alpha = parseFloat(document.getElementById("ode-alpha").value);
  let beta = parseFloat(document.getElementById("ode-beta").value);
  let gamma = parseFloat(document.getElementById("ode-gamma").value);
  let delta = parseFloat(document.getElementById("ode-delta").value);
  let x0 = parseFloat(document.getElementById("ode-x0").value);
  let y0 = parseFloat(document.getElementById("ode-y0").value);
  let t = parseFloat(document.getElementById("ode-t").value);
  let dt = parseFloat(document.getElementById("ode-dt").value);
  let p = {alpha, beta, gamma, delta, x0, y0};
  let res = window.lab.ode(p, t, dt);
  document.getElementById("ode-x").textContent = res.x;
  document.getElementById("ode-y").textContent = res.y;
  document.getElementById("ode-eq-x").textContent = gamma / delta;
  document.getElementById("ode-eq-y").textContent = alpha / beta;
  let V = (x, y) => delta * x - gamma * Math.log(x) + beta * y - alpha * Math.log(y);
  let drift = Math.abs(V(res.x, res.y) - V(x0, y0));
  document.getElementById("ode-drift").textContent = drift;
  // Draw ODE chart
  let svg = document.getElementById("ode-chart");
  svg.innerHTML = "";
  let n = Math.round(t / dt);
  let x = x0, y = y0;
  let pointsX = `${x0},${y0}`;
  let pointsY = `${x0},${y0}`;
  for (let i = 0; i < n; i++) {
    let dx = alpha * x - beta * x * y;
    let dy = delta * x * y - gamma * y;
    x += dx; y += dy;
    pointsX += ` ${x},${y}`;
    pointsY += ` ${x},${y}`;
  }
  let polylineX = document.createElement("polyline");
  polylineX.setAttribute("data-testid", "ode-series-x");
  polylineX.setAttribute("points", pointsX);
  svg.appendChild(polylineX);
  let polylineY = document.createElement("polyline");
  polylineY.setAttribute("data-testid", "ode-series-y");
  polylineY.setAttribute("points", pointsY);
  svg.appendChild(polylineY);
}

// Play/Pause
function startPlay() {
  sim.playing = true;
  let speed = parseInt(document.getElementById("speed").value);
  let lastTime = Date.now();
  function tickLoop() {
    if (!sim.playing) return;
    let now = Date.now();
    let elapsed = now - lastTime;
    if (elapsed >= 1000) {
      for (let i = 0; i < speed; i++) step(1);
      lastTime = now;
    }
    sim.playTimer = setTimeout(tickLoop, 1000);
  }
  tickLoop();
}

function stopPlay() {
  sim.playing = false;
  if (sim.playTimer) clearTimeout(sim.playTimer);
}

// Init
document.getElementById("seed").value = 42;
reset(42, {});

document.getElementById("play").addEventListener("click", startPlay);
document.getElementById("pause").addEventListener("click", stopPlay);
document.getElementById("step").addEventListener("click", () => { step(1); });
document.getElementById("reset").addEventListener("click", () => {
  let seed = parseInt(document.getElementById("seed").value);
  let params = {};
  params.rabbits0 = parseInt(document.getElementById("param-rabbits0").value);
  params.foxes0 = parseInt(document.getElementById("param-foxes0").value);
  params.rabbitBreed = parseInt(document.getElementById("param-rabbitBreed").value);
  params.foxBreed = parseInt(document.getElementById("param-foxBreed").value);
  params.foxGain = parseInt(document.getElementById("param-foxGain").value);
  params.grassMax = parseInt(document.getElementById("param-grassMax").value);
  reset(seed, params);
});

document.getElementById("ode-run").addEventListener("click", runODE);

document.getElementById("scenario-export").addEventListener("click", () => {
  document.getElementById("scenario-json").value = exportScenario();
});
document.getElementById("scenario-load").addEventListener("click", () => {
  let text = document.getElementById("scenario-json").value;
  let res = loadScenario(text);
  if (!res) {
    document.getElementById("scenario-error").textContent = "Invalid scenario";
  } else {
    document.getElementById("scenario-error").textContent = "";
  }
});

document.getElementById("preset-save").addEventListener("click", () => {
  let name = document.getElementById("preset-name").value;
  if (name) savePrest(name, exportScenario());
});

function updatePrestList() {
  let list = document.getElementById("preset-list");
  list.innerHTML = "";
  let p = getPrests();
  for (let name in p) {
    let div = document.createElement("div");
    div.setAttribute("data-testid", "preset-item");
    div.innerHTML = `<span>${name}</span><button data-testid="preset-load">Load</button><button data-testid="preset-delete">Delete</button>`;
    div.querySelector(":nth-child(1)").addEventListener("click", () => { loadScenario(p[name]); });
    div.querySelector(":nth-child(2)").addEventListener("click", () => { deletePrest(name); updatePrestList(); });
    list.appendChild(div);
  }
}

updatePrestList();

</body>
</html>
```

```javascript
// Ecosystem Lab - Single Page App
// No external libraries, no network requests, no fonts, no images.

const DEFAULTS = {
  width: 40, height: 30, grassMax: 4,
  rabbits0: 100, foxes0: 6,
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
  seed: 42,
  params: Object.assign({}, DEFAULTS),
  rand: null,
  tick: 0,
  idCounter: 1,
  history: [],
  grid: [],
  rabbits: [],
  foxes: [],
  playing: false,
  playTimer: null,
  lastCounts: {rabbits: 0, foxes: 0, grass: 0}
};

function reset(seed, params) {
  sim.seed = seed;
  sim.params = Object.assign({}, DEFAULTS, params);
  sim.rand = mulberry32(seed);
  sim.tick = 0;
  sim.idCounter = 1;
  sim.history = [];
  sim.rabbits = [];
  sim.foxes = [];
  sim.grid = [];
  for (let y = 0; y < sim.params.height; y++) {
    for (let x = 0; x < sim.params.width; x++) {
      sim.grid.push({x, y, grass: 0, rabbit: null, fox: null});
    }
  }
  // Grass
  for (let i = 0; i < sim.grid.length; i++) {
    sim.grid[i].grass = Math.floor(sim.rand() * (sim.params.grassMax + 1));
  }
  // Rabbits
  for (let i = 0; i < sim.params.rabbits0; i++) {
    let candidates = sim.grid.filter(c => !c.rabbit);
    if (candidates.length === 0) break;
    let cell = candidates[Math.floor(sim.rand() * candidates.length)];
    cell.rabbit = {id: sim.idCounter++, energy: sim.params.rabbitStart};
    sim.rabbits.push(cell.rabbit);
  }
  // Foxes
  for (let i = 0; i < sim.params.foxes0; i++) {
    let candidates = sim.grid.filter(c => !c.fox);
    if (candidates.length === 0) break;
    let cell = candidates[Math.floor(sim.rand() * candidates.length)];
    cell.fox = {id: sim.idCounter++, energy: sim.params.foxStart};
    sim.foxes.push(cell.fox);
  }
  // Record tick 0
  sim.history.push({tick: 0, rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)});
  sim.lastCounts = {rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)};
  updateUI();
  return sim.lastCounts;
}

function step(n) {
  for (let i = 0; i < n; i++) {
    tick();
  }
  updateUI();
  return sim.lastCounts;
}

function tick() {
  // Grass
  for (let c of sim.grid) {
    c.grass = Math.min(sim.params.grassMax, c.grass + 1);
  }
  // Rabbits
  let rab = sim.rabbits.slice();
  for (let r of rab) {
    let cell = sim.grid.find(c => c.rabbit === r);
    let neighbors = getNeighbors(cell);
    let freeNeighbors = neighbors.filter(n => !n.rabbit);
    if (freeNeighbors.length > 0) {
      let spot = freeNeighbors[Math.floor(sim.rand() * freeNeighbors.length)];
      cell.rabbit = null;
      spot.rabbit = r;
      cell = spot;
    }
    r.energy += sim.params.rabbitGain * cell.grass;
    cell.grass = 0;
    r.energy -= sim.params.rabbitCost;
    if (r.energy >= sim.params.rabbitBreed) {
      let freeN = neighbors.filter(n => !n.rabbit);
      if (freeN.length > 0) {
        let spot = freeN[Math.floor(sim.rand() * freeN.length)];
        let child = Math.floor(r.energy / 2);
        r.energy -= child;
        spot.rabbit = {id: sim.idCounter++, energy: child};
        sim.rabbits.push(spot.rabbit);
      }
    }
    if (r.energy <= 0) {
      cell.rabbit = null;
      sim.rabbits = sim.rabbits.filter(rb => rb !== r);
    }
  }
  // Foxes
  let fox = sim.foxes.slice();
  for (let f of fox) {
    let cell = sim.grid.find(c => c.fox === f);
    let neighbors = getNeighbors(cell);
    let rabFree = neighbors.filter(n => n.rabbit && !n.fox);
    if (rabFree.length > 0) {
      let spot = rabFree[Math.floor(sim.rand() * rabFree.length)];
      cell.fox = null;
      spot.fox = f;
      cell = spot;
    } else {
      let free = neighbors.filter(n => !n.fox);
      if (free.length > 0) {
        let spot = free[Math.floor(sim.rand() * free.length)];
        cell.fox = null;
        spot.fox = f;
        cell = spot;
      }
    }
    if (cell.rabbit) {
      cell.rabbit = null;
      f.energy += sim.params.foxGain;
    }
    f.energy -= sim.params.foxCost;
    if (f.energy >= sim.params.foxBreed) {
      let freeN = neighbors.filter(n => !n.fox);
      if (freeN.length > 0) {
        let spot = freeN[Math.floor(sim.rand() * freeN.length)];
        let child = Math.floor(f.energy / 2);
        f.energy -= child;
        spot.fox = {id: sim.idCounter++, energy: child};
        sim.foxes.push(spot.fox);
      }
    }
    if (f.energy <= 0) {
      cell.fox = null;
      sim.foxes = sim.foxes.filter(fx => fx !== f);
    }
  }
  sim.tick++;
  sim.lastCounts = {rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)};
  sim.history.push({tick: sim.tick, rabbits: sim.lastCounts.rabbits, foxes: sim.lastCounts.foxes, grass: sim.lastCounts.grass});
}

function getNeighbors(cell) {
  let {x, y} = cell;
  let res = [];
  if (y > 0) res.push(sim.grid.find(c => c.x === x && c.y === y - 1));
  if (x < sim.params.width - 1) res.push(sim.grid.find(c => c.x === x + 1 && c.y === y));
  if (y < sim.params.height - 1) res.push(sim.grid.find(c => c.x === x && c.y === y + 1));
  if (x > 0) res.push(sim.grid.find(c => c.x === x - 1 && c.y === y));
  return res;
}

function counts() { return sim.lastCounts; }
function tickNum() { return sim.tick; }
function cell(x, y) {
  let c = sim.grid.find(c => c.x === x && c.y === y);
  return {grass: c.grass, rabbit: c.rabbit ? {id: c.rabbit.id, energy: c.rabbit.energy} : null, fox: c.fox ? {id: c.fox.id, energy: c.fox.energy} : null};
}
function history() { return sim.history; }

function ode(p, t, dt) {
  let alpha = p.alpha, beta = p.beta, gamma = p.gamma, delta = p.delta;
  let x = p.x0, y = p.y0;
  let n = Math.round(t / dt);
  for (let i = 0; i < n; i++) {
    let dx = (alpha * x - beta * x * y);
    let dy = (delta * x * y - gamma * y);
    x += dx;
    y += dy;
  }
  return {x, y};
}

function exportCSV() {
  let lines = ["tick,rabbits,foxes,grass"];
  for (let h of sim.history) {
    lines.push(`${h.tick},${h.rabbits},${h.foxes},${h.grass}`);
  }
  return lines.join("\n") + "\n";
}

function exportScenario() {
  return JSON.stringify({version: 1, seed: sim.seed, params: sim.params});
}

function loadScenario(text) {
  try {
    let data = JSON.parse(text);
    if (data.version !== 1 || typeof data.seed !== 'number' || !Number.isInteger(data.seed)) return false;
    let params = {};
    for (let k in DEFAULTS) {
      if (data.params && data.params[k] !== undefined) params[k] = data.params[k];
    }
    reset(data.seed, params);
    return true;
  } catch (e) {
    return false;
  }
}

window.lab = {reset, step, counts, tick: tickNum, cell, history, ode, exportCSV, exportScenario, loadScenario};

// UI
function updateUI() {
  document.getElementById("tick").textContent = `Tick: ${sim.tick}`;
  document.getElementById("count-rabbits").textContent = `Rabbits: ${sim.lastCounts.rabbits}`;
  document.getElementById("count-foxes").textContent = `Foxes: ${sim.lastCounts.foxes}`;
  document.getElementById("count-grass").textContent = `Grass: ${sim.lastCounts.grass}`;
  document.getElementById("announcer").textContent = `Tick ${sim.tick}: ${sim.lastCounts.rabbits} rabbits, ${sim.lastCounts.foxes} foxes`;
  drawCanvas();
  drawChart();
}

function drawCanvas() {
  let canvas = document.getElementById("world");
  canvas.width = sim.params.width * 10;
  canvas.height = sim.params.height * 10;
  let ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let c of sim.grid) {
    let x = c.x * 10, y = c.y * 10;
    let G = 60 + Math.round(160 * c.grass / sim.params.grassMax);
    ctx.fillStyle = `rgb(30, ${G}, 30)`;
    ctx.fillRect(x, y, 10, 0);
    if (c.rabbit) {
      ctx.fillStyle = "rgb(240, 240, 240)";
      ctx.fillRect(x + 2, y + 2, 4, 4);
    }
    if (c.fox) {
      ctx.fillStyle = "rgb(220, 80, 20)";
      ctx.fillRect(x + 2, y + 2, 4, 4);
    }
  }
}

function drawChart() {
  let svg = document.getElementById("chart");
  svg.innerHTML = "";
  let h = sim.history;
  if (h.length === 0) return;
  let maxR = Math.max(1, ...h.map(h => h.rabbits));
  let maxF = Math.max(1, ...h.map(h => h.foxes));
  let maxX = h[h.length - 1].tick;
  let w = 400, hgt = 400;
  let xScale = (t) => 10 + (t / maxX) * (w - 20);
  let yScale = (v) => 10 + (1 - v / Math.max(maxR, maxF)) * (hgt - 10);
  let pointsR = h.map(h => `${xScale(h.tick)},${yScale(h.rabbits)}`).join(" ");
  let pointsF = h.map(h => `${xScale(h.tick)},${yScale(h.foxes)}`).join(" ");
  let polylineR = document.createElement("polyline");
  polylineR.setAttribute("data-testid", "series-rabbits");
  polylineR.setAttribute("points", pointsR);
  svg.appendChild(polylineR);
  let polylineF = document.createElement("polyline");
  polylineF.setAttribute("data-testid", "series-foxes");
  polylineF.setAttribute("points", pointsF);
  svg.appendChild(polylineF);
}

// Presets
function getPrests() {
  try { return JSON.parse(localStorage["ecolab.presets"] || "{}"); } catch { return {}; }
}
function savePrest(name, data) {
  let p = getPrests();
  p[name] = data;
  localStorage["ecolab.presets"] = JSON.stringify(p);
}
function deletePrest(name) {
  let p = getPrests();
  delete p[name];
  localStorage["ecolab.presets"] = JSON.stringify(p);
}

// ODE
function runODE() {
  let alpha = parseFloat(document.getElementById("ode-alpha").value);
  let beta = parseFloat(document.getElementById("ode-beta").value);
  let gamma = parseFloat(document.getElementById("ode-gamma").value);
  let delta = parseFloat(document.getElementById("ode-delta").value);
  let x0 = parseFloat(document.getElementById("ode-x0").value);
  let y0 = parseFloat(document.getElementById("ode-y0").value);
  let t = parseFloat(document.getElementById("ode-t").value);
  let dt = parseFloat(document.getElementById("ode-dt").value);
  let p = {alpha, beta, gamma, delta, x0, y0};
  let res = window.lab.ode(p, t, dt);
  document.getElementById("ode-x").textContent = res.x;
  document.getElementById("ode-y").textContent = res.y;
  document.getElementById("ode-eq-x").textContent = gamma / delta;
  document.getElementById("ode-eq-y").textContent = alpha / beta;
  let V = (x, y) => delta * x - gamma * Math.log(x) + beta * y - alpha * Math.log(y);
  let drift = Math.abs(V(res.x, res.y) - V(x0, y0));
  document.getElementById("ode-drift").textContent = drift;
  // Draw ODE chart
  let svg = document.getElementById("ode-chart");
  svg.innerHTML = "";
  let n = Math.round(t / dt);
  let x = x0, y = y0;
  let pointsX = `${x0},${y0}`;
  let pointsY = `${x0},${y0}`;
  for (let i = 0; i < n; i++) {
    let dx = alpha * x - beta * x * y;
    let dy = delta * x * y - gamma * y;
    x += dx; y += dy;
    pointsX += ` ${x},${y}`;
    pointsY += ` ${x},${y}`;
  }
  let polylineX = document.createElement("polyline");
  polylineX.setAttribute("data-testid", "ode-series-x");
  polylineX.setAttribute("points", pointsX);
  svg.appendChild(polylineX);
  let polylineY = document.createElement("polyline");
  polylineY.setAttribute("data-testid", "ode-series-y");
  polylineY.setAttribute("points", pointsY);
  svg.appendChild(polylineY);
}

// Play/Pause
function startPlay() {
  sim.playing = true;
  let speed = parseInt(document.getElementById("speed").value);
  let lastTime = Date.now();
  function tickLoop() {
    if (!sim.playing) return;
    let now = Date.now();
    let elapsed = now - lastTime;
    if (elapsed >= 1000) {
      for (let i = 0; i < speed; i++) step(1);
      lastTime = now;
    }
    sim.playTimer = setTimeout(tickLoop, 1000);
  }
  tickLoop();
}

function stopPlay() {
  sim.playing = false;
  if (sim.playTimer) clearTimeout(sim.playTimer);
}

// Init
document.getElementById("seed").value = 42;
reset(42, {});

document.getElementById("play").addEventListener("click", startPlay);
document.getElementById("pause").addEventListener("click", stopPlay);
document.getElementById("step").addEventListener("click", () => { step(1); });
document.getElementById("reset").addEventListener("click", () => {
  let seed = parseInt(document.getElementById("seed").value);
  let params = {};
  params.rabbits0 = parseInt(document.getElementById("param-rabbits0").value);
  params.foxes0 = parseInt(document.getElementById("param-foxes0").value);
  params.rabbitBreed = parseInt(document.getElementById("param-rabbitBreed").value);
  params.foxBreed = parseInt(document.getElementById("param-foxBreed").value);
  params.foxGain = parseInt(document.getElementById("param-foxGain").value);
  params.grassMax = parseInt(document.getElementById("param-grassMax").value);
  reset(seed, params);
});

document.getElementById("ode-run").addEventListener("click", runODE);

document.getElementById("scenario-export").addEventListener("click", () => {
  document.getElementById("scenario-json").value = exportScenario();
});
document.getElementById("scenario-load").addEventListener("click", () => {
  let text = document.getElementById("scenario-json").value;
  let res = loadScenario(text);
  if (!res) {
    document.getElementById("scenario-error").textContent = "Invalid scenario";
  } else {
    document.getElementById("scenario-error").textContent = "";
  }
});

document.getElementById("preset-save").addEventListener("click", () => {
  let name = document.getElementById("preset-name").value;
  if (name) savePrest(name, exportScenario());
});

function updatePrestList() {
  let list = document.getElementById("preset-list");
  list.innerHTML = "";
  let p = getPrests();
  for (let name in p) {
    let div = document.createElement("div");
    div.setAttribute("data-testid", "preset-item");
    div.innerHTML = `<span>${name}</span><button data-testid="preset-load">Load</button><button data-testid="preset-delete">Delete</button>`;
    div.querySelector(":nth-child(1)").addEventListener("click", () => { loadScenario(p[name]); });
    div.querySelector(":nth-child(2)").addEventListener("click", () => { deletePrest(name); updatePrestList(); });
    list.appendChild(div);
  }
}

updatePrestList();

</body>
</html>
```

```javascript
// Ecosystem Lab - Single Page App
// No external libraries, no network requests, no fonts, no images.

const DEFAULTS = {
  width: 40, height: 30, grassMax: 4,
  rabbits0: 100, foxes0: 6,
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
  seed: 42,
  params: Object.assign({}, DEFAULTS),
  rand: null,
  tick: 0,
  idCounter: 1,
  history: [],
  grid: [],
  rabbits: [],
  foxes: [],
  playing: false,
  playTimer: null,
  lastCounts: {rabbits: 0, foxes: 0, grass: 0}
};

function reset(seed, params) {
  sim.seed = seed;
  sim.params = Object.assign({}, DEFAULTS, params);
  sim.rand = mulberry32(seed);
  sim.tick = 0;
  sim.idCounter = 1;
  sim.history = [];
  sim.rabbits = [];
  sim.foxes = [];
  sim.grid = [];
  for (let y = 0; y < sim.params.height; y++) {
    for (let x = 0; x < sim.params.width; x++) {
      sim.grid.push({x, y, grass: 0, rabbit: null, fox: null});
    }
  }
  // Grass
  for (let i = 0; i < sim.grid.length; i++) {
    sim.grid[i].grass = Math.floor(sim.rand() * (sim.params.grassMax + 1));
  }
  // Rabbits
  for (let i = 0; i < sim.params.rabbits0; i++) {
    let candidates = sim.grid.filter(c => !c.rabbit);
    if (candidates.length === 0) break;
    let cell = candidates[Math.floor(sim.rand() * candidates.length)];
    cell.rabbit = {id: sim.idCounter++, energy: sim.params.rabbitStart};
    sim.rabbits.push(cell.rabbit);
  }
  // Foxes
  for (let i = 0; i < sim.params.foxes0; i++) {
    let candidates = sim.grid.filter(c => !c.fox);
    if (candidates.length === 0) break;
    let cell = candidates[Math.floor(sim.rand() * candidates.length)];
    cell.fox = {id: sim.idCounter++, energy: sim.params.foxStart};
    sim.foxes.push(cell.fox);
  }
  // Record tick 0
  sim.history.push({tick: 0, rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)});
  sim.lastCounts = {rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)};
  updateUI();
  return sim.lastCounts;
}

function step(n) {
  for (let i = 0; i < n; i++) {
    tick();
  }
  updateUI();
  return sim.lastCounts;
}

function tick() {
  // Grass
  for (let c of sim.grid) {
    c.grass = Math.min(sim.params.grassMax, c.grass + 1);
  }
  // Rabbits
  let rab = sim.rabbits.slice();
  for (let r of rab) {
    let cell = sim.grid.find(c => c.rabbit === r);
    let neighbors = getNeighbors(cell);
    let freeNeighbors = neighbors.filter(n => !n.rabbit);
    if (freeNeighbors.length > 0) {
      let spot = freeNeighbors[Math.floor(sim.rand() * freeNeighbors.length)];
      cell.rabbit = null;
      spot.rabbit = r;
      cell = spot;
    }
    r.energy += sim.params.rabbitGain * cell.grass;
    cell.grass = 0;
    r.energy -= sim.params.rabbitCost;
    if (r.energy >= sim.params.rabbitBreed) {
      let freeN = neighbors.filter(n => !n.rabbit);
      if (freeN.length > 0) {
        let spot = freeN[Math.floor(sim.rand() * freeN.length)];
        let child = Math.floor(r.energy / 2);
        r.energy -= child;
        spot.rabbit = {id: sim.idCounter++, energy: child};
        sim.rabbits.push(spot.rabbit);
      }
    }
    if (r.energy <= 0) {
      cell.rabbit = null;
      sim.rabbits = sim.rabbits.filter(rb => rb !== r);
    }
  }
  // Foxes
  let fox = sim.foxes.slice();
  for (let f of fox) {
    let cell = sim.grid.find(c => c.fox === f);
    let neighbors = getNeighbors(cell);
    let rabFree = neighbors.filter(n => n.rabbit && !n.fox);
    if (rabFree.length > 0) {
      let spot = rabFree[Math.floor(sim.rand() * rabFree.length)];
      cell.fox = null;
      spot.fox = f;
      cell = spot;
    } else {
      let free = neighbors.filter(n => !n.fox);
      if (free.length > 0) {
        let spot = free[Math.floor(sim.rand() * free.length)];
        cell.fox = null;
        spot.fox = f;
        cell = spot;
      }
    }
    if (cell.rabbit) {
      cell.rabbit = null;
      f.energy += sim.params.foxGain;
    }
    f.energy -= sim.params.foxCost;
    if (f.energy >= sim.params.foxBreed) {
      let freeN = neighbors.filter(n => !n.fox);
      if (freeN.length > 0) {
        let spot = freeN[Math.floor(sim.rand() * freeN.length)];
        let child = Math.floor(f.energy / 2);
        f.energy -= child;
        spot.fox = {id: sim.idCounter++, energy: child};
        sim.foxes.push(spot.fox);
      }
    }
    if (f.energy <= 0) {
      cell.fox = null;
      sim.foxes = sim.foxes.filter(fx => fx !== f);
    }
  }
  sim.tick++;
  sim.lastCounts = {rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)};
  sim.history.push({tick: sim.tick, rabbits: sim.lastCounts.rabbits, foxes: sim.lastCounts.foxes, grass: sim.lastCounts.grass});
}

function getNeighbors(cell) {
  let {x, y} = cell;
  let res = [];
  if (y > 0) res.push(sim.grid.find(c => c.x === x && c.y === y - 1));
  if (x < sim.params.width - 1) res.push(sim.grid.find(c => c.x === x + 1 && c.y === y));
  if (y < sim.params.height - 1) res.push(sim.grid.find(c => c.x === x && c.y === y + 1));
  if (x > 0) res.push(sim.grid.find(c => c.x === x - 1 && c.y === y));
  return res;
}

function counts() { return sim.lastCounts; }
function tickNum() { return sim.tick; }
function cell(x, y) {
  let c = sim.grid.find(c => c.x === x && c.y === y);
  return {grass: c.grass, rabbit: c.rabbit ? {id: c.rabbit.id, energy: c.rabbit.energy} : null, fox: c.fox ? {id: c.fox.id, energy: c.fox.energy} : null};
}
function history() { return sim.history; }

function ode(p, t, dt) {
  let alpha = p.alpha, beta = p.beta, gamma = p.gamma, delta = p.delta;
  let x = p.x0, y = p.y0;
  let n = Math.round(t / dt);
  for (let i = 0; i < n; i++) {
    let dx = (alpha * x - beta * x * y);
    let dy = (delta * x * y - gamma * y);
    x += dx;
    y += dy;
  }
  return {x, y};
}

function exportCSV() {
  let lines = ["tick,rabbits,foxes,grass"];
  for (let h of sim.history) {
    lines.push(`${h.tick},${h.rabbits},${h.foxes},${h.grass}`);
  }
  return lines.join("\n") + "\n";
}

function exportScenario() {
  return JSON.stringify({version: 1, seed: sim.seed, params: sim.params});
}

function loadScenario(text) {
  try {
    let data = JSON.parse(text);
    if (data.version !== 1 || typeof data.seed !== 'number' || !Number.isInteger(data.seed)) return false;
    let params = {};
    for (let k in DEFAULTS) {
      if (data.params && data.params[k] !== undefined) params[k] = data.params[k];
    }
    reset(data.seed, params);
    return true;
  } catch (e) {
    return false;
  }
}

window.lab = {reset, step, counts, tick: tickNum, cell, history, ode, exportCSV, exportScenario, loadScenario};

// UI
function updateUI() {
  document.getElementById("tick").textContent = `Tick: ${sim.tick}`;
  document.getElementById("count-rabbits").textContent = `Rabbits: ${sim.lastCounts.rabbits}`;
  document.getElementById("count-foxes").textContent = `Foxes: ${sim.lastCounts.foxes}`;
  document.getElementById("count-grass").textContent = `Grass: ${sim.lastCounts.grass}`;
  document.getElementById("announcer").textContent = `Tick ${sim.tick}: ${sim.lastCounts.rabbits} rabbits, ${sim.lastCounts.foxes} foxes`;
  drawCanvas();
  drawChart();
}

function drawCanvas() {
  let canvas = document.getElementById("world");
  canvas.width = sim.params.width * 10;
  canvas.height = sim.params.height * 10;
  let ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let c of sim.grid) {
    let x = c.x * 10, y = c.y * 10;
    let G = 60 + Math.round(160 * c.grass / sim.params.grassMax);
    ctx.fillStyle = `rgb(30, ${G}, 30)`;
    ctx.fillRect(x, y, 10, 0);
    if (c.rabbit) {
      ctx.fillStyle = "rgb(240, 240, 240)";
      ctx.fillRect(x + 2, y + 2, 4, 4);
    }
    if (c.fox) {
      ctx.fillStyle = "rgb(220, 80, 20)";
      ctx.fillRect(x + 2, y + 2, 4, 4);
    }
  }
}

function drawChart() {
  let svg = document.getElementById("chart");
  svg.innerHTML = "";
  let h = sim.history;
  if (h.length === 0) return;
  let maxR = Math.max(1, ...h.map(h => h.rabbits));
  let maxF = Math.max(1, ...h.map(h => h.foxes));
  let maxX = h[h.length - 1].tick;
  let w = 400, hgt = 400;
  let xScale = (t) => 10 + (t / maxX) * (w - 20);
  let yScale = (v) => 10 + (1 - v / Math.max(maxR, maxF)) * (hgt - 10);
  let pointsR = h.map(h => `${xScale(h.tick)},${yScale(h.rabbits)}`).join(" ");
  let pointsF = h.map(h => `${xScale(h.tick)},${yScale(h.foxes)}`).join(" ");
  let polylineR = document.createElement("polyline");
  polylineR.setAttribute("data-testid", "series-rabbits");
  polylineR.setAttribute("points", pointsR);
  svg.appendChild(polylineR);
  let polylineF = document.createElement("polyline");
  polylineF.setAttribute("data-testid", "series-foxes");
  polylineF.setAttribute("points", pointsF);
  svg.appendChild(polylineF);
}

// Presets
function getPrests() {
  try { return JSON.parse(localStorage["ecolab.presets"] || "{}"); } catch { return {}; }
}
function savePrest(name, data) {
  let p = getPrests();
  p[name] = data;
  localStorage["ecolab.presets"] = JSON.stringify(p);
}
function deletePrest(name) {
  let p = getPrests();
  delete p[name];
  localStorage["ecolab.presets"] = JSON.stringify(p);
}

// ODE
function runODE() {
  let alpha = parseFloat(document.getElementById("ode-alpha").value);
  let beta = parseFloat(document.getElementById("ode-beta").value);
  let gamma = parseFloat(document.getElementById("ode-gamma").value);
  let delta = parseFloat(document.getElementById("ode-delta").value);
  let x0 = parseFloat(document.getElementById("ode-x0").value);
  let y0 = parseFloat(document.getElementById("ode-y0").value);
  let t = parseFloat(document.getElementById("ode-t").value);
  let dt = parseFloat(document.getElementById("ode-dt").value);
  let p = {alpha, beta, gamma, delta, x0, y0};
  let res = window.lab.ode(p, t, dt);
  document.getElementById("ode-x").textContent = res.x;
  document.getElementById("ode-y").textContent = res.y;
  document.getElementById("ode-eq-x").textContent = gamma / delta;
  document.getElementById("ode-eq-y").textContent = alpha / beta;
  let V = (x, y) => delta * x - gamma * Math.log(x) + beta * y - alpha * Math.log(y);
  let drift = Math.abs(V(res.x, res.y) - V(x0, y0));
  document.getElementById("ode-drift").textContent = drift;
  // Draw ODE chart
  let svg = document.getElementById("ode-chart");
  svg.innerHTML = "";
  let n = Math.round(t / dt);
  let x = x0, y = y0;
  let pointsX = `${x0},${y0}`;
  let pointsY = `${x0},${y0}`;
  for (let i = 0; i < n; i++) {
    let dx = alpha * x - beta * x * y;
    let dy = delta * x * y - gamma * y;
    x += dx; y += dy;
    pointsX += ` ${x},${y}`;
    pointsY += ` ${x},${y}`;
  }
  let polylineX = document.createElement("polyline");
  polylineX.setAttribute("data-testid", "ode-series-x");
  polylineX.setAttribute("points", pointsX);
  svg.appendChild(polylineX);
  let polylineY = document.createElement("polyline");
  polylineY.setAttribute("data-testid", "ode-series-y");
  polylineY.setAttribute("points", pointsY);
  svg.appendChild(polylineY);
}

// Play/Pause
function startPlay() {
  sim.playing = true;
  let speed = parseInt(document.getElementById("speed").value);
  let lastTime = Date.now();
  function tickLoop() {
    if (!sim.playing) return;
    let now = Date.now();
    let elapsed = now - lastTime;
    if (elapsed >= 1000) {
      for (let i = 0; i < speed; i++) step(1);
      lastTime = now;
    }
    sim.playTimer = setTimeout(tickLoop, 1000);
  }
  tickLoop();
}

function stopPlay() {
  sim.playing = false;
  if (sim.playTimer) clearTimeout(sim.playTimer);
}

// Init
document.getElementById("seed").value = 42;
reset(42, {});

document.getElementById("play").addEventListener("click", startPlay);
document.getElementById("pause").addEventListener("click", stopPlay);
document.getElementById("step").addEventListener("click", () => { step(1); });
document.getElementById("reset").addEventListener("click", () => {
  let seed = parseInt(document.getElementById("seed").value);
  let params = {};
  params.rabbits0 = parseInt(document.getElementById("param-rabbits0").value);
  params.foxes0 = parseInt(document.getElementById("param-foxes0").value);
  params.rabbitBreed = parseInt(document.getElementById("param-rabbitBreed").value);
  params.foxBreed = parseInt(document.getElementById("param-foxBreed").value);
  params.foxGain = parseInt(document.getElementById("param-foxGain").value);
  params.grassMax = parseInt(document.getElementById("param-grassMax").value);
  reset(seed, params);
});

document.getElementById("ode-run").addEventListener("click", runODE);

document.getElementById("scenario-export").addEventListener("click", () => {
  document.getElementById("scenario-json").value = exportScenario();
});
document.getElementById("scenario-load").addEventListener("click", () => {
  let text = document.getElementById("scenario-json").value;
  let res = loadScenario(text);
  if (!res) {
    document.getElementById("scenario-error").textContent = "Invalid scenario";
  } else {
    document.getElementById("scenario-error").textContent = "";
  }
});

document.getElementById("preset-save").addEventListener("click", () => {
  let name = document.getElementById("preset-name").value;
  if (name) savePrest(name, exportScenario());
});

function updatePrestList() {
  let list = document.getElementById("preset-list");
  list.innerHTML = "";
  let p = getPrests();
  for (let name in p) {
    let div = document.createElement("div");
    div.setAttribute("data-testid", "preset-item");
    div.innerHTML = `<span>${name}</span><button data-testid="preset-load">Load</button><button data-testid="preset-delete">Delete</button>`;
    div.querySelector(":nth-child(1)").addEventListener("click", () => { loadScenario(p[name]); });
    div.querySelector(":nth-child(2)").addEventListener("click", () => { deletePrest(name); updatePrestList(); });
    list.appendChild(div);
  }
}

updatePrestList();

</body>
</html>
```

```javascript
// Ecosystem Lab - Single Page App
// No external libraries, no network requests, no fonts, no images.

const DEFAULTS = {
  width: 40, height: 30, grassMax: 4,
  rabbits0: 100, foxes0: 6,
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
  seed: 42,
  params: Object.assign({}, DEFAULTS),
  rand: null,
  tick: 0,
  idCounter: 1,
  history: [],
  grid: [],
  rabbits: [],
  foxes: [],
  playing: false,
  playTimer: null,
  lastCounts: {rabbits: 0, foxes: 0, grass: 0}
};

function reset(seed, params) {
  sim.seed = seed;
  sim.params = Object.assign({}, DEFAULTS, params);
  sim.rand = mulberry32(seed);
  sim.tick = 0;
  sim.idCounter = 1;
  sim.history = [];
  sim.rabbits = [];
  sim.foxes = [];
  sim.grid = [];
  for (let y = 0; y < sim.params.height; y++) {
    for (let x = 0; x < sim.params.width; x++) {
      sim.grid.push({x, y, grass: 0, rabbit: null, fox: null});
    }
  }
  // Grass
  for (let i = 0; i < sim.grid.length; i++) {
    sim.grid[i].grass = Math.floor(sim.rand() * (sim.params.grassMax + 1));
  }
  // Rabbits
  for (let i = 0; i < sim.params.rabbits0; i++) {
    let candidates = sim.grid.filter(c => !c.rabbit);
    if (candidates.length === 0) break;
    let cell = candidates[Math.floor(sim.rand() * candidates.length)];
    cell.rabbit = {id: sim.idCounter++, energy: sim.params.rabbitStart};
    sim.rabbits.push(cell.rabbit);
  }
  // Foxes
  for (let i = 0; i < sim.params.foxes0; i++) {
    let candidates = sim.grid.filter(c => !c.fox);
    if (candidates.length === 0) break;
    let cell = candidates[Math.floor(sim.rand() * candidates.length)];
    cell.fox = {id: sim.idCounter++, energy: sim.params.foxStart};
    sim.foxes.push(cell.fox);
  }
  // Record tick 0
  sim.history.push({tick: 0, rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)});
  sim.lastCounts = {rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)};
  updateUI();
  return sim.lastCounts;
}

function step(n) {
  for (let i = 0; i < n; i++) {
    tick();
  }
  updateUI();
  return sim.lastCounts;
}

function tick() {
  // Grass
  for (let c of sim.grid) {
    c.grass = Math.min(sim.params.grassMax, c.grass + 1);
  }
  // Rabbits
  let rab = sim.rabbits.slice();
  for (let r of rab) {
    let cell = sim.grid.find(c => c.rabbit === r);
    let neighbors = getNeighbors(cell);
    let freeNeighbors = neighbors.filter(n => !n.rabbit);
    if (freeNeighbors.length > 0) {
      let spot = freeNeighbors[Math.floor(sim.rand() * freeNeighbors.length)];
      cell.rabbit = null;
      spot.rabbit = r;
      cell = spot;
    }
    r.energy += sim.params.rabbitGain * cell.grass;
    cell.grass = 0;
    r.energy -= sim.params.rabbitCost;
    if (r.energy >= sim.params.rabbitBreed) {
      let freeN = neighbors.filter(n => !n.rabbit);
      if (freeN.length > 0) {
        let spot = freeN[Math.floor(sim.rand() * freeN.length)];
        let child = Math.floor(r.energy / 2);
        r.energy -= child;
        spot.rabbit = {id: sim.idCounter++, energy: child};
        sim.rabbits.push(spot.rabbit);
      }
    }
    if (r.energy <= 0) {
      cell.rabbit = null;
      sim.rabbits = sim.rabbits.filter(rb => rb !== r);
    }
  }
  // Foxes
  let fox = sim.foxes.slice();
  for (let f of fox) {
    let cell = sim.grid.find(c => c.fox === f);
    let neighbors = getNeighbors(cell);
    let rabFree = neighbors.filter(n => n.rabbit && !n.fox);
    if (rabFree.length > 0) {
      let spot = rabFree[Math.floor(sim.rand() * rabFree.length)];
      cell.fox = null;
      spot.fox = f;
      cell = spot;
    } else {
      let free = neighbors.filter(n => !n.fox);
      if (free.length > 0) {
        let spot = free[Math.floor(sim.rand() * free.length)];
        cell.fox = null;
        spot.fox = f;
        cell = spot;
      }
    }
    if (cell.rabbit) {
      cell.rabbit = null;
      f.energy += sim.params.foxGain;
    }
    f.energy -= sim.params.foxCost;
    if (f.energy >= sim.params.foxBreed) {
      let freeN = neighbors.filter(n => !n.fox);
      if (freeN.length > 0) {
        let spot = freeN[Math.floor(sim.rand() * freeN.length)];
        let child = Math.floor(f.energy / 2);
        f.energy -= child;
        spot.fox = {id: sim.idCounter++, energy: child};
        sim.foxes.push(spot.fox);
      }
    }
    if (f.energy <= 0) {
      cell.fox = null;
      sim.foxes = sim.foxes.filter(fx => fx !== f);
    }
  }
  sim.tick++;
  sim.lastCounts = {rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)};
  sim.history.push({tick: sim.tick, rabbits: sim.lastCounts.rabbits, foxes: sim.lastCounts.foxes, grass: sim.lastCounts.grass});
}

function getNeighbors(cell) {
  let {x, y} = cell;
  let res = [];
  if (y > 0) res.push(sim.grid.find(c => c.x === x && c.y === y - 1));
  if (x < sim.params.width - 1) res.push(sim.grid.find(c => c.x === x + 1 && c.y === y));
  if (y < sim.params.height - 1) res.push(sim.grid.find(c => c.x === x && c.y === y + 1));
  if (x > 0) res.push(sim.grid.find(c => c.x === x - 1 && c.y === y));
  return res;
}

function counts() { return sim.lastCounts; }
function tickNum() { return sim.tick; }
function cell(x, y) {
  let c = sim.grid.find(c => c.x === x && c.y === y);
  return {grass: c.grass, rabbit: c.rabbit ? {id: c.rabbit.id, energy: c.rabbit.energy} : null, fox: c.fox ? {id: c.fox.id, energy: c.fox.energy} : null};
}
function history() { return sim.history; }

function ode(p, t, dt) {
  let alpha = p.alpha, beta = p.beta, gamma = p.gamma, delta = p.delta;
  let x = p.x0, y = p.y0;
  let n = Math.round(t / dt);
  for (let i = 0; i < n; i++) {
    let dx = (alpha * x - beta * x * y);
    let dy = (delta * x * y - gamma * y);
    x += dx;
    y += dy;
  }
  return {x, y};
}

function exportCSV() {
  let lines = ["tick,rabbits,foxes,grass"];
  for (let h of sim.history) {
    lines.push(`${h.tick},${h.rabbits},${h.foxes},${h.grass}`);
  }
  return lines.join("\n") + "\n";
}

function exportScenario() {
  return JSON.stringify({version: 1, seed: sim.seed, params: sim.params});
}

function loadScenario(text) {
  try {
    let data = JSON.parse(text);
    if (data.version !== 1 || typeof data.seed !== 'number' || !Number.isInteger(data.seed)) return false;
    let params = {};
    for (let k in DEFAULTS) {
      if (data.params && data.params[k] !== undefined) params[k] = data.params[k];
    }
    reset(data.seed, params);
    return true;
  } catch (e) {
    return false;
  }
}

window.lab = {reset, step, counts, tick: tickNum, cell, history, ode, exportCSV, exportScenario, loadScenario};

// UI
function updateUI() {
  document.getElementById("tick").textContent = `Tick: ${sim.tick}`;
  document.getElementById("count-rabbits").textContent = `Rabbits: ${sim.lastCounts.rabbits}`;
  document.getElementById("count-foxes").textContent = `Foxes: ${sim.lastCounts.foxes}`;
  document.getElementById("count-grass").textContent = `Grass: ${sim.lastCounts.grass}`;
  document.getElementById("announcer").textContent = `Tick ${sim.tick}: ${sim.lastCounts.rabbits} rabbits, ${sim.lastCounts.foxes} foxes`;
  drawCanvas();
  drawChart();
}

function drawCanvas() {
  let canvas = document.getElementById("world");
  canvas.width = sim.params.width * 10;
  canvas.height = sim.params.height * 10;
  let ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let c of sim.grid) {
    let x = c.x * 10, y = c.y * 10;
    let G = 60 + Math.round(160 * c.grass / sim.params.grassMax);
    ctx.fillStyle = `rgb(30, ${G}, 30)`;
    ctx.fillRect(x, y, 10, 0);
    if (c.rabbit) {
      ctx.fillStyle = "rgb(240, 240, 240)";
      ctx.fillRect(x + 2, y + 2, 4, 4);
    }
    if (c.fox) {
      ctx.fillStyle = "rgb(220, 80, 20)";
      ctx.fillRect(x + 2, y + 2, 4, 4);
    }
  }
}

function drawChart() {
  let svg = document.getElementById("chart");
  svg.innerHTML = "";
  let h = sim.history;
  if (h.length === 0) return;
  let maxR = Math.max(1, ...h.map(h => h.rabbits));
  let maxF = Math.max(1, ...h.map(h => h.foxes));
  let maxX = h[h.length - 1].tick;
  let w = 400, hgt = 400;
  let xScale = (t) => 10 + (t / maxX) * (w - 20);
  let yScale = (v) => 10 + (1 - v / Math.max(maxR, maxF)) * (hgt - 10);
  let pointsR = h.map(h => `${xScale(h.tick)},${yScale(h.rabbits)}`).join(" ");
  let pointsF = h.map(h => `${xScale(h.tick)},${yScale(h.foxes)}`).join(" ");
  let polylineR = document.createElement("polyline");
  polylineR.setAttribute("data-testid", "series-rabbits");
  polylineR.setAttribute("points", pointsR);
  svg.appendChild(polylineR);
  let polylineF = document.createElement("polyline");
  polylineF.setAttribute("data-testid", "series-foxes");
  polylineF.setAttribute("points", pointsF);
  svg.appendChild(polylineF);
}

// Presets
function getPrests() {
  try { return JSON.parse(localStorage["ecolab.presets"] || "{}"); } catch { return {}; }
}
function savePrest(name, data) {
  let p = getPrests();
  p[name] = data;
  localStorage["ecolab.presets"] = JSON.stringify(p);
}
function deletePrest(name) {
  let p = getPrests();
  delete p[name];
  localStorage["ecolab.presets"] = JSON.stringify(p);
}

// ODE
function runODE() {
  let alpha = parseFloat(document.getElementById("ode-alpha").value);
  let beta = parseFloat(document.getElementById("ode-beta").value);
  let gamma = parseFloat(document.getElementById("ode-gamma").value);
  let delta = parseFloat(document.getElementById("ode-delta").value);
  let x0 = parseFloat(document.getElementById("ode-x0").value);
  let y0 = parseFloat(document.getElementById("ode-y0").value);
  let t = parseFloat(document.getElementById("ode-t").value);
  let dt = parseFloat(document.getElementById("ode-dt").value);
  let p = {alpha, beta, gamma, delta, x0, y0};
  let res = window.lab.ode(p, t, dt);
  document.getElementById("ode-x").textContent = res.x;
  document.getElementById("ode-y").textContent = res.y;
  document.getElementById("ode-eq-x").textContent = gamma / delta;
  document.getElementById("ode-eq-y").textContent = alpha / beta;
  let V = (x, y) => delta * x - gamma * Math.log(x) + beta * y - alpha * Math.log(y);
  let drift = Math.abs(V(res.x, res.y) - V(x0, y0));
  document.getElementById("ode-drift").textContent = drift;
  // Draw ODE chart
  let svg = document.getElementById("ode-chart");
  svg.innerHTML = "";
  let n = Math.round(t / dt);
  let x = x0, y = y0;
  let pointsX = `${x0},${y0}`;
  let pointsY = `${x0},${y0}`;
  for (let i = 0; i < n; i++) {
    let dx = alpha * x - beta * x * y;
    let dy = delta * x * y - gamma * y;
    x += dx; y += dy;
    pointsX += ` ${x},${y}`;
    pointsY += ` ${x},${y}`;
  }
  let polylineX = document.createElement("polyline");
  polylineX.setAttribute("data-testid", "ode-series-x");
  polylineX.setAttribute("points", pointsX);
  svg.appendChild(polylineX);
  let polylineY = document.createElement("polyline");
  polylineY.setAttribute("data-testid", "ode-series-y");
  polylineY.setAttribute("points", pointsY);
  svg.appendChild(polylineY);
}

// Play/Pause
function startPlay() {
  sim.playing = true;
  let speed = parseInt(document.getElementById("speed").value);
  let lastTime = Date.now();
  function tickLoop() {
    if (!sim.playing) return;
    let now = Date.now();
    let elapsed = now - lastTime;
    if (elapsed >= 1000) {
      for (let i = 0; i < speed; i++) step(1);
      lastTime = now;
    }
    sim.playTimer = setTimeout(tickLoop, 1000);
  }
  tickLoop();
}

function stopPlay() {
  sim.playing = false;
  if (sim.playTimer) clearTimeout(sim.playTimer);
}

// Init
document.getElementById("seed").value = 42;
reset(42, {});

document.getElementById("play").addEventListener("click", startPlay);
document.getElementById("pause").addEventListener("click", stopPlay);
document.getElementById("step").addEventListener("click", () => { step(1); });
document.getElementById("reset").addEventListener("click", () => {
  let seed = parseInt(document.getElementById("seed").value);
  let params = {};
  params.rabbits0 = parseInt(document.getElementById("param-rabbits0").value);
  params.foxes0 = parseInt(document.getElementById("param-foxes0").value);
  params.rabbitBreed = parseInt(document.getElementById("param-rabbitBreed").value);
  params.foxBreed = parseInt(document.getElementById("param-foxBreed").value);
  params.foxGain = parseInt(document.getElementById("param-foxGain").value);
  params.grassMax = parseInt(document.getElementById("param-grassMax").value);
  reset(seed, params);
});

document.getElementById("ode-run").addEventListener("click", runODE);

document.getElementById("scenario-export").addEventListener("click", () => {
  document.getElementById("scenario-json").value = exportScenario();
});
document.getElementById("scenario-load").addEventListener("click", () => {
  let text = document.getElementById("scenario-json").value;
  let res = loadScenario(text);
  if (!res) {
    document.getElementById("scenario-error").textContent = "Invalid scenario";
  } else {
    document.getElementById("scenario-error").textContent = "";
  }
});

document.getElementById("preset-save").addEventListener("click", () => {
  let name = document.getElementById("preset-name").value;
  if (name) savePrest(name, exportScenario());
});

function updatePrestList() {
  let list = document.getElementById("preset-list");
  list.innerHTML = "";
  let p = getPrests();
  for (let name in p) {
    let div = document.createElement("div");
    div.setAttribute("data-testid", "preset-item");
    div.innerHTML = `<span>${name}</span><button data-testid="preset-load">Load</button><button data-testid="preset-delete">Delete</button>`;
    div.querySelector(":nth-child(1)").addEventListener("click", () => { loadScenario(p[name]); });
    div.querySelector(":nth-child(2)").addEventListener("click", () => { deletePrest(name); updatePrestList(); });
    list.appendChild(div);
  }
}

updatePrestList();

</body>
</html>
```

```javascript
// Ecosystem Lab - Single Page App
// No external libraries, no network requests, no fonts, no images.

const DEFAULTS = {
  width: 40, height: 30, grassMax: 4,
  rabbits0: 100, foxes0: 6,
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
  seed: 42,
  params: Object.assign({}, DEFAULTS),
  rand: null,
  tick: 0,
  idCounter: 1,
  history: [],
  grid: [],
  rabbits: [],
  foxes: [],
  playing: false,
  playTimer: null,
  lastCounts: {rabbits: 0, foxes: 0, grass: 0}
};

function reset(seed, params) {
  sim.seed = seed;
  sim.params = Object.assign({}, DEFAULTS, params);
  sim.rand = mulberry32(seed);
  sim.tick = 0;
  sim.idCounter = 1;
  sim.history = [];
  sim.rabbits = [];
  sim.foxes = [];
  sim.grid = [];
  for (let y = 0; y < sim.params.height; y++) {
    for (let x = 0; x < sim.params.width; x++) {
      sim.grid.push({x, y, grass: 0, rabbit: null, fox: null});
    }
  }
  // Grass
  for (let i = 0; i < sim.grid.length; i++) {
    sim.grid[i].grass = Math.floor(sim.rand() * (sim.params.grassMax + 1));
  }
  // Rabbits
  for (let i = 0; i < sim.params.rabbits0; i++) {
    let candidates = sim.grid.filter(c => !c.rabbit);
    if (candidates.length === 0) break;
    let cell = candidates[Math.floor(sim.rand() * candidates.length)];
    cell.rabbit = {id: sim.idCounter++, energy: sim.params.rabbitStart};
    sim.rabbits.push(cell.rabbit);
  }
  // Foxes
  for (let i = 0; i < sim.params.foxes0; i++) {
    let candidates = sim.grid.filter(c => !c.fox);
    if (candidates.length === 0) break;
    let cell = candidates[Math.floor(sim.rand() * candidates.length)];
    cell.fox = {id: sim.idCounter++, energy: sim.params.foxStart};
    sim.foxes.push(cell.fox);
  }
  // Record tick 0
  sim.history.push({tick: 0, rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)});
  sim.lastCounts = {rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)};
  updateUI();
  return sim.lastCounts;
}

function step(n) {
  for (let i = 0; i < n; i++) {
    tick();
  }
  updateUI();
  return sim.lastCounts;
}

function tick() {
  // Grass
  for (let c of sim.grid) {
    c.grass = Math.min(sim.params.grassMax, c.grass + 1);
  }
  // Rabbits
  let rab = sim.rabbits.slice();
  for (let r of rab) {
    let cell = sim.grid.find(c => c.rabbit === r);
    let neighbors = getNeighbors(cell);
    let freeNeighbors = neighbors.filter(n => !n.rabbit);
    if (freeNeighbors.length > 0) {
      let spot = freeNeighbors[Math.floor(sim.rand() * freeNeighbors.length)];
      cell.rabbit = null;
      spot.rabbit = r;
      cell = spot;
    }
    r.energy += sim.params.rabbitGain * cell.grass;
    cell.grass = 0;
    r.energy -= sim.params.rabbitCost;
    if (r.energy >= sim.params.rabbitBreed) {
      let freeN = neighbors.filter(n => !n.rabbit);
      if (freeN.length > 0) {
        let spot = freeN[Math.floor(sim.rand() * freeN.length)];
        let child = Math.floor(r.energy / 2);
        r.energy -= child;
        spot.rabbit = {id: sim.idCounter++, energy: child};
        sim.rabbits.push(spot.rabbit);
      }
    }
    if (r.energy <= 0) {
      cell.rabbit = null;
      sim.rabbits = sim.rabbits.filter(rb => rb !== r);
    }
  }
  // Foxes
  let fox = sim.foxes.slice();
  for (let f of fox) {
    let cell = sim.grid.find(c => c.fox === f);
    let neighbors = getNeighbors(cell);
    let rabFree = neighbors.filter(n => n.rabbit && !n.fox);
    if (rabFree.length > 0) {
      let spot = rabFree[Math.floor(sim.rand() * rabFree.length)];
      cell.fox = null;
      spot.fox = f;
      cell = spot;
    } else {
      let free = neighbors.filter(n => !n.fox);
      if (free.length > 0) {
        let spot = free[Math.floor(sim.rand() * free.length)];
        cell.fox = null;
        spot.fox = f;
        cell = spot;
      }
    }
    if (cell.rabbit) {
      cell.rabbit = null;
      f.energy += sim.params.foxGain;
    }
    f.energy -= sim.params.foxCost;
    if (f.energy >= sim.params.foxBreed) {
      let freeN = neighbors.filter(n => !n.fox);
      if (freeN.length > 0) {
        let spot = freeN[Math.floor(sim.rand() * freeN.length)];
        let child = Math.floor(f.energy / 2);
        f.energy -= child;
        spot.fox = {id: sim.idCounter++, energy: child};
        sim.foxes.push(spot.fox);
      }
    }
    if (f.energy <= 0) {
      cell.fox = null;
      sim.foxes = sim.foxes.filter(fx => fx !== f);
    }
  }
  sim.tick++;
  sim.lastCounts = {rabbits: sim.rabbits.length, foxes: sim.foxes.length, grass: sim.grid.reduce((s, c) => s + c.grass, 0)};
  sim.history.push({tick: sim.tick, rabbits: sim.lastCounts.rabbits, foxes: sim.lastCounts.foxes, grass: sim.lastCounts.grass});
}

function getNeighbors(cell) {
  let {x, y} = cell;
  let res = [];
  if (y > 0) res.push(sim.grid.find(c => c.x === x && c.y === y - 1));
  if (x < sim.params.width - 1) res.push(sim.grid.find(c => c.x === x + 1 && c.y === y));
  if (y < sim.params.height - 1) res.push(sim.grid.find(c => c.x === x && c.y === y + 1));
  if (x > 0) res.push(sim.grid.find(c => c.x === x - 1 && c.y === y));
  return res;
}

function counts() { return sim.lastCounts; }
function tickNum() { return sim.tick; }
function cell(x, y) {
  let c = sim.grid.find(c => c.x === x && c.y === y);
  return {grass: c.grass, rabbit: c.rabbit ? {id: c.rabbit.id, energy: c.rabbit.energy} : null, fox: c.fox ? {id: c.fox.id, energy: c.fox.energy} : null};
}
function history() { return sim.history; }

function ode(p, t, dt) {
  let alpha = p.alpha, beta = p.beta, gamma = p.gamma, delta = p.delta;
  let x = p.x0, y = p.y0;
  let n = Math.round(t / dt);
  for (let i = 0; i < n; i++) {
    let dx = (alpha * x - beta * x * y);
    let dy = (delta * x * y - gamma * y);
    x += dx;
    y += dy;
  }
  return {x, y};
}

function exportCSV() {
  let lines = ["tick,rabbits,foxes,grass"];
  for (let h of sim.history) {
    lines.push(`${h.tick},${h.rabbits},${h.foxes},${h.grass}`);
  }
  return lines.join("\n") + "\n";
}

function exportScenario() {
  return JSON.stringify({version: 1, seed: sim.seed, params: sim.params});
}

function loadScenario(text) {
  try {
    let data = JSON.parse(text);
    if (data.version !== 1 || typeof data.seed !== 'number' || !Number.isInteger(data.seed)) return false;
    let params = {};
    for (let k in DEFAULTS) {
      if (data.params && data.params[k] !== undefined) params[k] = data.params[k];
    }
    reset(data.seed, params);
    return true;
  } catch (e) {
    return false;
  }
}

window.lab = {reset, step, counts, tick: tickNum, cell, history, ode, exportCSV, exportScenario, loadScenario};

// UI
function updateUI() {
  document.getElementById("tick").textContent = `Tick: ${sim.tick}`;
  document.getElementById("count-rabbits").textContent = `Rabbits: ${sim.lastCounts.rabbits}`;
  document.getElementById("count-foxes").textContent = `Foxes: ${sim.lastCounts.foxes}`;
  document.getElementById("count-grass").textContent = `Grass: ${sim.lastCounts.grass}`;
  document.getElementById("announcer").textContent = `Tick ${sim.tick}: ${sim.lastCounts.rabbits} rabbits, ${sim.lastCounts.foxes} foxes`;
  drawCanvas();
  drawChart();
}

function drawCanvas() {
  let canvas = document.getElementById("world");
  canvas.width = sim.params.width * 10;
  canvas.height = sim.params.height * 10;
  let ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let c of sim.grid) {
    let x = c.x * 10, y = c.y * 10;
    let G = 60 + Math.round(160 * c.grass / sim.params.grassMax);
    ctx.fillStyle = `rgb(30, ${G}, 30)`;
    ctx.fillRect(x, y, 10, 0);
    if (c.rabbit) {
      ctx.fillStyle = "rgb(240, 240, 240)";
      ctx.fillRect(x + 2, y + 2, 4, 4);
    }
    if (c.fox) {
      ctx.fillStyle = "rgb(220, 80, 20)";
      ctx.fillRect(x + 2, y + 2, 4, 4);
    }
  }
}

function drawChart() {
  let svg = document.getElementById("chart");
  svg.innerHTML = "";
  let h = sim.history;
  if (h.length === 0) return;
  let maxR = Math.max(1, ...h.map(h => h.rabbits));
  let maxF = Math.max(1, ...h.map(h => h.foxes));
  let maxX = h[h.length - 1].tick;
  let w = 400, hgt = 400;
  let xScale = (t) => 10 + (t / maxX) * (w - 20);
  let yScale = (v) => 10 + (1 - v / Math.max(maxR, maxF)) * (hgt - 10);
  let pointsR = h.map(h => `${xScale(h.tick)},${yScale(h.rabbits)}`).join(" ");
  let pointsF = h.map(h => `${xScale(h.tick)},${yScale(h.foxes)}`).join(" ");
  let polylineR = document.createElement("polyline");
  polylineR.setAttribute("data-testid", "series-rabbits");
  polylineR.setAttribute("points", pointsR);
  svg.appendChild(polylineR);
  let polylineF = document.createElement("polyline");
  polylineF.setAttribute("data-testid", "series-foxes");
  polylineF.setAttribute("points", pointsF);
  svg.appendChild(polylineF);
}

// Presets
function getPrests() {
  try { return JSON.parse(localStorage["ecolab.presets"] || "{}"); } catch { return {}; }
}
function savePrest(name, data) {
  let p = getPrests();
  p[name] = data;
  localStorage["ecolab.presets"] = JSON.stringify(p);
}
function deletePrest(name) {
  let p = getPrests();
  delete p[name];
  localStorage["ecolab.presets"] = JSON.stringify(p);
}

// ODE
function runODE() {
  let alpha = parseFloat(document.getElementById("ode-alpha").value);
  let beta = parseFloat(document.getElementById("ode-beta").value);
  let gamma = parseFloat(document.getElementById("ode-gamma").value);
  let delta = parseFloat(document.getElementById("ode-delta").value);
  let x0 = parseFloat(document.getElementById("ode-x0").value);
  let y0 = parseFloat(document.getElementById("ode-y0").value);
  let t = parseFloat(document.getElementById("ode-t").value);
  let dt = parseFloat(document.getElementById("ode-dt").value);
  let p = {alpha, beta, gamma, delta, x0, y0};
  let res = window.lab.ode(p, t, dt);
  document.getElementById("ode-x").textContent = res.x;
  document.getElementById("ode-y").textContent = res.y;
  document.getElementById("ode-eq-x").textContent = gamma / delta;
  document.getElementById("ode-eq-y").textContent = alpha / beta;
  let V = (x, y) => delta * x - gamma * Math.log(x) + beta * y - alpha * Math.log(y);
  let drift = Math.abs(V(res.x, res.y) - V(x0, y0));
  document.getElementById("ode-drift").textContent = drift;
  // Draw ODE chart
  let svg = document.getElementById("ode-chart");
  svg.innerHTML = "";
  let n = Math.round(t / dt);
  let x = x0, y = y0;
  let pointsX = `${x0},${y0}`;
  let pointsY = `${x0},${y0}`;
  for (let i = 0; i < n; i++) {
    let dx = alpha * x - beta * x * y;
    let dy = delta * x * y - gamma * y;
    x += dx; y += dy;
    pointsX += ` ${x},${y}`;
    pointsY += ` ${x},${y}`;
  }
  let polylineX = document.createElement("polyline");
  polylineX.setAttribute("data-testid", "ode-series-x");
  polylineX.setAttribute("points", pointsX);
  svg.appendChild(polylineX);
  let polylineY = document.createElement("polyline");
  polylineY.setAttribute("data-testid", "ode-series-y");
  polylineY.setAttribute("points", pointsY);
  svg.appendChild(polylineY);
}

// Play/Pause
function startPlay() {
  sim.playing = true;
  let speed = parseInt(document.getElementById("speed").value);
  let lastTime = Date.now();
  function tickLoop() {
    if (!sim.playing) return;
    let now = Date.now();
    let elapsed = now - lastTime;
    if (elapsed >= 1000) {
      for (let i = 0; i < speed; i++) step(1);
      lastTime = now;
    }
    sim.playTimer = setTimeout(tickLoop, 1000);
  }
  tickLoop();
}

function stopPlay() {
  sim.playing = false;
  if (sim.playTimer) clearTimeout(sim.playTimer);
}

// Init
document.getElementById("seed").value = 42;
reset(42, {});

document.getElementById("play").addEventListener("click", startPlay);
document.getElementById("pause").addEventListener("click", stopPlay);
document.getElementById("step").addEventListener("click", () => { step(1); });
document.getElementById("reset").addEventListener("click", () => {
  let seed = parseInt(document.getElementById("seed").value);
  let params = {};
  params.rabbits0 = parseInt(document.getElementById("param-rabbits0").value);
  params.foxes0 = parseInt(document.getElementById("param-foxes0").value);
  params.rabbitBreed = parseInt(document.getElementById("param-rabbitBreed").value);
  params.foxBreed = parseInt(document.getElementById("param-foxBreed").value);
  params.foxGain = parseInt(document.getElementById("param-foxGain").value);
  params.grassMax = parseInt(document.getElementById("param-grassMax").value);
  reset(seed, params);
});

document.getElementById("ode-run").addEventListener("click", runODE);

document.getElementById("scenario-export").addEventListener("click", () => {
  document.getElementById("scenario-json").value = exportScenario();
});
document.getElementById("scenario-load").addEventListener("click", () => {
  let text = document.getElementById("scenario-json").value;
  let res = loadScenario(text);
  if (!res) {
    document.getElementById("scenario-error").textContent = "Invalid scenario";
  } else {
    document.getElementById("scenario-error").textContent = "";
  }
});

document.getElementById("preset-save").addEventListener("click", () => {
  let name = document.getElementById("preset-name").value;
  if (name) savePrest(name, exportScenario());
});

function updatePrestList() {
  let list = document.getElementById("preset-list");
  list.innerHTML = "";
  let p = getPrests();
  for (let name in p) {
    let div = document.createElement("div");
    div.setAttribute("data-testid", "preset-item");
    div.innerHTML = `<span>${name}</span><button data-testid="preset-load">Load</button><button data-testid="preset-delete">Delete</button>`;
    div.querySelector(":nth-child(1)").addEventListener("click", () => { loadScenario(p[name]); });
    div.querySelector(":nth-child(2)").addEventListener("click", () => { deletePrest(name); updatePrestList(); });
    list.appendChild(div);
  }
}

updatePrestList();

</body>
</html>
```