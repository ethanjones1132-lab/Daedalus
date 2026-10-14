## Plan

**Data model.** One mutable world object held in module closure: `params` (13 keys merged over `DEFAULTS`), `seed`, `rand = mulberry32(seed)`, `tick`, `nextId` (shared counter from 1), `grass` (flat `Int32Array`-style array, index `y*width+x`), `rabbits[]` and `foxes[]` of `{id,x,y,energy,alive}`, plus two occupancy grids `gridRabbit`/`gridFox` (cell → animal | null) kept in sync on every move, birth and death. `history` is an array of `{tick,rabbits,foxes,grass}` starting at tick 0. `pick(list)` draws exactly one `rand()` only when the list is non-empty.

**Tick order.** (1) grass: `min(grassMax, grass+1)` per cell. (2) Rabbits snapshotted at phase start, sorted by id: move to a random rabbit-free neighbour (up,right,down,left); eat `rabbitGain*grass`, zero the cell; pay `rabbitCost`; if `energy>=rabbitBreed` pick a rabbit-free neighbour, split `floor(e/2)` into a child with the next id; remove if `energy<=0`. (3) Foxes likewise: prefer neighbours with a rabbit and no fox, else any fox-free neighbour; eat the rabbit in the current cell for `foxGain`; pay `foxCost`; breed into a fox-free neighbour; die. (4) `tick++`, record history. Newborns never act the tick they are born.

**Components.** Simulation core (`reset`, `tickOnce`, `step`, `counts`, `history`, `cell`, `exportCSV`, `exportScenario`, `loadScenario`, `ode`/RK4) exposed on `window.lab`; canvas renderer (10 px cells, grass gradient, white rabbit, orange fox over it); counters and controls (play/pause/step/reset, seed, speed, six parameter sliders); SVG history chart with two polylines; Lotka–Volterra panel with RK4 chart and drift; scenario textarea + CSV download; localStorage presets; `aria-live` announcer; rAF-based elapsed-time scheduler; keyboard shortcuts (Space/s/r) disabled while a control has focus.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ecosystem Lab</title>
<style>
  :root{
    --bg:#0f1417; --panel:#161d21; --panel2:#1d262b; --line:#2b363c;
    --text:#e7eef2; --muted:#9bb0b8; --accent:#4cc38a; --accent2:#ff7b52; --focus:#ffd166;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  h1{font-size:1.12rem;margin:0;padding:16px 16px 10px;letter-spacing:.02em}
  h1 span{color:var(--muted);font-weight:400;font-size:.78rem}
  h2{font-size:.78rem;margin:0 0 10px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}
  h3{font-size:.74rem;margin:16px 0 8px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
  .layout{display:grid;gap:16px;padding:0 16px 36px}
  @media (min-width:1000px){.layout{grid-template-columns:minmax(0,1fr) 420px;align-items:start}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}
  canvas{display:block;width:auto;max-width:100%;height:auto;border-radius:6px;background:#000;
    image-rendering:pixelated;border:1px solid var(--line)}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}
  button{font:inherit;color:var(--text);background:var(--panel2);border:1px solid var(--line);
    border-radius:7px;padding:6px 12px;cursor:pointer;transition:border-color .12s,background .12s}
  button:hover{border-color:#48595f;background:#232e34}
  button:active{transform:translateY(1px)}
  :focus{outline:3px solid var(--focus);outline-offset:2px}
  input[type=number],input[type=text],textarea{background:#0d1215;color:var(--text);
    border:1px solid var(--line);border-radius:7px;padding:6px 8px;font:inherit;width:100%;min-width:0}
  textarea{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
  input[type=range]{width:100%;accent-color:var(--accent)}
  label.inline{display:inline-flex;align-items:center;gap:6px;font-size:.76rem;color:var(--muted)}
  label.inline input[type=number]{width:88px}
  label.inline input[type=range]{width:130px}
  .fields{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-top:14px}
  .field label{display:flex;justify-content:space-between;gap:8px;font-size:.75rem;color:var(--muted);margin-bottom:3px}
  .field output{color:var(--text);font-variant-numeric:tabular-nums}
  .counters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:14px}
  .counter{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:6px 9px}
  .counter-label{display:block;font-size:.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
  .counter-value{display:block;font-size:1.05rem;font-variant-numeric:tabular-nums}
  .chart{width:100%;height:auto;display:block;background:#0d1215;border:1px solid var(--line);border-radius:8px}
  .chart text{fill:var(--muted);font-size:11px;font-family:inherit}
  .chart line{stroke:#2b363c;stroke-width:1}
  .ode-out{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;margin-top:10px;font-size:.8rem}
  .ode-out div{background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:5px 8px}
  .ode-out b{font-variant-numeric:tabular-nums;font-weight:600;color:var(--accent)}
  .hint{color:var(--muted);font-size:.75rem;margin:8px 0 0}
  .error{color:#ff9a9a;font-size:.78rem;min-height:1.2em;margin-top:6px}
  .preset-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);
    border-radius:8px;margin-bottom:6px;background:var(--panel2)}
  .preset-item span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .preset-item button{padding:4px 9px;font-size:.78rem}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
    clip:rect(0 0 0 0);white-space:nowrap;border:0}
  .stack{margin-top:6px}
</style>
</head>
<body>
<h1>Ecosystem Lab <span>grass · rabbits · foxes</span></h1>
<main class="layout">
  <section class="panel" data-testid="panel-world">
    <h2>World</h2>
    <canvas data-testid="world" width="400" height="300"></canvas>
    <div class="row">
      <button data-testid="play">Play</button>
      <button data-testid="pause">Pause</button>
      <button data-testid="step">Step</button>
      <button data-testid="reset">Reset</button>
      <label class="inline" for="seed">Seed <input id="seed" data-testid="seed" type="number" step="1" value="42"></label>
      <label class="inline" for="speed">Speed <input id="speed" data-testid="speed" type="range" min="1" max="60" value="10"></label>
      <span class="hint" id="speed-val">10 /s</span>
    </div>
    <div class="fields">
      <div class="field">
        <label for="param-rabbits0">Rabbits at reset <output id="val-rabbits0">100</output></label>
        <input id="param-rabbits0" data-testid="param-rabbits0" type="range" min="0" max="300" step="1" value="100">
      </div>
      <div class="field">
        <label for="param-foxes0">Foxes at reset <output id="val-foxes0">6</output></label>
        <input id="param-foxes0" data-testid="param-foxes0" type="range" min="0" max="60" step="1" value="6">
      </div>
      <div class="field">
        <label for="param-rabbitBreed">Rabbit breed energy <output id="val-rabbitBreed">12</output></label>
        <input id="param-rabbitBreed" data-testid="param-rabbitBreed" type="range" min="2" max="40" step="1" value="12">
      </div>
      <div class="field">
        <label for="param-foxBreed">Fox breed energy <output id="val-foxBreed">40</output></label>
        <input id="param-foxBreed" data-testid="param-foxBreed" type="range" min="2" max="60" step="1" value="40">
      </div>
      <div class="field">
        <label for="param-foxGain">Fox gain per rabbit <output id="val-foxGain">4</output></label>
        <input id="param-foxGain" data-testid="param-foxGain" type="range" min="1" max="30" step="1" value="4">
      </div>
      <div class="field">
        <label for="param-grassMax">Max grass <output id="val-grassMax">4</output></label>
        <input id="param-grassMax" data-testid="param-grassMax" type="range" min="1" max="10" step="1" value="4">
      </div>
    </div>
    <div class="counters">
      <div class="counter"><span class="counter-label">Tick</span><span class="counter-value" data-testid="tick">0</span></div>
      <div class="counter"><span class="counter-label">Rabbits</span><span class="counter-value" data-testid="count-rabbits">0</span></div>
      <div class="counter"><span class="counter-label">Foxes</span><span class="counter-value" data-testid="count-foxes">0</span></div>
      <div class="counter"><span class="counter-label">Grass</span><span class="counter-value" data-testid="count-grass">0</span></div>
    </div>
  </section>

  <section class="panel" data-testid="panel-side">
    <h2>Populations</h2>
    <svg data-testid="chart" class="chart" viewBox="0 0 420 220" role="img" aria-label="Population history">
      <line x1="40" y1="194" x2="408" y2="194"></line>
      <line x1="40" y1="12" x2="40" y2="194"></line>
      <polyline data-testid="series-rabbits" fill="none" stroke="#7ee787" stroke-width="1.5" points=""></polyline>
      <polyline data-testid="series-foxes" fill="none" stroke="#ff7b52" stroke-width="1.5" points=""></polyline>
      <text x="404" y="212" text-anchor="end">tick</text>
      <text x="14" y="103" transform="rotate(-90 14 103)" text-anchor="middle">count</text>
    </svg>

    <h3>Lotka–Volterra</h3>
    <p class="hint">dx/dt = αx − βxy &nbsp;·&nbsp; dy/dt = δxy − γy</p>
    <div class="fields">
      <div class="field"><label for="ode-alpha">alpha (α)</label>
        <input id="ode-alpha" data-testid="ode-alpha" type="number" step="0.01" value="1.1"></div>
      <div class="field"><label for="ode-beta">beta (β)</label>
        <input id="ode-beta" data-testid="ode-beta" type="number" step="0.01" value="0.4"></div>
      <div class="field"><label for="ode-gamma">gamma (γ)</label>
        <input id="ode-gamma" data-testid="ode-gamma" type="number" step="0.01" value="0.4"></div>
      <div class="field"><label for="ode-delta">delta (δ)</label>
        <input id="ode-delta" data-testid="ode-delta" type="number" step="0.01" value="0.1"></div>
      <div class="field"><label for="ode-x0">x0</label>
        <input id="ode-x0" data-testid="ode-x0" type="number" step="0.1" value="10"></div>
      <div class="field"><label for="ode-y0">y0</label>
        <input id="ode-y0" data-testid="ode-y0" type="number" step="0.1" value="10"></div>
      <div class="field"><label for="ode-t">t</label>
        <input id="ode-t" data-testid="ode-t" type="number" step="1" value="50"></div>
      <div class="field"><label for="ode-dt">dt</label>
        <input id="ode-dt" data-testid="ode-dt" type="number" step="0.001" value="0.01"></div>
    </div>
    <div class="row"><button data-testid="ode-run">Run ODE</button></div>
    <div class="ode-out">
      <div>final x: <b data-testid="ode-x">—</b></div>
      <div>final y: <b data-testid="ode-y">—</b></div>
      <div>equilibrium x (γ/δ): <b data-testid="ode-eq-x">—</b></div>
      <div>equilibrium y (α/β): <b data-testid="ode-eq-y">—</b></div>
      <div>drift |ΔV|: <b data-testid="ode-drift">—</b></div>
    </div>
    <svg data-testid="ode-chart" class="chart stack" viewBox="0 0 420 200" role="img" aria-label="ODE trajectory">
      <line x1="40" y1="174" x2="408" y2="174"></line>
      <line x1="40" y1="12" x2="40" y2="174"></line>
      <polyline data-testid="ode-series-x" fill="none" stroke="#7ee787" stroke-width="1.5" points=""></polyline>
      <polyline data-testid="ode-series-y" fill="none" stroke="#ff7b52" stroke-width="1.5" points=""></polyline>
      <text x="404" y="192" text-anchor="end">time</text>
      <text x="14" y="93" transform="rotate(-90 14 93)" text-anchor="middle">value</text>
    </svg>

    <h3>Scenario</h3>
    <textarea data-testid="scenario-json" rows="4" spellcheck="false"></textarea>
    <div class="row">
      <button data-testid="scenario-export">Export scenario</button>
      <button data-testid="scenario-load">Load scenario</button>
      <button data-testid="csv-export">Download CSV</button>
    </div>
    <div class="error" data-testid="scenario-error"></div>

    <h3>Presets</h3>
    <div class="row">
      <input data-testid="preset-name" type="text" placeholder="Preset name" style="flex:1;min-width:120px">
      <button data-testid="preset-save">Save preset</button>
    </div>
    <div id="preset-list" data-testid="preset-list" class="stack"></div>
  </section>
</main>
<div data-testid="announcer" aria-live="polite" class="sr-only"></div>

<script>
(function () {
  'use strict';

  /* ---------------- RNG ---------------- */
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

  /* ---------------- Defaults ---------------- */
  const DEFAULTS = {
    width: 40, height: 30, grassMax: 4,
    rabbits0: 100, foxes0: 6,
    rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
    foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
  };
  const PARAM_KEYS = Object.keys(DEFAULTS);

  /* ---------------- DOM ---------------- */
  const $ = function (s) { return document.querySelector(s); };
  const canvas = $('[data-testid="world"]');
  const ctx = canvas.getContext('2d');
  const seedInput = $('[data-testid="seed"]');
  const speedInput = $('[data-testid="speed"]');
  const speedVal = document.getElementById('speed-val');
  const announcer = $('[data-testid="announcer"]');
  const rabbitLine = $('[data-testid="series-rabbits"]');
  const foxLine = $('[data-testid="series-foxes"]');
  const odeLineX = $('[data-testid="ode-series-x"]');
  const odeLineY = $('[data-testid="ode-series-y"]');
  const errEl = $('[data-testid="scenario-error"]');
  const scenarioEl = $('[data-testid="scenario-json"]');
  const presetListEl = $('[data-testid="preset-list"]');
  const presetNameEl = $('[data-testid="preset-name"]');

  /* ---------------- State ---------------- */
  let rand = mulberry32(1);
  let P = Object.assign({}, DEFAULTS);
  let W = DEFAULTS.width, H = DEFAULTS.height;
  let grass = [];
  let gridRabbit = [], gridFox = [];
  let rabbits = [], foxes = [];
  let nextId = 1;
  let tickCount = 0;
  let hist = [];
  let curSeed = 42;

  /* ---------------- Helpers ---------------- */
  function pick(list) {
    if (!list || list.length === 0) return null;
    return list[Math.floor(rand() * list.length)];
  }
  function neighbors(x, y) {
    const out = [];
    if (y > 0) out.push({ x: x, y: y - 1 });
    if (x < W - 1) out.push({ x: x + 1, y: y });
    if (y < H - 1) out.push({ x: x, y: y + 1 });
    if (x > 0) out.push({ x: x - 1, y: y });
    return out;
  }
  function idx(x, y) { return y * W + x; }

  /* ---------------- Reset ---------------- */
  function reset(seed, params) {
    params = params || {};
    const s = Number(seed);
    curSeed = isFinite(s) ? Math.trunc(s) : 0;
    rand = mulberry32(curSeed);
    P = Object.assign({}, DEFAULTS, params);
    W = Math.max(1, Math.floor(Number(P.width) || 1));
    H = Math.max(1, Math.floor(Number(P.height) || 1));
    tickCount = 0;
    nextId = 1;
    hist = [];

    const gm = Math.max(0, Math.floor(Number(P.grassMax) || 0));
    grass = new Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        grass[idx(x, y)] = Math.floor(rand() * (gm + 1));
      }
    }

    rabbits = []; foxes = [];
    gridRabbit = new Array(W * H).fill(null);
    gridFox = new Array(W * H).fill(null);

    const r0 = Math.max(0, Math.floor(Number(P.rabbits0) || 0));
    for (let i = 0; i < r0; i++) {
      const free = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) if (!gridRabbit[idx(x, y)]) free.push({ x: x, y: y });
      }
      if (free.length === 0) break;
      const c = pick(free);
      const r = { id: nextId++, x: c.x, y: c.y, energy: Math.trunc(Number(P.rabbitStart) || 0), alive: true };
      rabbits.push(r);
      gridRabbit[idx(c.x, c.y)] = r;
    }

    const f0 = Math.max(0, Math.floor(Number(P.foxes0) || 0));
    for (let i = 0; i < f0; i++) {
      const free = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) if (!gridFox[idx(x, y)]) free.push({ x: x, y: y });
      }
      if (free.length === 0) break;
      const c = pick(free);
      const f = { id: nextId++, x: c.x, y: c.y, energy: Math.trunc(Number(P.foxStart) || 0), alive: true };
      foxes.push(f);
      gridFox[idx(c.x, c.y)] = f;
    }

    canvas.width = W * 10;
    canvas.height = H * 10;

    if (playing) pause();
    record();
    renderAll();
    return counts();
  }

  /* ---------------- Tick ---------------- */
  function tickOnce() {
    const gm = Math.max(0, Math.floor(Number(P.grassMax) || 0));
    const rabbitGain = Number(P.rabbitGain) || 0;
    const rabbitCost = Number(P.rabbitCost) || 0;
    const rabbitBreed = Number(P.rabbitBreed) || 0;
    const foxGain = Number(P.foxGain) || 0;
    const foxCost = Number(P.foxCost) || 0;
    const foxBreed = Number(P.foxBreed) || 0;

    /* 1. grass */
    for (let i = 0; i < grass.length; i++) {
      if (grass[i] < gm) grass[i] = grass[i] + 1;
      else grass[i] = Math.min(gm, grass[i]);
    }

    /* 2. rabbits */
    const rlist = rabbits.slice().sort(function (a, b) { return a.id - b.id; });
    for (let k = 0; k < rlist.length; k++) {
      const r = rlist[k];
      if (!r.alive) continue;

      /* move */
      const nb = neighbors(r.x, r.y);
      const free = [];
      for (let i = 0; i < nb.length; i++) if (!gridRabbit[idx(nb[i].x, nb[i].y)]) free.push(nb[i]);
      if (free.length > 0) {
        const c = pick(free);
        gridRabbit[idx(r.x, r.y)] = null;
        r.x = c.x; r.y = c.y;
        gridRabbit[idx(r.x, r.y)] = r;
      }

      /* eat */
      const ci = idx(r.x, r.y);
      r.energy += rabbitGain * grass[ci];
      grass[ci] = 0;

      /* cost */
      r.energy -= rabbitCost;

      /* breed */
      if (r.energy >= rabbitBreed) {
        const nb2 = neighbors(r.x, r.y);
        const free2 = [];
        for (let i = 0; i < nb2.length; i++) if (!gridRabbit[idx(nb2[i].x, nb2[i].y)]) free2.push(nb2[i]);
        if (free2.length > 0) {
          const spot = pick(free2);
          const child = Math.floor(r.energy / 2);
          r.energy -= child;
          const baby = { id: nextId++, x: spot.x, y: spot.y, energy: child, alive: true };
          rabbits.push(baby);
          gridRabbit[idx(spot.x, spot.y)] = baby;
        }
      }

      /* die */
      if (r.energy <= 0) {
        r.alive = false;
        gridRabbit[idx(r.x, r.y)] = null;
      }
    }

    /* 3. foxes */
    const flist = foxes.slice().sort(function (a, b) { return a.id - b.id; });
    for (let k = 0; k < flist.length; k++) {
      const f = flist[k];
      if (!f.alive) continue;

      /* move */
      const nb = neighbors(f.x, f.y);
      let cand = [];
      for (let i = 0; i < nb.length; i++) {
        const c = nb[i];
        if (gridRabbit[idx(c.x, c.y)] && !gridFox[idx(c.x, c.y)]) cand.push(c);
      }
      if (cand.length === 0) {
        for (let i = 0; i < nb.length; i++) {
          const c = nb[i];
          if (!gridFox[idx(c.x, c.y)]) cand.push(c);
        }
      }
      if (cand.length > 0) {
        const c = pick(cand);
        gridFox[idx(f.x, f.y)] = null;
        f.x = c.x; f.y = c.y;
        gridFox[idx(f.x, f.y)] = f;
      }

      /* eat */
      const ci = idx(f.x, f.y);
      const prey = gridRabbit[ci];
      if (prey && prey.alive) {
        prey.alive = false;
        gridRabbit[ci] = null;
        f.energy += foxGain;
      }

      /* cost */
      f.energy -= foxCost;

      /* breed */
      if (f.energy >= foxBreed) {
        const nb2 = neighbors(f.x, f.y);
        const free2 = [];
        for (let i = 0; i < nb2.length; i++) if (!gridFox[idx(nb2[i].x, nb2[i].y)]) free2.push(nb2[i]);
        if (free2.length > 0) {
          const spot = pick(free2);
          const child = Math.floor(f.energy / 2);
          f.energy -= child;
          const baby = { id: nextId++, x: spot.x, y: spot.y, energy: child, alive: true };
          foxes.push(baby);
          gridFox[idx(spot.x, spot.y)] = baby;
        }
      }

      /* die */
      if (f.energy <= 0) {
        f.alive = false;
        gridFox[idx(f.x, f.y)] = null;
      }
    }

    tickCount += 1;
    rabbits = rabbits.filter(function (a) { return a.alive; });
    foxes = foxes.filter(function (a) { return a.alive; });
    record();
  }

  function record() {
    let g = 0;
    for (let i = 0; i < grass.length; i++) g += grass[i];
    hist.push({ tick: tickCount, rabbits: rabbits.length, foxes: foxes.length, grass: g });
  }

  function counts() {
    let g = 0;
    for (let i = 0; i < grass.length; i++) g += grass[i];
    return { rabbits: rabbits.length, foxes: foxes.length, grass: g };
  }

  function step(n) {
    let k = (n === undefined) ? 1 : n;
    k = Math.max(0, Math.floor(Number(k) || 0));
    for (let i = 0; i < k; i++) tickOnce();
    renderAll();
    return counts();
  }

  /* ---------------- Rendering ---------------- */
  function drawWorld() {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const gm = Math.max(1, Math.floor(Number(P.grassMax) || 1));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let lvl = grass[idx(x, y)];
        if (lvl < 0) lvl = 0;
        if (lvl > gm) lvl = gm;
        const g = 60 + Math.round(160 * lvl / gm);
        ctx.fillStyle = 'rgb(30,' + g + ',30)';
        ctx.fillRect(x * 10, y * 10, 10, 10);
      }
    }
    ctx.fillStyle = 'rgb(240,240,240)';
    for (let i = 0; i < rabbits.length; i++) {
      const r = rabbits[i];
      if (r.alive) ctx.fillRect(r.x * 10 + 2, r.y * 10 + 2, 6, 6);
    }
    ctx.fillStyle = 'rgb(220,80,20)';
    for (let i = 0; i < foxes.length; i++) {
      const f = foxes[i];
      if (f.alive) ctx.fillRect(f.x * 10 + 2, f.y * 10 + 2, 6, 6);
    }
  }

  function updateCounters() {
    const c = counts();
    $('[data-testid="tick"]').textContent = String(tickCount);
    $('[data-testid="count-rabbits"]').textContent = String(c.rabbits);
    $('[data-testid="count-foxes"]').textContent = String(c.foxes);
    $('[data-testid="count-grass"]').textContent = String(c.grass);
  }

  function updateChart() {
    const Wv = 420, Hv = 220, padL = 40, padR = 12, padT = 12, padB = 26;
    const maxT = Math.max(1, hist.length ? hist[hist.length - 1].tick : 1);
    let maxC = 1;
    for (let i = 0; i < hist.length; i++) {
      if (hist[i].rabbits > maxC) maxC = hist[i].rabbits;
      if (hist[i].foxes > maxC) maxC = hist[i].foxes;
    }
    const spanX = Wv - padL - padR, spanY = Hv - padB - padT;
    const rp = [], fp = [];
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      const px = padL + (h.tick / maxT) * spanX;
      rp.push(px.toFixed(2) + ',' + ((Hv - padB) - (h.rabbits / maxC) * spanY).toFixed(2));
      fp.push(px.toFixed(2) + ',' + ((Hv - padB) - (h.foxes / maxC) * spanY).toFixed(2));
    }
    rabbitLine.setAttribute('points', rp.join(' '));
    foxLine.setAttribute('points', fp.join(' '));
  }

  function updateAnnouncer() {
    if (playing) return;
    announcer.textContent = 'Tick ' + tickCount + ': ' + rabbits.length + ' rabbits, ' + foxes.length + ' foxes';
  }

  function renderAll() {
    drawWorld();
    updateCounters();
    updateChart();
    updateAnnouncer();
  }

  /* ---------------- Playback ---------------- */
  let playing = false, rafId = null, lastTs = 0, acc = 0;

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function raf(cb) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
    return setTimeout(function () { cb(nowMs()); }, 16);
  }
  function caf(id) {
    if (id === null || id === undefined) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    else clearTimeout(id);
  }
  function speedValue() {
    const v = Number(speedInput.value);
    return (isFinite(v) && v > 0) ? v : 10;
  }
  function play() {
    if (playing) return;
    playing = true;
    lastTs = 0; acc = 0;
    rafId = raf(frame);
  }
  function pause() {
    const was = playing;
    playing = false;
    caf(rafId);
    rafId = null;
    if (was || !announcer.textContent) updateAnnouncer();
  }
  function frame(ts) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    let dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (!isFinite(dt) || dt < 0) dt = 0;
    if (dt > 0.25) dt = 0.25;
    acc += dt * speedValue();
    let n = Math.floor(acc);
    if (n > 0) {
      acc -= n;
      for (let i = 0; i < n; i++) tickOnce();
      renderAll();
    }
    rafId = raf(frame);
  }

  /* ---------------- ODE ---------------- */
  function deriv(x, y, p) {
    return [
      p.alpha * x - p.beta * x * y,
      p.delta * x * y - p.gamma * y
    ];
  }
  function rk4(x, y, dt, p) {
    const d1 = deriv(x, y, p);
    const d2 = deriv(x + d1[0] * dt / 2, y + d1[1] * dt / 2, p);
    const d3 = deriv(x + d2[0] * dt / 2, y + d2[1] * dt / 2, p);
    const d4 = deriv(x + d3[0] * dt, y + d3[1] * dt, p);
    return [
      x + dt / 6 * (d1[0] + 2 * d2[0] + 2 * d3[0] + d4[0]),
      y + dt / 6 * (d1[1] + 2 * d2[1] + 2 * d3[1] + d4[1])
    ];
  }
  function ode(p, t, dt) {
    let x = Number(p.x0), y = Number(p.y0);
    const n = Math.round(t / dt);
    if (!isFinite(n) || n <= 0 || !isFinite(dt) || dt === 0) return { x: x, y: y };
    for (let i = 0; i < n; i++) {
      const r = rk4(x, y, dt, p);
      x = r[0]; y = r[1];
    }
    return { x: x, y: y };
  }
  function fmt(v) {
    return (typeof v === 'number' && isFinite(v)) ? v.toPrecision(12) : String(v);
  }
  function potential(x, y, p) {
    const xx = Math.max(x, 1e-12), yy = Math.max(y, 1e-12);
    return p.delta * x - p.gamma * Math.log(xx) + p.beta * y - p.alpha * Math.log(yy);
  }
  function numOf(tid, dflt) {
    const el = $('[data-testid="' + tid + '"]');
    const v = Number(el.value);
    return isFinite(v) ? v : dflt;
  }

  function runODE() {
    const p = {
      alpha: numOf('ode-alpha', 1.1),
      beta: numOf('ode-beta', 0.4),
      gamma: numOf('ode-gamma', 0.4),
      delta: numOf('ode-delta', 0.1),
      x0: numOf('ode-x0', 10),
      y0: numOf('ode-y0', 10)
    };
    const t = numOf('ode-t', 50);
    const dt = numOf('ode-dt', 0.01);

    let n = (dt > 0 && t > 0) ? Math.round(t / dt) : 0;
    if (!isFinite(n) || n < 0) n = 0;
    if (n > 20000) n = 20000;

    const traj = [[0, p.x0, p.y0]];
    let x = p.x0, y = p.y0;
    for (let i = 0; i < n; i++) {
      const r = rk4(x, y, dt, p);
      x = r[0]; y = r[1];
      traj.push([(i + 1) * dt, x, y]);
    }

    const fin = ode(p, t, dt);

    $('[data-testid="ode-x"]').textContent = fmt(fin.x);
    $('[data-testid="ode-y"]').textContent = fmt(fin.y);
    $('[data-testid="ode-eq-x"]').textContent = fmt(p.delta !== 0 ? p.gamma / p.delta : Infinity);
    $('[data-testid="ode-eq-y"]').textContent = fmt(p.beta !== 0 ? p.alpha / p.beta : Infinity);
    const v0 = potential(p.x0, p.y0, p);
    const v1 = potential(fin.x, fin.y, p);
    $('[data-testid="ode-drift"]').textContent = fmt(Math.abs(v1 - v0));

    /* chart */
    const Wv = 420, Hv = 200, padL = 40, padR = 12, padT = 12, padB = 26;
    const maxT = Math.max(traj[traj.length - 1][0], 1e-9);
    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < traj.length; i++) {
      if (traj[i][1] < minV) minV = traj[i][1];
      if (traj[i][1] > maxV) maxV = traj[i][1];
      if (traj[i][2] < minV) minV = traj[i][2];
      if (traj[i][2] > maxV) maxV = traj[i][2];
    }
    if (!isFinite(minV) || !isFinite(maxV)) { minV = 0; maxV = 1; }
    if (maxV - minV < 1e-12) maxV = minV + 1;
    const spanX = Wv - padL - padR, spanY = Hv - padB - padT;
    const sx = [], sy = [];
    for (let i = 0; i < traj.length; i++) {
      const px = padL + (traj[i][0] / maxT) * spanX;
      sx.push(px.toFixed(2) + ',' + ((Hv - padB) - ((traj[i][1] - minV) / (maxV - minV)) * spanY).toFixed(2));
      sy.push(px.toFixed(2) + ',' + ((Hv - padB) - ((traj[i][2] - minV) / (maxV - minV)) * spanY).toFixed(2));
    }
    odeLineX.setAttribute('points', sx.join(' '));
    odeLineY.setAttribute('points', sy.join(' '));
  }

  /* ---------------- Scenario / CSV ---------------- */
  function exportCSV() {
    const lines = ['tick,rabbits,foxes,grass'];
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      lines.push(h.tick + ',' + h.rabbits + ',' + h.foxes + ',' + h.grass);
    }
    return lines.join('\n') + '\n';
  }
  function exportScenario() {
    const params = {};
    for (let i = 0; i < PARAM_KEYS.length; i++) params[PARAM_KEYS[i]] = P[PARAM_KEYS[i]];
    return JSON.stringify({ version: 1, seed: curSeed, params: params });
  }
  function setError(msg) { errEl.textContent = msg || ''; }

  function loadScenario(text) {
    let obj = null;
    try { obj = JSON.parse(text); }
    catch (e) { setError('Could not parse scenario JSON.'); return false; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      setError('Scenario must be a JSON object.');
      return false;
    }
    if (obj.version !== 1) {
      setError('Unsupported scenario version (expected 1).');
      return false;
    }
    if (!Number.isInteger(obj.seed)) {
      setError('Scenario seed must be an integer.');
      return false;
    }
    setError('');
    const src = (obj.params && typeof obj.params === 'object') ? obj.params : {};
    const params = {};
    for (let i = 0; i < PARAM_KEYS.length; i++) {
      const k = PARAM_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(src, k)) params[k] = src[k];
    }
    seedInput.value = String(obj.seed);
    syncSliders(params);
    reset(obj.seed, params);
    return true;
  }

  function download(filename, text) {
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    } catch (e) {
      url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(text);
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    if (a.parentNode) a.parentNode.removeChild(a);
    if (url.indexOf('blob:') === 0) {
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 2000);
    }
  }

  /* ---------------- Sliders ---------------- */
  const SLIDERS = [
    ['param-rabbits0', 'rabbits0'],
    ['param-foxes0', 'foxes0'],
    ['param-rabbitBreed', 'rabbitBreed'],
    ['param-foxBreed', 'foxBreed'],
    ['param-foxGain', 'foxGain'],
    ['param-grassMax', 'grassMax']
  ];
  function sliderEls() {
    return SLIDERS.map(function (pair) {
      return { el: $('[data-testid="' + pair[0] + '"]'), out: document.getElementById('val-' + pair[1]) };
    });
  }
  function updateSliderLabels() {
    sliderEls().forEach(function (o) { if (o.out) o.out.textContent = o.el.value; });
  }
  function syncSliders(params) {
    SLIDERS.forEach(function (pair, i) {
      const el = $('[data-testid="' + pair[0] + '"]');
      const v = (params && params[pair[1]] !== undefined) ? params[pair[1]] : DEFAULTS[pair[1]];
      el.value = String(v);
    });
    updateSliderLabels();
  }
  function resetFromControls() {
    const s = Number(seedInput.value);
    const params = {
      rabbits0: Number($('[data-testid="param-rabbits0"]').value),
      foxes0: Number($('[data-testid="param-foxes0"]').value),
      rabbitBreed: Number($('[data-testid="param-rabbitBreed"]').value),
      foxBreed: Number($('[data-testid="param-foxBreed"]').value),
      foxGain: Number($('[data-testid="param-foxGain"]').value),
      grassMax: Number($('[data-testid="param-grassMax"]').value)
    };
    if (isFinite(s)) seedInput.value = String(Math.trunc(s));
    return reset(isFinite(s) ? Math.trunc(s) : 0, params);
  }

  /* ---------------- Presets ---------------- */
  function readPresets() {
    try {
      const raw = localStorage.getItem('ecolab.presets');
      if (!raw) return {};
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
      return obj;
    } catch (e) { return {}; }
  }
  function writePresets(obj) {
    try { localStorage.setItem('ecolab.presets', JSON.stringify(obj)); } catch (e) {}
  }
  function renderPresets() {
    const store = readPresets();
    presetListEl.textContent = '';
    const names = Object.keys(store);
    if (names.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = 'No saved presets yet.';
      presetListEl.appendChild(empty);
      return;
    }
    names.forEach(function (name) {
      const item = document.createElement('div');
      item.setAttribute('data-testid', 'preset-item');
      item.className = 'preset-item';
      const label = document.createElement('span');
      label.textContent = name;
      const load = document.createElement('button');
      load.type = 'button';
      load.setAttribute('data-testid', 'preset-load');
      load.textContent = 'Load';
      load.addEventListener('click', function () {
        loadScenario(JSON.stringify(store[name]));
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.setAttribute('data-testid', 'preset-delete');
      del.textContent = 'Delete';
      del.addEventListener('click', function () {
        const cur = readPresets();
        delete cur[name];
        writePresets(cur);
        renderPresets();
      });
      item.appendChild(label);
      item.appendChild(load);
      item.appendChild(del);
      presetListEl.appendChild(item);
    });
  }

  /* ---------------- Wiring ---------------- */
  $('[data-testid="play"]').addEventListener('click', play);
  $('[data-testid="pause"]').addEventListener('click', pause);
  $('[data-testid="step"]').addEventListener('click', function () { lab.step(1); });
  $('[data-testid="reset"]').addEventListener('click', function () { resetFromControls(); });
  speedInput.addEventListener('input', function () {
    speedVal.textContent = speedInput.value + ' /s';
  });
  sliderEls().forEach(function (o) {
    o.el.addEventListener('input', updateSliderLabels);
  });
  $('[data-testid="csv-export"]').addEventListener('click', function () {
    download('ecolab.csv', exportCSV());
  });
  $('[data-testid="scenario-export"]').addEventListener('click', function () {
    scenarioEl.value = exportScenario();
  });
  $('[data-testid="scenario-load"]').addEventListener('click', function () {
    loadScenario(scenarioEl.value);
  });
  $('[data-testid="ode-run"]').addEventListener('click', runODE);
  $('[data-testid="preset-save"]').addEventListener('click', function () {
    const name = (presetNameEl.value || '').trim();
    if (!name) return;
    const store = readPresets();
    store[name] = JSON.parse(exportScenario());
    writePresets(store);
    renderPresets();
  });

  document.addEventListener('keydown', function (e) {
    const a = document.activeElement;
    const tag = a && a.tagName ? a.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (playing) pause(); else play();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      lab.step(1);
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      resetFromControls();
    }
  });

  /* ---------------- Public API ---------------- */
  const lab = {
    reset: function (seed, params) { return reset(seed, params || {}); },
    step: function (n) { return step(n === undefined ? 1 : n); },
    counts: counts,
    tick: function () { return tickCount; },
    cell: function (x, y) {
      if (!(x >= 0 && y >= 0 && x < W && y < H)) return null;
      const i = idx(x, y);
      const r = gridRabbit[i], f = gridFox[i];
      return {
        grass: grass[i],
        rabbit: (r && r.alive) ? { id: r.id, energy: r.energy } : null,
        fox: (f && f.alive) ? { id: f.id, energy: f.energy } : null
      };
    },
    history: function () {
      return hist.map(function (h) {
        return { tick: h.tick, rabbits: h.rabbits, foxes: h.foxes, grass: h.grass };
      });
    },
    ode: function (p, t, dt) { return ode(p, t, dt); },
    exportCSV: exportCSV,
    exportScenario: exportScenario,
    loadScenario: function (text) { return loadScenario(String(text)); }
  };
  window.lab = lab;

  /* ---------------- Boot ---------------- */
  seedInput.value = '42';
  updateSliderLabels();
  speedVal.textContent = speedInput.value + ' /s';
  reset(42, {});
  renderPresets();
  runODE();
})();
</script>
</body>
</html>
```