## Plan

**Data model**
- `cfg`: `Object.assign({}, DEFAULTS, params)` — always merged over the 13 defaults, never over current values.
- World arrays sized `W*H`: `grass[]` (int), `rabbitAt[]`, `foxAt[]` (animal ref or null). Animal lists `rabbits[]`, `foxes[]` hold `{id, x, y, energy, dead}`; ids from one global counter starting at 1 (reset each `reset`).
- `rand = mulberry32(seed)`, one stream per reset; `pick(list)` draws one number only when non-empty.
- `hist[]` of `{tick, rabbits, foxes, grass}`; `tickNum`, `currentSeed`.

**Tick order**
1. Grass: `min(grassMax, g+1)` for every cell, row-major.
2. Rabbits: snapshot = alive at phase start, sorted by id (children excluded). Each: move to `pick(neighbours with no rabbit)` else stay → eat `rabbitGain*grass`, zero the cell → `-rabbitCost` → breed if `energy >= rabbitBreed` (pick free neighbour, `child=floor(e/2)`, parent loses child) → remove if `energy <= 0` (freeing its cell immediately).
3. Foxes: snapshot sorted by id. Each: move to `pick(rabbits & no fox)` else `pick(no fox)` else stay → eat rabbit in cell (`+foxGain`) → `-foxCost` → breed if `energy >= foxBreed` (neighbours with no fox) → die if `energy <= 0`.
4. `tickNum++`, push history point (grass = sum of levels).

**Components**
- `panel-world`: `<canvas data-testid="world">` (backing `W*10 × H*10`), play/pause/step/reset buttons, seed + speed inputs, counters, 6 parameter sliders, announcer.
- `panel-side`: population SVG chart (rabbit/fox polylines, tick/count labels), Lotka–Volterra panel (8 inputs, RK4 run, x/y/eq/drift, ode SVG), scenario textarea + export/load/CSV, presets backed by `localStorage["ecolab.presets"]`.
- `window.lab`: `reset, step, counts, tick, cell, history, ode, exportCSV, exportScenario, loadScenario`.
- rAF loop accumulating elapsed-time × speed; keyboard shortcuts on the document when no form control is focused.

## Code

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ecosystem Lab</title>
<style>
  :root{
    --bg:#eef2ee; --panel:#ffffff; --line:#d3dbd3; --ink:#16281a; --muted:#5c6b5e;
    --accent:#2f7d3a; --soft:#f0f4f0;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:var(--bg); color:var(--ink); padding:14px;
    font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  h1{font-size:19px;margin:0 0 12px;letter-spacing:.2px}
  h2{font-size:12px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted)}
  .app{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;max-width:1360px;margin:0 auto}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;min-width:0}
  #panel-world{flex:1 1 420px;min-width:0;max-width:560px}
  #panel-side{flex:1 1 460px;min-width:0;display:flex;flex-direction:column;gap:14px}
  canvas#world{display:block;width:100%;height:auto;max-width:100%;border-radius:6px;background:#081408}
  .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
  button{
    font:inherit;padding:6px 11px;border-radius:7px;border:1px solid var(--line);
    background:#fff;color:var(--ink);cursor:pointer;
  }
  button:hover{background:var(--soft)}
  button:active{transform:translateY(1px)}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button.primary:hover{background:#286b32}
  input,textarea,select{font:inherit}
  input[type=number],input[type=text]{
    padding:5px 7px;border:1px solid var(--line);border-radius:7px;background:#fff;color:inherit;min-width:0;
  }
  input[type=number]{width:90px}
  input[type=range]{accent-color:var(--accent);min-width:0}
  :focus{outline:3px solid var(--accent);outline-offset:2px}
  .counters{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .counter{
    background:var(--soft);border:1px solid #dde5dd;border-radius:8px;padding:5px 10px;
    display:flex;gap:6px;align-items:baseline;font-variant-numeric:tabular-nums;font-size:12px;color:var(--muted);
  }
  .counter b,.counter span:last-child{font-weight:700;font-size:15px;color:var(--ink)}
  .params{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 14px;margin-top:12px}
  .param{display:grid;grid-template-columns:1fr auto;gap:2px 6px;align-items:center}
  .param label{font-size:12px;color:var(--muted)}
  .param input[type=range]{grid-column:1/3;width:100%}
  .pval{font-variant-numeric:tabular-nums;font-weight:700;font-size:13px}
  .announcer{margin-top:10px;font-size:12px;color:var(--muted)}
  svg.chart{display:block;width:100%;height:auto;max-width:100%}
  .axis{font-size:10px;fill:var(--muted)}
  .gl{stroke:#e3e9e3;stroke-width:1}
  .legend{display:flex;gap:14px;font-size:12px;color:var(--muted);margin-top:6px;flex-wrap:wrap}
  .swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
  .ode-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:8px}
  .ode-field{display:flex;flex-direction:column;gap:2px;min-width:0}
  .ode-field label{font-size:11px;color:var(--muted)}
  .ode-field input{width:100%;padding:4px 6px;border:1px solid var(--line);border-radius:6px;font-size:12px}
  .ode-out{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;font-size:12px;color:var(--muted);
           font-variant-numeric:tabular-nums}
  .ode-out b{color:var(--ink);font-weight:600}
  textarea{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;
           padding:7px;border:1px solid var(--line);border-radius:8px;resize:vertical;color:inherit;background:#fff}
  .err{color:#a32020;font-size:12px;min-height:1.2em;margin-top:6px}
  .preset-item{
    display:flex;gap:8px;align-items:center;justify-content:space-between;
    padding:6px 8px;border:1px solid var(--line);border-radius:8px;margin-top:6px;background:#fbfdfb;
  }
  .preset-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .preset-item button{padding:3px 9px;font-size:12px}
  .empty{font-size:12px;color:var(--muted);margin-top:6px}
  .hint{font-size:11px;color:var(--muted);margin-top:6px}
  @media (max-width:699px){
    #panel-side{flex-basis:100%}
    #panel-world{flex-basis:100%;max-width:none}
  }
</style>
</head>
<body>
<h1>Ecosystem Lab</h1>
<div class="app">

  <section id="panel-world" data-testid="panel-world" class="card">
    <canvas data-testid="world" width="400" height="300"></canvas>

    <div class="row">
      <button data-testid="play" id="btn-play" class="primary">Play</button>
      <button data-testid="pause" id="btn-pause">Pause</button>
      <button data-testid="step" id="btn-step">Step</button>
      <button data-testid="reset" id="btn-reset">Reset</button>
    </div>

    <div class="row">
      <label for="seed">Seed</label>
      <input id="seed" data-testid="seed" type="number" step="1" value="42">
      <label for="speed">Speed</label>
      <input id="speed" data-testid="speed" type="range" min="1" max="60" value="10">
      <span id="speed-label" class="pval">10 /s</span>
    </div>

    <div class="counters">
      <div class="counter"><span>Tick</span><span data-testid="tick">0</span></div>
      <div class="counter"><span>Rabbits</span><span data-testid="count-rabbits">0</span></div>
      <div class="counter"><span>Foxes</span><span data-testid="count-foxes">0</span></div>
      <div class="counter"><span>Grass</span><span data-testid="count-grass">0</span></div>
    </div>

    <div class="params">
      <div class="param">
        <label for="param-rabbits0">Rabbits at start</label>
        <span class="pval" id="val-rabbits0">100</span>
        <input id="param-rabbits0" data-testid="param-rabbits0" type="range" min="0" max="300" value="100">
      </div>
      <div class="param">
        <label for="param-foxes0">Foxes at start</label>
        <span class="pval" id="val-foxes0">6</span>
        <input id="param-foxes0" data-testid="param-foxes0" type="range" min="0" max="60" value="6">
      </div>
      <div class="param">
        <label for="param-rabbitBreed">Rabbit breed energy</label>
        <span class="pval" id="val-rabbitBreed">12</span>
        <input id="param-rabbitBreed" data-testid="param-rabbitBreed" type="range" min="2" max="40" value="12">
      </div>
      <div class="param">
        <label for="param-foxBreed">Fox breed energy</label>
        <span class="pval" id="val-foxBreed">40</span>
        <input id="param-foxBreed" data-testid="param-foxBreed" type="range" min="2" max="60" value="40">
      </div>
      <div class="param">
        <label for="param-foxGain">Fox gain per rabbit</label>
        <span class="pval" id="val-foxGain">4</span>
        <input id="param-foxGain" data-testid="param-foxGain" type="range" min="1" max="30" value="4">
      </div>
      <div class="param">
        <label for="param-grassMax">Max grass</label>
        <span class="pval" id="val-grassMax">4</span>
        <input id="param-grassMax" data-testid="param-grassMax" type="range" min="1" max="10" value="4">
      </div>
    </div>

    <div id="announcer" data-testid="announcer" aria-live="polite" class="announcer">Tick 0: 0 rabbits, 0 foxes</div>
    <div class="hint">Shortcuts: Space = play/pause, S = step, R = reset (when no control is focused).</div>
  </section>

  <section id="panel-side" data-testid="panel-side">
    <div class="card">
      <h2>Population</h2>
      <svg class="chart" data-testid="chart" viewBox="0 0 340 160" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Population chart">
        <line class="gl" x1="38" y1="132" x2="330" y2="132"></line>
        <line class="gl" x1="38" y1="18" x2="38" y2="132"></line>
        <polyline data-testid="series-rabbits" fill="none" stroke="#2f7d3a" stroke-width="1.6" points=""></polyline>
        <polyline data-testid="series-foxes" fill="none" stroke="#b34a1e" stroke-width="1.6" points=""></polyline>
        <text class="axis" x="330" y="150" text-anchor="end">tick</text>
        <text class="axis" x="6" y="14">count</text>
      </svg>
      <div class="legend">
        <span><span class="swatch" style="background:#2f7d3a"></span>Rabbits</span>
        <span><span class="swatch" style="background:#b34a1e"></span>Foxes</span>
      </div>
    </div>

    <div class="card">
      <h2>Lotka&ndash;Volterra</h2>
      <div class="ode-grid">
        <div class="ode-field"><label for="ode-alpha">&alpha;</label><input id="ode-alpha" data-testid="ode-alpha" type="number" step="any" value="1.1"></div>
        <div class="ode-field"><label for="ode-beta">&beta;</label><input id="ode-beta" data-testid="ode-beta" type="number" step="any" value="0.4"></div>
        <div class="ode-field"><label for="ode-gamma">&gamma;</label><input id="ode-gamma" data-testid="ode-gamma" type="number" step="any" value="0.4"></div>
        <div class="ode-field"><label for="ode-delta">&delta;</label><input id="ode-delta" data-testid="ode-delta" type="number" step="any" value="0.1"></div>
        <div class="ode-field"><label for="ode-x0">x0</label><input id="ode-x0" data-testid="ode-x0" type="number" step="any" value="10"></div>
        <div class="ode-field"><label for="ode-y0">y0</label><input id="ode-y0" data-testid="ode-y0" type="number" step="any" value="10"></div>
        <div class="ode-field"><label for="ode-t">t</label><input id="ode-t" data-testid="ode-t" type="number" step="any" value="50"></div>
        <div class="ode-field"><label for="ode-dt">dt</label><input id="ode-dt" data-testid="ode-dt" type="number" step="any" value="0.01"></div>
      </div>
      <div class="row"><button data-testid="ode-run" id="ode-run" class="primary">Run ODE</button></div>
      <div class="ode-out">
        <span>x: <b data-testid="ode-x">10</b></span>
        <span>y: <b data-testid="ode-y">10</b></span>
        <span>eq x: <b data-testid="ode-eq-x">4</b></span>
        <span>eq y: <b data-testid="ode-eq-y">2.75</b></span>
        <span>drift: <b data-testid="ode-drift">0</b></span>
      </div>
      <svg class="chart" data-testid="ode-chart" viewBox="0 0 340 160" preserveAspectRatio="xMidYMid meet" role="img" aria-label="ODE chart">
        <line class="gl" x1="38" y1="132" x2="330" y2="132"></line>
        <line class="gl" x1="38" y1="18" x2="38" y2="132"></line>
        <polyline data-testid="ode-series-x" fill="none" stroke="#2f7d3a" stroke-width="1.4" points=""></polyline>
        <polyline data-testid="ode-series-y" fill="none" stroke="#b34a1e" stroke-width="1.4" points=""></polyline>
        <text class="axis" x="330" y="150" text-anchor="end">time</text>
        <text class="axis" x="6" y="14">value</text>
      </svg>
    </div>

    <div class="card">
      <h2>Scenario</h2>
      <textarea data-testid="scenario-json" id="scenario-json" rows="4" spellcheck="false"></textarea>
      <div class="row">
        <button data-testid="scenario-export" id="scenario-export">Export scenario</button>
        <button data-testid="scenario-load" id="scenario-load">Load scenario</button>
        <button data-testid="csv-export" id="csv-export">Download CSV</button>
      </div>
      <div class="err" data-testid="scenario-error" id="scenario-error"></div>
    </div>

    <div class="card">
      <h2>Presets</h2>
      <div class="row">
        <input data-testid="preset-name" id="preset-name" type="text" placeholder="Preset name">
        <button data-testid="preset-save" id="preset-save">Save preset</button>
      </div>
      <div data-testid="preset-list" id="preset-list"></div>
    </div>
  </section>
</div>

<script>
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Random
   * ------------------------------------------------------------------ */
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

  /* ------------------------------------------------------------------ *
   * Defaults
   * ------------------------------------------------------------------ */
  const DEFAULTS = Object.freeze({
    width: 40, height: 30, grassMax: 4,
    rabbits0: 100, foxes0: 6,
    rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
    foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
  });

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  let cfg = Object.assign({}, DEFAULTS);
  let rand = mulberry32(42);
  let currentSeed = 42;
  let tickNum = 0;
  let nextId = 1;
  let W = DEFAULTS.width, H = DEFAULTS.height;
  let grass = [];
  let rabbitAt = [];
  let foxAt = [];
  let rabbits = [];
  let foxes = [];
  let hist = [];

  let playing = false;
  let rafId = null;
  let lastTs = 0;
  let acc = 0;

  /* ------------------------------------------------------------------ *
   * DOM refs
   * ------------------------------------------------------------------ */
  const $id = function (i) { return document.getElementById(i); };
  const q = function (s) { return document.querySelector(s); };

  const canvas = q('[data-testid="world"]');
  const elTick = q('[data-testid="tick"]');
  const elR = q('[data-testid="count-rabbits"]');
  const elF = q('[data-testid="count-foxes"]');
  const elG = q('[data-testid="count-grass"]');
  const seedInput = q('[data-testid="seed"]');
  const speedInput = q('[data-testid="speed"]');
  const speedLabel = $id('speed-label');
  const announcer = q('[data-testid="announcer"]');
  const polyR = q('[data-testid="series-rabbits"]');
  const polyF = q('[data-testid="series-foxes"]');
  const polyOX = q('[data-testid="ode-series-x"]');
  const polyOY = q('[data-testid="ode-series-y"]');
  const errEl = q('[data-testid="scenario-error"]');
  const scenarioText = q('[data-testid="scenario-json"]');
  const presetList = q('[data-testid="preset-list"]');
  const presetName = q('[data-testid="preset-name"]');

  const SLIDERS = {
    rabbits0: $id('param-rabbits0'),
    foxes0: $id('param-foxes0'),
    rabbitBreed: $id('param-rabbitBreed'),
    foxBreed: $id('param-foxBreed'),
    foxGain: $id('param-foxGain'),
    grassMax: $id('param-grassMax')
  };
  const SLIDER_VALS = {
    rabbits0: $id('val-rabbits0'),
    foxes0: $id('val-foxes0'),
    rabbitBreed: $id('val-rabbitBreed'),
    foxBreed: $id('val-foxBreed'),
    foxGain: $id('val-foxGain'),
    grassMax: $id('val-grassMax')
  };

  /* ------------------------------------------------------------------ *
   * Core helpers
   * ------------------------------------------------------------------ */
  function pick(list) {
    if (!list.length) return undefined;
    return list[Math.floor(rand() * list.length)];
  }

  function neighbours(x, y) {
    const out = [];
    if (y - 1 >= 0) out.push([x, y - 1]);
    if (x + 1 < W) out.push([x + 1, y]);
    if (y + 1 < H) out.push([x, y + 1]);
    if (x - 1 >= 0) out.push([x - 1, y]);
    return out;
  }

  function grassSum() {
    let s = 0;
    for (let i = 0; i < grass.length; i++) s += grass[i];
    return s;
  }

  function counts() {
    return { rabbits: rabbits.length, foxes: foxes.length, grass: grassSum() };
  }

  function record() {
    hist.push({
      tick: tickNum,
      rabbits: rabbits.length,
      foxes: foxes.length,
      grass: grassSum()
    });
  }

  /* ------------------------------------------------------------------ *
   * Reset
   * ------------------------------------------------------------------ */
  function doReset(seed, params) {
    cfg = Object.assign({}, DEFAULTS, params || {});
    W = cfg.width | 0;
    H = cfg.height | 0;
    currentSeed = seed;
    rand = mulberry32(seed);
    tickNum = 0;
    nextId = 1;

    const N = W * H;
    grass = new Array(N);
    rabbitAt = new Array(N);
    foxAt = new Array(N);
    for (let i = 0; i < N; i++) { grass[i] = 0; rabbitAt[i] = null; foxAt[i] = null; }
    rabbits = [];
    foxes = [];
    hist = [];

    // grass, row-major
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        grass[y * W + x] = Math.floor(rand() * (cfg.grassMax + 1));
      }
    }

    // rabbits
    for (let i = 0; i < cfg.rabbits0; i++) {
      const list = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) if (!rabbitAt[y * W + x]) list.push([x, y]);
      }
      if (!list.length) break;
      const c = pick(list);
      const r = { id: nextId++, x: c[0], y: c[1], energy: cfg.rabbitStart, dead: false };
      rabbits.push(r);
      rabbitAt[c[1] * W + c[0]] = r;
    }

    // foxes
    for (let i = 0; i < cfg.foxes0; i++) {
      const list = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) if (!foxAt[y * W + x]) list.push([x, y]);
      }
      if (!list.length) break;
      const c = pick(list);
      const f = { id: nextId++, x: c[0], y: c[1], energy: cfg.foxStart, dead: false };
      foxes.push(f);
      foxAt[c[1] * W + c[0]] = f;
    }

    record();
    refresh();
  }

  /* ------------------------------------------------------------------ *
   * One tick
   * ------------------------------------------------------------------ */
  function doTick() {
    // 1. grass
    for (let i = 0; i < grass.length; i++) {
      if (grass[i] < cfg.grassMax) grass[i]++;
    }

    // 2. rabbits
    const rsnap = rabbits.slice().sort(function (a, b) { return a.id - b.id; });
    for (let i = 0; i < rsnap.length; i++) {
      const r = rsnap[i];
      if (r.dead) continue;

      // move
      const nb = neighbours(r.x, r.y);
      const free = [];
      for (let k = 0; k < nb.length; k++) {
        const c = nb[k];
        if (!rabbitAt[c[1] * W + c[0]]) free.push(c);
      }
      if (free.length) {
        const c = pick(free);
        rabbitAt[r.y * W + r.x] = null;
        r.x = c[0]; r.y = c[1];
        rabbitAt[r.y * W + r.x] = r;
      }

      // eat
      const ci = r.y * W + r.x;
      r.energy += cfg.rabbitGain * grass[ci];
      grass[ci] = 0;

      // cost
      r.energy -= cfg.rabbitCost;

      // breed
      if (r.energy >= cfg.rabbitBreed) {
        const nb2 = neighbours(r.x, r.y);
        const spots = [];
        for (let k = 0; k < nb2.length; k++) {
          const c = nb2[k];
          if (!rabbitAt[c[1] * W + c[0]]) spots.push(c);
        }
        if (spots.length) {
          const c = pick(spots);
          const child = Math.floor(r.energy / 2);
          r.energy -= child;
          const baby = { id: nextId++, x: c[0], y: c[1], energy: child, dead: false };
          rabbits.push(baby);
          rabbitAt[c[1] * W + c[0]] = baby;
        }
      }

      // die
      if (r.energy <= 0) {
        rabbitAt[r.y * W + r.x] = null;
        r.dead = true;
      }
    }
    rabbits = rabbits.filter(function (r) { return !r.dead; });

    // 3. foxes
    const fsnap = foxes.slice().sort(function (a, b) { return a.id - b.id; });
    for (let i = 0; i < fsnap.length; i++) {
      const f = fsnap[i];
      if (f.dead) continue;

      const nb = neighbours(f.x, f.y);
      const withRabbit = [];
      const noFox = [];
      for (let k = 0; k < nb.length; k++) {
        const c = nb[k];
        const ci = c[1] * W + c[0];
        if (rabbitAt[ci] && !foxAt[ci]) withRabbit.push(c);
        if (!foxAt[ci]) noFox.push(c);
      }
      let target = null;
      if (withRabbit.length) target = pick(withRabbit);
      else if (noFox.length) target = pick(noFox);
      if (target) {
        foxAt[f.y * W + f.x] = null;
        f.x = target[0]; f.y = target[1];
        foxAt[f.y * W + f.x] = f;
      }

      // eat
      const ci = f.y * W + f.x;
      const prey = rabbitAt[ci];
      if (prey) {
        rabbitAt[ci] = null;
        prey.dead = true;
        f.energy += cfg.foxGain;
      }

      f.energy -= cfg.foxCost;

      // breed
      if (f.energy >= cfg.foxBreed) {
        const nb2 = neighbours(f.x, f.y);
        const spots = [];
        for (let k = 0; k < nb2.length; k++) {
          const c = nb2[k];
          if (!foxAt[c[1] * W + c[0]]) spots.push(c);
        }
        if (spots.length) {
          const c = pick(spots);
          const child = Math.floor(f.energy / 2);
          f.energy -= child;
          const baby = { id: nextId++, x: c[0], y: c[1], energy: child, dead: false };
          foxes.push(baby);
          foxAt[c[1] * W + c[0]] = baby;
        }
      }

      if (f.energy <= 0) {
        foxAt[f.y * W + f.x] = null;
        f.dead = true;
      }
    }
    rabbits = rabbits.filter(function (r) { return !r.dead; });
    foxes = foxes.filter(function (f) { return !f.dead; });

    // 4. advance
    tickNum += 1;
    record();
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */
  function redraw() {
    const bw = W * 10;
    const bh = H * 10;
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const c = canvas.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, bw, bh);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const g = grass[y * W + x];
        const G = 60 + Math.round(160 * g / cfg.grassMax);
        c.fillStyle = 'rgb(30,' + G + ',30)';
        c.fillRect(x * 10, y * 10, 10, 10);
      }
    }
    c.fillStyle = 'rgb(240,240,240)';
    for (let i = 0; i < rabbits.length; i++) {
      const r = rabbits[i];
      c.fillRect(r.x * 10 + 2, r.y * 10 + 2, 6, 6);
    }
    c.fillStyle = 'rgb(220,80,20)';
    for (let i = 0; i < foxes.length; i++) {
      const f = foxes[i];
      c.fillRect(f.x * 10 + 2, f.y * 10 + 2, 6, 6);
    }
  }

  const CW = 340, CH = 160, PADL = 38, PADR = 10, PADT = 18, PADB = 28;
  const X0 = PADL, X1 = CW - PADR, Y0 = CH - PADB, Y1 = PADT;

  function r2(v) { return Math.round(v * 100) / 100; }

  function updateChart() {
    let maxTick = 0;
    let maxCount = 1;
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      if (h.tick > maxTick) maxTick = h.tick;
      if (h.rabbits > maxCount) maxCount = h.rabbits;
      if (h.foxes > maxCount) maxCount = h.foxes;
    }
    if (maxTick <= 0) maxTick = 1;
    const xr = X1 - X0;
    const yr = Y0 - Y1;
    const px = function (t) { return X0 + (t / maxTick) * xr; };
    const py = function (v) { return Y0 - (v / maxCount) * yr; };

    const rp = [];
    const fp = [];
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      rp.push(r2(px(h.tick)) + ',' + r2(py(h.rabbits)));
      fp.push(r2(px(h.tick)) + ',' + r2(py(h.foxes)));
    }
    polyR.setAttribute('points', rp.join(' '));
    polyF.setAttribute('points', fp.join(' '));
  }

  function updateCounters() {
    elTick.textContent = String(tickNum);
    elR.textContent = String(rabbits.length);
    elF.textContent = String(foxes.length);
    elG.textContent = String(grassSum());
  }

  function updateAnnouncer() {
    if (playing) return;
    announcer.textContent = 'Tick ' + tickNum + ': ' + rabbits.length + ' rabbits, ' + foxes.length + ' foxes';
  }

  function refresh() {
    redraw();
    updateChart();
    updateCounters();
    updateAnnouncer();
  }

  /* ------------------------------------------------------------------ *
   * ODE (Lotka-Volterra, RK4)
   * ------------------------------------------------------------------ */
  function lvDeriv(p, x, y) {
    return [
      p.alpha * x - p.beta * x * y,
      p.delta * x * y - p.gamma * y
    ];
  }

  function integrate(p, t, dt) {
    let n = 0;
    if (dt > 0 && isFinite(t / dt)) n = Math.round(t / dt);
    if (!isFinite(n) || n < 0) n = 0;
    let x = p.x0;
    let y = p.y0;
    const pts = [[x, y]];
    for (let i = 0; i < n; i++) {
      const k1 = lvDeriv(p, x, y);
      const k2 = lvDeriv(p, x + dt / 2 * k1[0], y + dt / 2 * k1[1]);
      const k3 = lvDeriv(p, x + dt / 2 * k2[0], y + dt / 2 * k2[1]);
      const k4 = lvDeriv(p, x + dt * k3[0], y + dt * k3[1]);
      x += dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      y += dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      pts.push([x, y]);
    }
    return { x: x, y: y, points: pts };
  }

  function drawOdeChart(points) {
    if (!points || points.length === 0) return;
    const stepN = Math.max(1, Math.ceil(points.length / 600));
    const sample = [];
    for (let i = 0; i < points.length; i += stepN) sample.push(points[i]);
    if (sample[sample.length - 1] !== points[points.length - 1]) sample.push(points[points.length - 1]);
    if (sample.length === 1) sample.push(sample[0]);

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < sample.length; i++) {
      if (sample[i][0] < lo) lo = sample[i][0];
      if (sample[i][0] > hi) hi = sample[i][0];
      if (sample[i][1] < lo) lo = sample[i][1];
      if (sample[i][1] > hi) hi = sample[i][1];
    }
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-12) { hi = lo + 1; }
    const xr = X1 - X0;
    const yr = Y0 - Y1;
    const lastIdx = sample.length - 1;
    const px = function (i) { return X0 + (lastIdx === 0 ? 0 : i / lastIdx) * xr; };
    const py = function (v) { return Y0 - ((v - lo) / (hi - lo)) * yr; };

    const a = [], b = [];
    for (let i = 0; i < sample.length; i++) {
      a.push(r2(px(i)) + ',' + r2(py(sample[i][0])));
      b.push(r2(px(i)) + ',' + r2(py(sample[i][1])));
    }
    polyOX.setAttribute('points', a.join(' '));
    polyOY.setAttribute('points', b.join(' '));
  }

  function numOf(id) {
    const el = $id(id);
    const v = Number(el ? el.value : NaN);
    return isFinite(v) ? v : 0;
  }

  function fmt(v) {
    const n = Number(v);
    if (!isFinite(n)) return String(n);
    return n.toPrecision(12);
  }

  function runOde() {
    const p = {
      alpha: numOf('ode-alpha'),
      beta: numOf('ode-beta'),
      gamma: numOf('ode-gamma'),
      delta: numOf('ode-delta'),
      x0: numOf('ode-x0'),
      y0: numOf('ode-y0')
    };
    const t = numOf('ode-t');
    const dt = numOf('ode-dt');
    const res = integrate(p, t, dt);
    $id('ode-x').textContent = fmt(res.x);
    $id('ode-y').textContent = fmt(res.y);
    $id('ode-eq-x').textContent = fmt(p.delta !== 0 ? p.gamma / p.delta : 0);
    $id('ode-eq-y').textContent = fmt(p.beta !== 0 ? p.alpha / p.beta : 0);
    const V = function (x, y) {
      return p.delta * x - p.gamma * Math.log(x) + p.beta * y - p.alpha * Math.log(y);
    };
    const v0 = V(p.x0, p.y0);
    const v1 = V(res.x, res.y);
    const drift = Math.abs(v1 - v0);
    $id('ode-drift').textContent = fmt(isFinite(drift) ? drift : 0);
    drawOdeChart(res.points);
  }

  /* ------------------------------------------------------------------ *
   * CSV / scenario
   * ------------------------------------------------------------------ */
  function exportCSV() {
    let out = 'tick,rabbits,foxes,grass\n';
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      out += h.tick + ',' + h.rabbits + ',' + h.foxes + ',' + h.grass + '\n';
    }
    return out;
  }

  function scenarioParams() {
    const out = {};
    for (const k in DEFAULTS) out[k]