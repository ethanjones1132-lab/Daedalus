## Plan

**Data model** — A `params` object merged over 13 `DEFAULTS` (width, height, grassMax, rabbits0, foxes0, rabbitStart, rabbitGain, rabbitCost, rabbitBreed, foxStart, foxGain, foxCost, foxBreed). Flat arrays sized `width*height`: `grass[i]` (0…grassMax) and occupancy arrays `rabbitGrid[i]` / `foxGrid[i]`, plus `rabbitList` / `foxList` of `{id, x, y, energy}`. One shared id counter, one `mulberry32` stream recreated only on reset, one `history` array of `{tick, rabbits, foxes, grass}`.

**Tick order** — (1) every cell's grass `min(grassMax, grass+1)`. (2) Rabbits alive at phase start, sorted by id: move to a `pick`ed rabbit-free neighbour or stay; eat `rabbitGain * grass` (cell → 0); pay `rabbitCost`; if `energy >= rabbitBreed`, `pick` a rabbit-free neighbour, child = `floor(energy/2)`, parent pays it, child placed with next id; die if `energy <= 0`. (3) Foxes alive at phase start, sorted by id: move to a `pick`ed neighbour with a rabbit and no fox, else a fox-free neighbour, else stay; eat the rabbit in the cell; pay `foxCost`; breed like rabbits but fox-free neighbours; die. (4) `tick++` and push a history point. `pick` draws one random number only for non-empty lists.

**Components** — Canvas world (10 px cells) + Play/Pause/Step/Reset, seed, speed, six parameter sliders, four counters; population SVG chart + CSV export; Lotka–Volterra panel (8 inputs, Run, RK4 results, drift, x/y traces); scenario textarea export/load with error message; localStorage presets (save, list, load, delete); `aria-live` announcer; Space/s/r shortcuts guarded against focused controls; flex layout with side-by-side regions ≥1000 px.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ecosystem Lab</title>
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{overflow-x:hidden}
body{margin:0;padding:12px;background:#eef1ec;color:#18211a;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.35}
h1{font-size:16px;margin:0 0 10px;letter-spacing:.01em}
h2{font-size:12px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.07em;color:#4c5b4d}
.muted{color:#7b8a7c;font-weight:400}
.app{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;max-width:1240px;margin:0 auto}
#panel-world{flex:1 1 500px;min-width:0}
#panel-side{flex:1 1 400px;min-width:0;display:flex;flex-direction:column;gap:14px}
.panel,.card{background:#fff;border:1px solid #d7ded7;border-radius:12px;padding:12px}
canvas{display:block;width:100%;height:auto;border-radius:8px;border:1px solid #c3cfc3;background:#123312;image-rendering:pixelated}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button{font:inherit;padding:5px 11px;border-radius:8px;border:1px solid #b6c5b6;background:#f6faf5;color:#14301a;cursor:pointer}
button:hover{background:#e8f2e6}
button:active{background:#dbe9d8}
input[type=number],input[type=text],textarea{font:inherit;padding:4px 6px;border-radius:7px;border:1px solid #b6c5b6;background:#fff;color:inherit;min-width:0}
input[type=range]{min-width:0;accent-color:#1f7a45}
textarea{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;resize:vertical}
:focus{outline:3px solid #1f7a45;outline-offset:2px}
.counters{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 12px}
.counters>div{flex:1 1 68px;min-width:66px;background:#f2f6f1;border:1px solid #dde5dd;border-radius:8px;padding:5px 8px;text-align:center}
.counters .k{display:block;font-size:10px;color:#5a6a5b;text-transform:uppercase;letter-spacing:.05em}
.counters .v{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.grid-params{display:grid;grid-template-columns:minmax(110px,1.15fr) minmax(86px,1.5fr) 40px;gap:6px 8px;align-items:center}
.grid-params label{font-size:12px;color:#2c3a2d}
.grid-params output{font-size:12px;font-variant-numeric:tabular-nums;text-align:right;color:#33433a}
.grid-ode{display:grid;grid-template-columns:repeat(auto-fit,minmax(94px,1fr));gap:8px;margin-bottom:8px}
.field{display:flex;flex-direction:column;gap:2px;min-width:0}
.field label{font-size:11px;color:#5a6a5b}
.field input{width:100%}
svg.chart{display:block;width:100%;height:auto}
.legend{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#42513f}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px}
.ode-out{font-size:12px;gap:12px;margin:8px 0;flex-wrap:wrap}
.ode-out b{font-variant-numeric:tabular-nums;font-weight:600}
.error{color:#b3261e;font-size:12px;min-height:1em}
.preset-list{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.preset-item{display:flex;align-items:center;gap:8px;background:#f6f9f5;border:1px solid #dde5dd;border-radius:8px;padding:5px 8px}
.preset-item .preset-name{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
</style>
</head>
<body>
<h1>Ecosystem Lab</h1>
<div class="app">
  <section id="panel-world" class="panel" data-testid="panel-world">
    <h2>World</h2>
    <canvas data-testid="world" width="400" height="300"></canvas>
    <div class="row" style="margin-top:10px">
      <button type="button" data-testid="play">Play</button>
      <button type="button" data-testid="pause">Pause</button>
      <button type="button" data-testid="step">Step</button>
      <button type="button" data-testid="reset">Reset</button>
    </div>
    <div class="row" style="margin-top:8px">
      <label for="seed">Seed</label>
      <input id="seed" data-testid="seed" type="number" step="1" value="42" style="width:92px">
      <label for="speed">Speed</label>
      <input id="speed" data-testid="speed" type="range" min="1" max="60" step="1" value="10" style="flex:1 1 120px">
      <output id="speed-val" for="speed">10</output>
    </div>
    <div class="counters">
      <div><span class="k">Tick</span><span class="v" data-testid="tick">0</span></div>
      <div><span class="k">Rabbits</span><span class="v" data-testid="count-rabbits">0</span></div>
      <div><span class="k">Foxes</span><span class="v" data-testid="count-foxes">0</span></div>
      <div><span class="k">Grass</span><span class="v" data-testid="count-grass">0</span></div>
    </div>
    <h2>Parameters <span class="muted">(on reset)</span></h2>
    <div class="grid-params">
      <label for="p-rabbits0">Rabbits at reset</label>
      <input id="p-rabbits0" data-testid="param-rabbits0" type="range" min="0" max="300" step="1" value="100">
      <output id="v-rabbits0">100</output>

      <label for="p-foxes0">Foxes at reset</label>
      <input id="p-foxes0" data-testid="param-foxes0" type="range" min="0" max="60" step="1" value="6">
      <output id="v-foxes0">6</output>

      <label for="p-rabbitBreed">Rabbit breed energy</label>
      <input id="p-rabbitBreed" data-testid="param-rabbitBreed" type="range" min="2" max="40" step="1" value="12">
      <output id="v-rabbitBreed">12</output>

      <label for="p-foxBreed">Fox breed energy</label>
      <input id="p-foxBreed" data-testid="param-foxBreed" type="range" min="2" max="60" step="1" value="40">
      <output id="v-foxBreed">40</output>

      <label for="p-foxGain">Fox gain</label>
      <input id="p-foxGain" data-testid="param-foxGain" type="range" min="1" max="30" step="1" value="4">
      <output id="v-foxGain">4</output>

      <label for="p-grassMax">Max grass</label>
      <input id="p-grassMax" data-testid="param-grassMax" type="range" min="1" max="10" step="1" value="4">
      <output id="v-grassMax">4</output>
    </div>
  </section>

  <section id="panel-side" data-testid="panel-side">
    <div class="card">
      <h2>Populations</h2>
      <svg class="chart" data-testid="chart" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Population history chart">
        <rect x="34" y="10" width="356" height="166" fill="#fbfdfa" stroke="#e2e8e2"></rect>
        <polyline data-testid="series-rabbits" fill="none" stroke="#3b6fd4" stroke-width="1.6" stroke-linejoin="round" points=""></polyline>
        <polyline data-testid="series-foxes" fill="none" stroke="#d4552a" stroke-width="1.6" stroke-linejoin="round" points=""></polyline>
        <text x="200" y="194" text-anchor="middle" font-size="11" fill="#4c5b4d">tick</text>
        <text x="4" y="18" font-size="11" fill="#4c5b4d">count</text>
      </svg>
      <div class="row" style="margin-top:8px">
        <span class="legend"><i style="background:#3b6fd4"></i>Rabbits</span>
        <span class="legend"><i style="background:#d4552a"></i>Foxes</span>
        <button type="button" data-testid="csv-export" style="margin-left:auto">Export CSV</button>
      </div>
    </div>

    <div class="card">
      <h2>Lotka&ndash;Volterra</h2>
      <div class="grid-ode">
        <div class="field"><label for="ode-alpha">alpha</label><input id="ode-alpha" data-testid="ode-alpha" type="number" step="0.01" value="1.1"></div>
        <div class="field"><label for="ode-beta">beta</label><input id="ode-beta" data-testid="ode-beta" type="number" step="0.01" value="0.4"></div>
        <div class="field"><label for="ode-gamma">gamma</label><input id="ode-gamma" data-testid="ode-gamma" type="number" step="0.01" value="0.4"></div>
        <div class="field"><label for="ode-delta">delta</label><input id="ode-delta" data-testid="ode-delta" type="number" step="0.01" value="0.1"></div>
        <div class="field"><label for="ode-x0">x0</label><input id="ode-x0" data-testid="ode-x0" type="number" step="0.1" value="10"></div>
        <div class="field"><label for="ode-y0">y0</label><input id="ode-y0" data-testid="ode-y0" type="number" step="0.1" value="10"></div>
        <div class="field"><label for="ode-t">t</label><input id="ode-t" data-testid="ode-t" type="number" step="1" value="50"></div>
        <div class="field"><label for="ode-dt">dt</label><input id="ode-dt" data-testid="ode-dt" type="number" step="0.001" value="0.01"></div>
      </div>
      <div class="row"><button type="button" data-testid="ode-run">Run</button></div>
      <div class="row ode-out">
        <span>x = <b data-testid="ode-x">&ndash;</b></span>
        <span>y = <b data-testid="ode-y">&ndash;</b></span>
        <span>x* = <b data-testid="ode-eq-x">&ndash;</b></span>
        <span>y* = <b data-testid="ode-eq-y">&ndash;</b></span>
        <span>drift = <b data-testid="ode-drift">&ndash;</b></span>
      </div>
      <svg class="chart" data-testid="ode-chart" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Lotka-Volterra trajectory">
        <rect x="34" y="10" width="356" height="166" fill="#fbfdfa" stroke="#e2e8e2"></rect>
        <polyline data-testid="ode-series-x" fill="none" stroke="#3b6fd4" stroke-width="1.4" points=""></polyline>
        <polyline data-testid="ode-series-y" fill="none" stroke="#d4552a" stroke-width="1.4" points=""></polyline>
        <text x="200" y="194" text-anchor="middle" font-size="11" fill="#4c5b4d">time</text>
        <text x="4" y="18" font-size="11" fill="#4c5b4d">value</text>
      </svg>
    </div>

    <div class="card">
      <h2>Scenario</h2>
      <textarea data-testid="scenario-json" rows="4" spellcheck="false" placeholder='{"version":1,"seed":42,"params":{}}'></textarea>
      <div class="row" style="margin-top:6px">
        <button type="button" data-testid="scenario-export">Export scenario</button>
        <button type="button" data-testid="scenario-load">Load scenario</button>
      </div>
      <div class="error" data-testid="scenario-error"></div>
    </div>

    <div class="card">
      <h2>Presets</h2>
      <div class="row">
        <input data-testid="preset-name" type="text" placeholder="Preset name" style="flex:1 1 120px">
        <button type="button" data-testid="preset-save">Save preset</button>
      </div>
      <div class="preset-list" data-testid="preset-list"></div>
    </div>
  </section>
</div>

<div id="announcer" data-testid="announcer" aria-live="polite" class="sr-only"></div>

<script>
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Randomness                                                          */
  /* ------------------------------------------------------------------ */
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

  const DEFAULTS = {
    width: 40, height: 30, grassMax: 4,
    rabbits0: 100, foxes0: 6,
    rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
    foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
  };

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  let params = Object.assign({}, DEFAULTS);
  let rand = mulberry32(42);
  let currentSeed = 42;
  let tickNum = 0;
  let nextId = 1;
  let grass = [];
  let rabbitGrid = [];
  let foxGrid = [];
  let rabbitList = [];
  let foxList = [];
  let historyArr = [];

  let playing = false;
  let rafId = null;
  let lastTs = 0;
  let acc = 0;

  const now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };
  const requestFrame = (typeof requestAnimationFrame === 'function')
    ? function (cb) { return requestAnimationFrame(cb); }
    : function (cb) { return setTimeout(function () { cb(now()); }, 16); };
  const cancelFrame = (typeof cancelAnimationFrame === 'function')
    ? function (id) { return cancelAnimationFrame(id); }
    : function (id) { return clearTimeout(id); };

  /* ------------------------------------------------------------------ */
  /* DOM references                                                      */
  /* ------------------------------------------------------------------ */
  const q = function (sel) { return document.querySelector(sel); };

  const canvas = q('[data-testid="world"]');
  const ctx2d = canvas ? canvas.getContext('2d') : null;
  const elTick = q('[data-testid="tick"]');
  const elRabbits = q('[data-testid="count-rabbits"]');
  const elFoxes = q('[data-testid="count-foxes"]');
  const elGrass = q('[data-testid="count-grass"]');
  const seedEl = q('[data-testid="seed"]');
  const speedEl = q('[data-testid="speed"]');
  const speedOut = q('#speed-val');
  const announcer = q('[data-testid="announcer"]');
  const seriesRabbits = q('[data-testid="series-rabbits"]');
  const seriesFoxes = q('[data-testid="series-foxes"]');
  const errorEl = q('[data-testid="scenario-error"]');
  const scenarioJson = q('[data-testid="scenario-json"]');
  const presetName = q('[data-testid="preset-name"]');
  const presetList = q('[data-testid="preset-list"]');

  const odeSeriesX = q('[data-testid="ode-series-x"]');
  const odeSeriesY = q('[data-testid="ode-series-y"]');

  const paramControls = [
    { key: 'rabbits0', input: q('[data-testid="param-rabbits0"]'), out: q('#v-rabbits0') },
    { key: 'foxes0', input: q('[data-testid="param-foxes0"]'), out: q('#v-foxes0') },
    { key: 'rabbitBreed', input: q('[data-testid="param-rabbitBreed"]'), out: q('#v-rabbitBreed') },
    { key: 'foxBreed', input: q('[data-testid="param-foxBreed"]'), out: q('#v-foxBreed') },
    { key: 'foxGain', input: q('[data-testid="param-foxGain"]'), out: q('#v-foxGain') },
    { key: 'grassMax', input: q('[data-testid="param-grassMax"]'), out: q('#v-grassMax') }
  ];

  /* ------------------------------------------------------------------ */
  /* Grid helpers                                                        */
  /* ------------------------------------------------------------------ */
  function neighbors(x, y, w, h) {
    const out = [];
    if (y - 1 >= 0) out.push((y - 1) * w + x);
    if (x + 1 < w) out.push(y * w + (x + 1));
    if (y + 1 < h) out.push((y + 1) * w + x);
    if (x - 1 >= 0) out.push(y * w + (x - 1));
    return out;
  }

  function pick(list) {
    if (!list || list.length === 0) return -1;
    return list[Math.floor(rand() * list.length)];
  }

  function grassTotal() {
    let g = 0;
    for (let i = 0; i < grass.length; i++) g += grass[i];
    return g;
  }

  function recordHistory() {
    historyArr.push({
      tick: tickNum,
      rabbits: rabbitList.length,
      foxes: foxList.length,
      grass: grassTotal()
    });
  }

  /* ------------------------------------------------------------------ */
  /* Reset                                                               */
  /* ------------------------------------------------------------------ */
  function reset(seed, p) {
    params = Object.assign({}, DEFAULTS, p || {});
    const s = Math.trunc(Number(seed));
    currentSeed = Number.isFinite(s) ? s : 0;
    rand = mulberry32(currentSeed);
    tickNum = 0;
    nextId = 1;
    historyArr = [];

    const w = params.width, h = params.height, size = w * h;

    grass = new Array(size);
    for (let i = 0; i < size; i++) {
      grass[i] = Math.floor(rand() * (params.grassMax + 1));
    }

    rabbitGrid = new Array(size).fill(null);
    foxGrid = new Array(size).fill(null);
    rabbitList = [];
    foxList = [];

    for (let i = 0; i < params.rabbits0; i++) {
      const free = [];
      for (let j = 0; j < size; j++) if (!rabbitGrid[j]) free.push(j);
      const spot = pick(free);
      if (spot < 0) break;
      const r = { id: nextId++, x: spot % w, y: Math.floor(spot / w), energy: params.rabbitStart };
      rabbitGrid[spot] = r;
      rabbitList.push(r);
    }

    for (let i = 0; i < params.foxes0; i++) {
      const free = [];
      for (let j = 0; j < size; j++) if (!foxGrid[j]) free.push(j);
      const spot = pick(free);
      if (spot < 0) break;
      const f = { id: nextId++, x: spot % w, y: Math.floor(spot / w), energy: params.foxStart };
      foxGrid[spot] = f;
      foxList.push(f);
    }

    recordHistory();
    updateAll();
  }

  /* ------------------------------------------------------------------ */
  /* One tick                                                            */
  /* ------------------------------------------------------------------ */
  function stepOnce() {
    const w = params.width, h = params.height, size = w * h;

    // 1. grass grows
    for (let i = 0; i < size; i++) {
      if (grass[i] < params.grassMax) grass[i] += 1;
    }

    // 2. rabbits
    const bunnySnapshot = rabbitList.slice().sort(function (a, b) { return a.id - b.id; });
    for (let k = 0; k < bunnySnapshot.length; k++) {
      const r = bunnySnapshot[k];
      let ci = r.y * w + r.x;
      if (rabbitGrid[ci] !== r) continue;

      // move
      const nb = neighbors(r.x, r.y, w, h);
      const freeNb = nb.filter(function (i) { return !rabbitGrid[i]; });
      if (freeNb.length) {
        const spot = pick(freeNb);
        rabbitGrid[ci] = null;
        r.x = spot % w;
        r.y = Math.floor(spot / w);
        rabbitGrid[spot] = r;
      }

      // eat
      ci = r.y * w + r.x;
      r.energy += params.rabbitGain * grass[ci];
      grass[ci] = 0;

      // cost
      r.energy -= params.rabbitCost;

      // breed
      if (r.energy >= params.rabbitBreed) {
        const breedNb = neighbors(r.x, r.y, w, h).filter(function (i) { return !rabbitGrid[i]; });
        if (breedNb.length) {
          const spot = pick(breedNb);
          const childEnergy = Math.floor(r.energy / 2);
          r.energy -= childEnergy;
          const child = {
            id: nextId++,
            x: spot % w,
            y: Math.floor(spot / w),
            energy: childEnergy
          };
          rabbitGrid[spot] = child;
          rabbitList.push(child);
        }
      }

      // die
      if (r.energy <= 0) {
        rabbitGrid[r.y * w + r.x] = null;
        const idx = rabbitList.indexOf(r);
        if (idx >= 0) rabbitList.splice(idx, 1);
      }
    }

    // 3. foxes
    const foxSnapshot = foxList.slice().sort(function (a, b) { return a.id - b.id; });
    for (let k = 0; k < foxSnapshot.length; k++) {
      const f = foxSnapshot[k];
      let ci = f.y * w + f.x;
      if (foxGrid[ci] !== f) continue;

      // move
      const nb = neighbors(f.x, f.y, w, h);
      const preyNb = nb.filter(function (i) { return rabbitGrid[i] && !foxGrid[i]; });
      let target = -1;
      if (preyNb.length) {
        target = pick(preyNb);
      } else {
        const freeNb = nb.filter(function (i) { return !foxGrid[i]; });
        if (freeNb.length) target = pick(freeNb);
      }
      if (target >= 0) {
        foxGrid[ci] = null;
        f.x = target % w;
        f.y = Math.floor(target / w);
        foxGrid[target] = f;
      }

      // eat
      ci = f.y * w + f.x;
      const victim = rabbitGrid[ci];
      if (victim) {
        rabbitGrid[ci] = null;
        const idx = rabbitList.indexOf(victim);
        if (idx >= 0) rabbitList.splice(idx, 1);
        f.energy += params.foxGain;
      }

      // cost
      f.energy -= params.foxCost;

      // breed
      if (f.energy >= params.foxBreed) {
        const breedNb = neighbors(f.x, f.y, w, h).filter(function (i) { return !foxGrid[i]; });
        if (breedNb.length) {
          const spot = pick(breedNb);
          const childEnergy = Math.floor(f.energy / 2);
          f.energy -= childEnergy;
          const child = {
            id: nextId++,
            x: spot % w,
            y: Math.floor(spot / w),
            energy: childEnergy
          };
          foxGrid[spot] = child;
          foxList.push(child);
        }
      }

      // die
      if (f.energy <= 0) {
        foxGrid[f.y * w + f.x] = null;
        const idx = foxList.indexOf(f);
        if (idx >= 0) foxList.splice(idx, 1);
      }
    }

    // 4. advance
    tickNum += 1;
    recordHistory();
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */
  function draw() {
    if (!canvas || !ctx2d) return;
    const w = params.width, h = params.height;
    const cw = w * 10, ch = h * 10;
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;

    ctx2d.clearRect(0, 0, cw, ch);

    const gm = params.grassMax;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = grass[y * w + x];
        const G = 60 + Math.round(160 * g / gm);
        ctx2d.fillStyle = 'rgb(30,' + G + ',30)';
        ctx2d.fillRect(x * 10, y * 10, 10, 10);
      }
    }

    ctx2d.fillStyle = 'rgb(240,240,240)';
    for (let i = 0; i < rabbitList.length; i++) {
      const r = rabbitList[i];
      ctx2d.fillRect(r.x * 10 + 2, r.y * 10 + 2, 6, 6);
    }

    ctx2d.fillStyle = 'rgb(220,80,20)';
    for (let i = 0; i < foxList.length; i++) {
      const f = foxList[i];
      ctx2d.fillRect(f.x * 10 + 2, f.y * 10 + 2, 6, 6);
    }
  }

  function updateCounters() {
    elTick.textContent = String(tickNum);
    elRabbits.textContent = String(rabbitList.length);
    elFoxes.textContent = String(foxList.length);
    elGrass.textContent = String(grassTotal());
  }

  function updateChart() {
    const n = historyArr.length;
    const lastTick = n ? historyArr[n - 1].tick : 0;
    const maxTick = Math.max(1, lastTick);
    let maxCount = 1;
    for (let i = 0; i < n; i++) {
      if (historyArr[i].rabbits > maxCount) maxCount = historyArr[i].rabbits;
      if (historyArr[i].foxes > maxCount) maxCount = historyArr[i].foxes;
    }
    const X = function (t) { return 34 + (t / maxTick) * 356; };
    const Y = function (v) { return 176 - (v / maxCount) * 166; };

    let pr = '', pf = '';
    for (let i = 0; i < n; i++) {
      const hpt = historyArr[i];
      const px = X(hpt.tick).toFixed(1);
      if (i) { pr += ' '; pf += ' '; }
      pr += px + ',' + Y(hpt.rabbits).toFixed(1);
      pf += px + ',' + Y(hpt.foxes).toFixed(1);
    }
    seriesRabbits.setAttribute('points', pr);
    seriesFoxes.setAttribute('points', pf);
  }

  function updateAnnouncer() {
    if (!announcer) return;
    announcer.textContent = 'Tick ' + tickNum + ': ' + rabbitList.length +
      ' rabbits, ' + foxList.length + ' foxes';
  }

  function updateAll() {
    draw();
    updateCounters();
    updateChart();
    if (!playing) updateAnnouncer();
  }

  function advance(n) {
    for (let i = 0; i < n; i++) stepOnce();
    updateAll();
  }

  /* ------------------------------------------------------------------ */
  /* Playback                                                            */
  /* ------------------------------------------------------------------ */
  function frame(ts) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    let dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.25) dt = 0.25;
    acc += dt * Number(speedEl.value || 10);
    let n = Math.floor(acc);
    if (n > 0) {
      acc -= n;
      if (n > 2000) n = 2000;
      advance(n);
    }
    rafId = requestFrame(frame);
  }

  function play() {
    if (playing) return;
    playing = true;
    lastTs = 0;
    acc = 0;
    rafId = requestFrame(frame);
  }

  function pause() {
    if (!playing) return;
    playing = false;
    if (rafId !== null) cancelFrame(rafId);
    rafId = null;
    updateAll();
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */
  function counts() {
    return { rabbits: rabbitList.length, foxes: foxList.length, grass: grassTotal() };
  }

  function cellAt(x, y) {
    const w = params.width, h = params.height;
    if (!(x >= 0 && y >= 0 && x < w && y < h)) {
      return { grass: 0, rabbit: null, fox: null };
    }
    const i = y * w + x;
    const r = rabbitGrid[i];
    const f = foxGrid[i];
    return {
      grass: grass[i],
      rabbit: r ? { id: r.id, energy: r.energy } : null,
      fox: f ? { id: f.id, energy: f.energy } : null
    };
  }

  function history() {
    return historyArr.map(function (h) {
      return { tick: h.tick, rabbits: h.rabbits, foxes: h.foxes, grass: h.grass };
    });
  }

  function lvDerivs(alpha, beta, gamma, delta, x, y) {
    return [alpha * x - beta * x * y, delta * x * y - gamma * y];
  }

  function integrateLV(alpha, beta, gamma, delta, x0, y0, t, dt) {
    const pts = [[0, x0, y0]];
    if (!(dt > 0) || !(t > 0) || !Number.isFinite(dt) || !Number.isFinite(t)) return pts;
    const n = Math.round(t / dt);
    if (!Number.isFinite(n) || n <= 0) return pts;
    let x = x0, y = y0;
    const half = dt / 2;
    for (let i = 0; i < n; i++) {
      const k1 = lvDerivs(alpha, beta, gamma, delta, x, y);
      const k2 = lvDerivs(alpha, beta, gamma, delta, x + half * k1[0], y + half * k1[1]);
      const k3 = lvDerivs(alpha, beta, gamma, delta, x + half * k2[0], y + half * k2[1]);
      const k4 = lvDerivs(alpha, beta, gamma, delta, x + dt * k3[0], y + dt * k3[1]);
      x += (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      y += (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      pts.push