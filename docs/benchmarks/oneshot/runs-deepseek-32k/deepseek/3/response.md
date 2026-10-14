## Plan

**Data model**
- `params`: the 13 keys merged over `DEFAULTS` (`width, height, grassMax, rabbits0, foxes0, rabbitStart, rabbitGain, rabbitCost, rabbitBreed, foxStart, foxGain, foxCost, foxBreed`). All numeric.
- `grass`: flat `Int` array of length `W*H`, row‑major (`i = y*W + x`).
- `rabbitGrid` / `foxGrid`: flat arrays of animal refs or `null` — one rabbit and one fox per cell max.
- `rabbits` / `foxes`: arrays of `{id, x, y, energy}` in creation order (hence id‑ascending).
- Shared state: `rand = mulberry32(seed)`, `tickCount`, `nextId` (shared counter), `history: [{tick, rabbits, foxes, grass}]`.
- `pick(list)` draws one number only when the list is non‑empty.

**Tick order**
1. Every cell's grass `= min(grassMax, grass+1)`.
2. Rabbits alive at phase start (snapshot, id order): move to a rabbit‑free neighbour (`pick`, else stay) → eat `rabbitGain * grass` and zero the cell → `-rabbitCost` → if `energy >= rabbitBreed` and a fox‑free/rabbit‑free neighbour exists, `pick` spot, `child = floor(energy/2)`, transfer, spawn child → if `energy <= 0`, remove.
3. Foxes alive at phase start (snapshot, id order): move to a neighbour with a rabbit and no fox, else any fox‑free neighbour, else stay → eat a rabbit in the cell (`+foxGain`) → `-foxCost` → breed identically with `foxBreed` over fox‑free neighbours → die if `energy <= 0`.
4. `tickCount += 1`; push history `{tick, rabbits, foxes, grass: sum(grass)}`.

**Components**
- Sim core (`reset`, `tickOnce`, `counts`, `cell`, `history`).
- RNG (`mulberry32`, `pick`).
- Renderer: canvas `world` (`W*10 × H*10`, grass `rgb(30,G,30)`, white rabbit, orange fox on top), SVG `chart` (`series-rabbits`, `series-foxes`, labels `tick`/`count`), SVG `ode-chart` (`ode-series-x`, `ode-series-y`).
- UI: play/pause/step/reset, seed, speed, 6 param sliders with live readouts, 4 counters, announcer.
- ODE panel: RK4 trajectory + invariants (`ode-x/y`, `ode-eq-x/y`, `ode-drift`).
- Data: `exportCSV`, `exportScenario`/`loadScenario`, `scenario-json`/`scenario-error`, presets in `localStorage["ecolab.presets"]`.
- Keyboard shortcuts (space / s / r) guarded by focus, and the `window.lab` API delegating to the same core.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ecosystem Lab</title>
<style>
  :root{
    --bg:#eef1ec; --card:#ffffff; --line:#d8dfd6; --ink:#1d2a1d; --muted:#63705f;
    --accent:#2f7d32; --focus:#1d6fe0;
  }
  *,*::before,*::after{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; }
  body{
    background:var(--bg); color:var(--ink);
    font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  h1{ font-size:22px; margin:0 0 2px; letter-spacing:-.01em; }
  h2{ font-size:15px; margin:0 0 10px; letter-spacing:.02em; }
  h3{ font-size:12px; margin:0 0 10px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .wrap{ max-width:1200px; margin:0 auto; padding:14px; }
  .topbar{ margin-bottom:14px; }
  .tagline{ margin:0; color:var(--muted); font-size:13px; }
  .app{ display:flex; flex-direction:column; gap:14px; }
  .panel{
    background:var(--card); border:1px solid var(--line); border-radius:12px;
    padding:14px; box-shadow:0 1px 2px rgba(0,0,0,.04); min-width:0;
  }
  @media (min-width:1000px){
    .app{ flex-direction:row; align-items:flex-start; }
    #panel-world{ flex:1 1 0; min-width:0; }
    #panel-side{ flex:1 1 0; min-width:0; max-width:560px; }
  }
  #panel-side{ display:flex; flex-direction:column; }
  #panel-side > section{ padding:0 0 14px; min-width:0; }
  #panel-side > section + section{ border-top:1px solid var(--line); padding-top:14px; }
  #panel-side > section:last-child{ padding-bottom:0; }

  canvas[data-testid="world"]{
    display:block; width:100%; height:auto; max-width:100%;
    background:#0b140c; border-radius:8px; image-rendering:pixelated;
    border:1px solid #c9d2c6;
  }
  .chart{ display:block; width:100%; height:auto; }

  .controls{ display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 10px; }
  button{
    font:inherit; color:inherit; background:#f7faf6; border:1px solid var(--line);
    border-radius:8px; padding:6px 12px; cursor:pointer; white-space:nowrap;
  }
  button:hover{ background:#eef4ec; }
  button:active{ transform:translateY(1px); }
  button:focus{ outline:2px solid var(--focus); outline-offset:2px; }
  button.primary{ background:var(--accent); border-color:var(--accent); color:#fff; }
  button.primary:hover{ background:#28692b; }

  .counters{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin-bottom:12px; }
  .counter{ background:#f5f8f3; border:1px solid #dde4da; border-radius:8px; padding:6px 6px; text-align:center; min-width:0; }
  .counter .k{ display:block; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  .counter .v{ display:block; font-weight:700; font-size:16px; font-variant-numeric:tabular-nums; }

  .field{ display:flex; flex-direction:column; gap:4px; min-width:0; }
  .field > label{ font-size:12px; color:var(--muted); }
  .row2{ display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px; }
  .slider{ display:grid; grid-template-columns:1fr auto; gap:2px 8px; align-items:center; margin-bottom:8px; }
  .slider label{ font-size:12px; color:var(--muted); }
  .slider output{ font-size:12px; font-weight:600; font-variant-numeric:tabular-nums; }
  .slider input[type="range"]{ grid-column:1 / -1; }

  input[type="number"], input[type="text"], textarea{
    font:inherit; color:inherit; background:#fff; border:1px solid var(--line);
    border-radius:8px; padding:5px 8px; width:100%; min-width:0;
  }
  textarea{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; resize:vertical; }
  input:focus, textarea:focus, select:focus{ outline:2px solid var(--focus); outline-offset:1px; }
  input[type="range"]{ width:100%; accent-color:var(--accent); }
  input[type="range"]:focus{ outline:2px solid var(--focus); outline-offset:3px; }

  .legend{ display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin:8px 0 10px; font-size:12px; color:var(--muted); }
  .legend .swatch{ display:inline-block; width:14px; height:4px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  .swatch.rabbit{ background:#2563eb; }
  .swatch.fox{ background:#e2600f; }

  .ode-inputs{ display:grid; grid-template-columns:repeat(auto-fit,minmax(84px,1fr)); gap:8px; margin-bottom:10px; }
  .ode-outs{ display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:8px; margin:10px 0; }
  .ode-outs div{ background:#f5f8f3; border:1px solid #dde4da; border-radius:8px; padding:5px 8px; min-width:0; }
  .ode-outs .k{ display:block; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  .ode-outs .v{ display:block; font-variant-numeric:tabular-nums; font-weight:600; word-break:break-all; font-size:12px; }

  .btn-row{ display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
  .error{ color:#b3261e; font-size:12px; min-height:0; margin-top:6px; word-break:break-word; }
  .error:empty{ margin-top:0; }

  .preset-list{ list-style:none; margin:10px 0 0; padding:0; display:flex; flex-direction:column; gap:6px; }
  [data-testid="preset-item"]{
    display:flex; align-items:center; gap:8px; background:#f5f8f3;
    border:1px solid #dde4da; border-radius:8px; padding:5px 8px; min-width:0;
  }
  [data-testid="preset-item"] .name{ flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  [data-testid="preset-item"] button{ padding:3px 8px; font-size:12px; }

  .sr-only{
    position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
    clip:rect(0 0 0 0); white-space:nowrap; border:0;
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <h1>Ecosystem Lab</h1>
    <p class="tagline">Grass, rabbits and foxes on a grid — with a Lotka–Volterra comparison.</p>
  </header>

  <main class="app">
    <section class="panel" id="panel-world" data-testid="panel-world">
      <h2>World</h2>
      <canvas data-testid="world" width="400" height="300"></canvas>

      <div class="controls">
        <button data-testid="play" class="primary">Play</button>
        <button data-testid="pause">Pause</button>
        <button data-testid="step">Step</button>
        <button data-testid="reset">Reset</button>
      </div>

      <div class="counters">
        <div class="counter"><span class="k">Tick</span><span class="v" data-testid="tick">0</span></div>
        <div class="counter"><span class="k">Rabbits</span><span class="v" data-testid="count-rabbits">0</span></div>
        <div class="counter"><span class="k">Foxes</span><span class="v" data-testid="count-foxes">0</span></div>
        <div class="counter"><span class="k">Grass</span><span class="v" data-testid="count-grass">0</span></div>
      </div>

      <div class="row2">
        <div class="field">
          <label for="seed">Seed</label>
          <input id="seed" data-testid="seed" type="number" value="42" step="1">
        </div>
        <div class="field">
          <label for="speed">Speed (ticks/s)</label>
          <input id="speed" data-testid="speed" type="range" min="1" max="60" value="10">
          <output id="speed-val" for="speed" style="font-size:12px;color:#63705f">10</output>
        </div>
      </div>

      <div class="slider">
        <label for="param-rabbits0">Rabbits at reset</label>
        <output id="param-rabbits0-val" for="param-rabbits0">100</output>
        <input type="range" id="param-rabbits0" data-testid="param-rabbits0" min="0" max="300" value="100">
      </div>
      <div class="slider">
        <label for="param-foxes0">Foxes at reset</label>
        <output id="param-foxes0-val" for="param-foxes0">6</output>
        <input type="range" id="param-foxes0" data-testid="param-foxes0" min="0" max="60" value="6">
      </div>
      <div class="slider">
        <label for="param-rabbitBreed">Rabbit breed energy</label>
        <output id="param-rabbitBreed-val" for="param-rabbitBreed">12</output>
        <input type="range" id="param-rabbitBreed" data-testid="param-rabbitBreed" min="2" max="40" value="12">
      </div>
      <div class="slider">
        <label for="param-foxBreed">Fox breed energy</label>
        <output id="param-foxBreed-val" for="param-foxBreed">40</output>
        <input type="range" id="param-foxBreed" data-testid="param-foxBreed" min="2" max="60" value="40">
      </div>
      <div class="slider">
        <label for="param-foxGain">Fox gain per rabbit</label>
        <output id="param-foxGain-val" for="param-foxGain">4</output>
        <input type="range" id="param-foxGain" data-testid="param-foxGain" min="1" max="30" value="4">
      </div>
      <div class="slider">
        <label for="param-grassMax">Max grass level</label>
        <output id="param-grassMax-val" for="param-grassMax">4</output>
        <input type="range" id="param-grassMax" data-testid="param-grassMax" min="1" max="10" value="4">
      </div>

      <div data-testid="announcer" aria-live="polite" class="sr-only"></div>
    </section>

    <aside class="panel" id="panel-side" data-testid="panel-side">
      <section>
        <h3>Populations</h3>
        <svg data-testid="chart" class="chart" viewBox="0 0 420 180" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Population over time"></svg>
        <div class="legend">
          <span><span class="swatch rabbit"></span>Rabbits</span>
          <span><span class="swatch fox"></span>Foxes</span>
        </div>
        <button data-testid="csv-export">Download CSV</button>
      </section>

      <section>
        <h3>Lotka–Volterra</h3>
        <div class="ode-inputs">
          <div class="field"><label for="ode-alpha">alpha</label><input id="ode-alpha" data-testid="ode-alpha" type="number" step="0.01" value="1.1"></div>
          <div class="field"><label for="ode-beta">beta</label><input id="ode-beta" data-testid="ode-beta" type="number" step="0.01" value="0.4"></div>
          <div class="field"><label for="ode-gamma">gamma</label><input id="ode-gamma" data-testid="ode-gamma" type="number" step="0.01" value="0.4"></div>
          <div class="field"><label for="ode-delta">delta</label><input id="ode-delta" data-testid="ode-delta" type="number" step="0.01" value="0.1"></div>
          <div class="field"><label for="ode-x0">x0</label><input id="ode-x0" data-testid="ode-x0" type="number" step="0.1" value="10"></div>
          <div class="field"><label for="ode-y0">y0</label><input id="ode-y0" data-testid="ode-y0" type="number" step="0.1" value="10"></div>
          <div class="field"><label for="ode-t">t</label><input id="ode-t" data-testid="ode-t" type="number" step="1" value="50"></div>
          <div class="field"><label for="ode-dt">dt</label><input id="ode-dt" data-testid="ode-dt" type="number" step="0.001" value="0.01"></div>
        </div>
        <button data-testid="ode-run" class="primary">Run</button>
        <div class="ode-outs">
          <div><span class="k">x(end)</span><span class="v" data-testid="ode-x"></span></div>
          <div><span class="k">y(end)</span><span class="v" data-testid="ode-y"></span></div>
          <div><span class="k">γ/δ</span><span class="v" data-testid="ode-eq-x"></span></div>
          <div><span class="k">α/β</span><span class="v" data-testid="ode-eq-y"></span></div>
          <div><span class="k">drift</span><span class="v" data-testid="ode-drift"></span></div>
        </div>
        <svg data-testid="ode-chart" class="chart" viewBox="0 0 420 180" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Lotka-Volterra trajectory"></svg>
      </section>

      <section>
        <h3>Scenario</h3>
        <textarea data-testid="scenario-json" rows="4" spellcheck="false" aria-label="Scenario JSON"></textarea>
        <div class="btn-row">
          <button data-testid="scenario-export">Export</button>
          <button data-testid="scenario-load">Load</button>
        </div>
        <div data-testid="scenario-error" class="error" role="alert"></div>
      </section>

      <section>
        <h3>Presets</h3>
        <div class="btn-row" style="margin-top:0">
          <input data-testid="preset-name" type="text" placeholder="Preset name" aria-label="Preset name" style="flex:1 1 140px">
          <button data-testid="preset-save">Save</button>
        </div>
        <ul data-testid="preset-list" class="preset-list"></ul>
      </section>
    </aside>
  </main>
</div>

<script>
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Randomness
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
   *  Parameters and state
   * ------------------------------------------------------------------ */
  const DEFAULTS = {
    width: 40,
    height: 30,
    grassMax: 4,
    rabbits0: 100,
    foxes0: 6,
    rabbitStart: 6,
    rabbitGain: 1,
    rabbitCost: 1,
    rabbitBreed: 12,
    foxStart: 12,
    foxGain: 4,
    foxCost: 2,
    foxBreed: 40
  };
  const PARAM_KEYS = Object.keys(DEFAULTS);
  const SLIDER_KEYS = ['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax'];

  let params = Object.assign({}, DEFAULTS);
  let W = DEFAULTS.width;
  let H = DEFAULTS.height;
  let grass = [];
  let rabbitGrid = [];
  let foxGrid = [];
  let rabbits = [];
  let foxes = [];
  let rand = mulberry32(42);
  let currentSeed = 42;
  let tickCount = 0;
  let nextId = 1;
  let history = [];
  let playing = false;
  let rafId = null;
  let lastTs = 0;
  let acc = 0;

  function pick(list) {
    if (!list || list.length === 0) return undefined;
    return list[Math.floor(rand() * list.length)];
  }

  function idx(x, y) { return y * W + x; }

  function neighborsOf(x, y) {
    const out = [];
    if (y > 0) out.push([x, y - 1]);
    if (x < W - 1) out.push([x + 1, y]);
    if (y < H - 1) out.push([x, y + 1]);
    if (x > 0) out.push([x - 1, y]);
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

  /* ------------------------------------------------------------------ *
   *  Reset
   * ------------------------------------------------------------------ */
  function doReset(seed, newParams) {
    const p = {};
    for (let i = 0; i < PARAM_KEYS.length; i++) {
      const k = PARAM_KEYS[i];
      let v;
      if (newParams && newParams[k] !== undefined && newParams[k] !== null) v = newParams[k];
      else v = DEFAULTS[k];
      const n = Number(v);
      p[k] = Number.isFinite(n) ? n : DEFAULTS[k];
    }
    params = p;

    W = Math.max(1, Math.round(p.width));
    H = Math.max(1, Math.round(p.height));
    currentSeed = seed;
    rand = mulberry32(seed);
    tickCount = 0;
    nextId = 1;
    history = [];
    rabbits = [];
    foxes = [];

    const area = W * H;
    grass = new Array(area);
    rabbitGrid = new Array(area).fill(null);
    foxGrid = new Array(area).fill(null);

    /* grass, row-major */
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        grass[y * W + x] = Math.floor(rand() * (p.grassMax + 1));
      }
    }

    /* rabbits */
    const nR = Math.max(0, Math.round(p.rabbits0));
    for (let k = 0; k < nR; k++) {
      const free = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!rabbitGrid[y * W + x]) free.push([x, y]);
        }
      }
      const spot = pick(free);
      if (!spot) break;
      const r = { id: nextId++, x: spot[0], y: spot[1], energy: p.rabbitStart };
      rabbits.push(r);
      rabbitGrid[spot[1] * W + spot[0]] = r;
    }

    /* foxes */
    const nF = Math.max(0, Math.round(p.foxes0));
    for (let k = 0; k < nF; k++) {
      const free = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!foxGrid[y * W + x]) free.push([x, y]);
        }
      }
      const spot = pick(free);
      if (!spot) break;
      const f = { id: nextId++, x: spot[0], y: spot[1], energy: p.foxStart };
      foxes.push(f);
      foxGrid[spot[1] * W + spot[0]] = f;
    }

    history.push({
      tick: 0,
      rabbits: rabbits.length,
      foxes: foxes.length,
      grass: grassSum()
    });

    canvas.width = W * 10;
    canvas.height = H * 10;
    syncControlsAfterReset(newParams);
    renderAll();
    return counts();
  }

  function syncControlsAfterReset(given) {
    seedInput.value = String(currentSeed);
    if (given) {
      for (let i = 0; i < SLIDER_KEYS.length; i++) {
        const k = SLIDER_KEYS[i];
        if (given[k] !== undefined && given[k] !== null) {
          const el = document.querySelector('[data-testid="param-' + k + '"]');
          if (el) {
            el.value = String(given[k]);
            const out = document.getElementById('param-' + k + '-val');
            if (out) out.textContent = el.value;
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------------ *
   *  Animal bookkeeping
   * ------------------------------------------------------------------ */
  function removeRabbit(r) {
    const i = rabbits.indexOf(r);
    if (i >= 0) rabbits.splice(i, 1);
    if (rabbitGrid[r.y * W + r.x] === r) rabbitGrid[r.y * W + r.x] = null;
  }

  function removeFox(f) {
    const i = foxes.indexOf(f);
    if (i >= 0) foxes.splice(i, 1);
    if (foxGrid[f.y * W + f.x] === f) foxGrid[f.y * W + f.x] = null;
  }

  /* ------------------------------------------------------------------ *
   *  One tick
   * ------------------------------------------------------------------ */
  function tickOnce() {
    const gm = params.grassMax;

    /* 1. grass grows */
    for (let i = 0; i < grass.length; i++) {
      const g = grass[i] + 1;
      grass[i] = g < gm ? g : gm;
    }

    /* 2. rabbits */
    const rSnap = rabbits.slice();
    for (let a = 0; a < rSnap.length; a++) {
      const r = rSnap[a];

      /* move */
      const free = [];
      const nb = neighborsOf(r.x, r.y);
      for (let i = 0; i < nb.length; i++) {
        if (!rabbitGrid[nb[i][1] * W + nb[i][0]]) free.push(nb[i]);
      }
      if (free.length) {
        const spot = pick(free);
        rabbitGrid[r.y * W + r.x] = null;
        r.x = spot[0];
        r.y = spot[1];
        rabbitGrid[r.y * W + r.x] = r;
      }

      /* eat */
      const ci = r.y * W + r.x;
      r.energy += params.rabbitGain * grass[ci];
      grass[ci] = 0;

      /* metabolic cost */
      r.energy -= params.rabbitCost;

      /* breed */
      if (r.energy >= params.rabbitBreed) {
        const spots = [];
        const nb2 = neighborsOf(r.x, r.y);
        for (let i = 0; i < nb2.length; i++) {
          if (!rabbitGrid[nb2[i][1] * W + nb2[i][0]]) spots.push(nb2[i]);
        }
        const spot = pick(spots);
        if (spot) {
          const child = Math.floor(r.energy / 2);
          r.energy -= child;
          const nr = { id: nextId++, x: spot[0], y: spot[1], energy: child };
          rabbits.push(nr);
          rabbitGrid[nr.y * W + nr.x] = nr;
        }
      }

      /* die */
      if (r.energy <= 0) removeRabbit(r);
    }

    /* 3. foxes */
    const fSnap = foxes.slice();
    for (let a = 0; a < fSnap.length; a++) {
      const f = fSnap[a];

      /* move */
      const withRabbit = [];
      const noFox = [];
      const nb = neighborsOf(f.x, f.y);
      for (let i = 0; i < nb.length; i++) {
        const j = nb[i][1] * W + nb[i][0];
        if (!foxGrid[j]) {
          noFox.push(nb[i]);
          if (rabbitGrid[j]) withRabbit.push(nb[i]);
        }
      }
      let dest;
      if (withRabbit.length) dest = pick(withRabbit);
      else if (noFox.length) dest = pick(noFox);
      if (dest) {
        foxGrid[f.y * W + f.x] = null;
        f.x = dest[0];
        f.y = dest[1];
        foxGrid[f.y * W + f.x] = f;
      }

      /* eat */
      const ci = f.y * W + f.x;
      const prey = rabbitGrid[ci];
      if (prey) {
        rabbitGrid[ci] = null;
        removeRabbit(prey);
        f.energy += params.foxGain;
      }

      /* metabolic cost */
      f.energy -= params.foxCost;

      /* breed */
      if (f.energy >= params.foxBreed) {
        const spots = [];
        const nb2 = neighborsOf(f.x, f.y);
        for (let i = 0; i < nb2.length; i++) {
          if (!foxGrid[nb2[i][1] * W + nb2[i][0]]) spots.push(nb2[i]);
        }
        const spot = pick(spots);
        if (spot) {
          const child = Math.floor(f.energy / 2);
          f.energy -= child;
          const nf = { id: nextId++, x: spot[0], y: spot[1], energy: child };
          foxes.push(nf);
          foxGrid[nf.y * W + nf.x] = nf;
        }
      }

      /* die */
      if (f.energy <= 0) removeFox(f);
    }

    /* 4. bookkeeping */
    tickCount += 1;
    history.push({
      tick: tickCount,
      rabbits: rabbits.length,
      foxes: foxes.length,
      grass: grassSum()
    });
  }

  /* ------------------------------------------------------------------ *
   *  Rendering
   * ------------------------------------------------------------------ */
  const canvas = document.querySelector('[data-testid="world"]');
  const ctx = canvas.getContext('2d');
  const seedInput = document.querySelector('[data-testid="seed"]');
  const speedInput = document.querySelector('[data-testid="speed"]');
  const speedVal = document.getElementById('speed-val');
  const announcer = document.querySelector('[data-testid="announcer"]');
  const tickOut = document.querySelector('[data-testid="tick"]');
  const rabbitsOut = document.querySelector('[data-testid="count-rabbits"]');
  const foxesOut = document.querySelector('[data-testid="count-foxes"]');
  const grassOut = document.querySelector('[data-testid="count-grass"]');

  function drawWorld() {
    const gm = Math.max(1, params.grassMax);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const g = grass[y * W + x];
        const G = 60 + Math.round(160 * g / gm);
        ctx.fillStyle = 'rgb(30,' + G + ',30)';
        ctx.fillRect(x * 10, y * 10, 10, 10);
      }
    }
    ctx.fillStyle = 'rgb(240,240,240)';
    for (let i = 0; i < rabbits.length; i++) {
      const r = rabbits[i];
      ctx.fillRect(r.x * 10 + 2, r.y * 10 + 2, 6, 6);
    }
    ctx.fillStyle = 'rgb(220,80,20)';
    for (let i = 0; i < foxes.length; i++) {
      const f = foxes[i];
      ctx.fillRect(f.x * 10 + 2, f.y * 10 + 2, 6, 6);
    }
  }

  function drawChart() {
    const svg = document.querySelector('[data-testid="chart"]');
    if (!svg) return;
    const CW = 420, CH = 180, padL = 46, padR = 14, padT = 14, padB = 30;
    const h = history;
    const lastTick = h.length ? h[h.length - 1].tick : 0;
    const maxTick = Math.max(1, lastTick);
    let maxC = 1;
    for (let i = 0; i < h.length; i++) {
      if (h[i].rabbits > maxC) maxC = h[i].rabbits;
      if (h[i].foxes > maxC) maxC = h[i].foxes;
    }
    const pw = CW - padL - padR;
    const ph = CH - padT - padB;
    const X = function (t) { return padL + (t / maxTick) * pw; };
    const Y = function (c) { return CH - padB - (c / maxC) * ph; };
    const pts = function (key) {
      const out = [];
      for (let i = 0; i < h.length; i++) {
        out.push(X(h[i].tick).toFixed(2) + ',' + Y(h[i][key]).toFixed(2));
      }
      return out.join(' ');
    };

    let grid = '';
    const fracs = [0, 0.25, 0.5, 0.75, 1];
    for (let i = 0; i < fracs.length; i++) {
      const val = maxC * fracs[i];
      const y = Y(val);
      grid += '<line x1="' + padL + '" y1="' + y.toFixed(2) + '" x2="' + (CW - padR) +
        '" y2="' + y.toFixed(2) + '" stroke="#e6ebe3" stroke-width="1"/>';
      grid += '<text x="' + (padL - 6) + '" y="' + (y + 4).toFixed(2) +
        '" text-anchor="end" font-size="10" fill="#8b958a">' + Math.round(val) + '</text>';
    }

    svg.innerHTML =
      '<rect x="0" y="0" width="' + CW + '" height="' + CH + '" fill="#fbfdfa" rx="6"/>' +
      grid +
      '<polyline data-testid="series-rabbits" fill="none" stroke="#2563eb" stroke-width="2" ' +
      'stroke-linejoin="round" stroke-linecap="round" points="' + pts('rabbits') + '"/>' +
      '<polyline data-testid="series-foxes" fill="none" stroke="#e2600f" stroke-width="2" ' +
      'stroke-linejoin="round" stroke-linecap="round" points="' + pts('foxes') + '"/>' +
      '<text x="' + (CW - padR) + '" y="' + (CH - 8) + '" text-anchor="end" font-size="11" fill="#63705f">tick</text>' +
      '<text x="6" y="' + (padT + 2) + '" font-size="11" fill="#63705f">count</text>';
  }

  function updateCounters() {
    tickOut.textContent = String(tickCount);
    rabbitsOut.textContent = String(rabbits.length);
    foxesOut.textContent = String(foxes.length);
    grassOut.textContent = String(grassSum());
  }

  function updateAnnouncer() {
    announcer.textContent = 'Tick ' + tickCount + ': ' + rabbits.length + ' rabbits, ' + foxes.length + ' foxes';
  }

  function renderAll() {
    drawWorld();
    updateCounters();
    drawChart();
    if (!playing) updateAnnouncer();
  }

  /* ------------------------------------------------------------------ *
   *  Lotka–Volterra
   * ------------------------------------------------------------------ */
  function rk4(p, x, y, dt) {
    const f = function (xx, yy) {
      return [p.alpha * xx - p.beta * xx * yy, p.delta * xx * yy - p.gamma * yy];
    };
    const k1 = f(x, y);
    const k2 = f(x + dt / 2 * k1[0], y + dt / 2 * k1[1]);
    const k3 = f(x + dt / 2 * k2[0], y + dt / 2 * k2[1]);
    const k4 = f(x + dt * k3[0], y + dt * k3[1]);
    return [
      x + dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
      y + dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
    ];
  }

  function odeSolve(p, t, dt) {
    let n = Math.round(t / dt);
    if (!Number.isFinite(n) || n < 0) n = 0;
    let x = p.x0, y = p.y0;
    for (let i = 0; i < n; i++) {
      const r = rk4(p, x, y, dt);
      x = r[0];
      y = r[1];
    }
    return { x: x, y: y };
  }

  function odeTrajectory(p, t, dt) {
    let n = Math.round(t / dt);
    if (!Number.isFinite(n) || n < 0) n = 0;
    const pts = [{ x: p.x0, y: p.y0 }];
    let x = p.x0, y = p.y0;
    for (let i = 0; i < n; i++) {
      const r = rk4(p, x, y, dt);
      x = r[0];
      y = r[1];
      pts.push({ x: x, y: y });
    }
    return pts;
  }

  function numFrom(testid, fallback) {
    const el = document.querySelector('[data-testid="' + testid + '"]');
    if (!el) return fallback;
    const v = parseFloat(el.value);
    return Number.isFinite(v) ? v : fallback;
  }

  function drawOdeChart(traj) {
    const svg = document.querySelector('[data-testid="ode-chart"]');
    if (!svg) return;
    const CW = 420, CH = 180, padL = 46, padR = 14, padT = 14, padB = 30;
    const n = traj.length;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (traj[i].x < lo) lo = traj[i].x;
      if (traj[i].y < lo) lo = traj[i].y;
      if (traj[i].x > hi) hi = traj[i].x;
      if (traj[i].y > hi) hi = traj[i].y;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = 1;
    if (hi <= lo) hi = lo + 1;
    lo = Math.min(0, lo);
    const pw = CW - padL - padR;
    const ph = CH - padT - padB;
    const X = function (k) { return n <= 1 ? padL : padL + (k / (n - 1)) * pw; };
    const Y = function (v) { return CH - padB - ((v - lo) / (hi - lo)) * ph; };
    const pts = function (key) {
      const out = [];
      for (let i = 0; i < n; i++) out.push(X(i).toFixed(2) + ',' + Y(traj[i][key]).toFixed(2));
      return out.join('