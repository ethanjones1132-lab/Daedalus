## Plan

**Data model.** One module-level `S` object holds: `P` (params merged over the 13 defaults), `seed`, `tick`, `idCounter`, `rand`, `W`, `H`, `grass` (flat array of levels, index `y*W+x`), `rabbits`/`foxes` (arrays of `{id,x,y,energy}`, ids from one shared counter), `rabbitGrid`/`foxGrid` (Maps from cell index to animal, for O(1) occupancy), and `history` (array of `{tick,rabbits,foxes,grass}`).

**Tick order.** (1) Grass: each cell `min(grassMax, grass+1)`. (2) Rabbits: snapshot sorted by id; each moves to a `pick`ed rabbit-free neighbour (or stays), eats all cell grass ×`rabbitGain` (cell → 0), pays `rabbitCost`, breeds into a `pick`ed free neighbour when `energy ≥ rabbitBreed` (child `floor(e/2)`, parent loses it, new shared id), dies at `energy ≤ 0`. (3) Foxes, same shape, but move first to a `pick`ed neighbour holding a rabbit and no fox, else a `pick`ed fox-free neighbour; then eat any rabbit in its cell (+`foxGain`); cost; breed; die. (4) `tick++`, push history point. `pick` draws one number only for a non-empty list, all from the single `mulberry32` stream, in rule order.

**Components.** Simulation core (`reset`, `doTick`, `runTicks`, `counts`, `cell`, `history`, RK4 `ode`, CSV/scenario helpers); canvas world renderer (grass squares, rabbit/fox shapes); SVG population chart (one polyline point per history entry); controls (play/pause/step/reset, seed, speed, six parameter sliders with labels and value readouts); counters; Lotka–Volterra panel (8 inputs, run button, final values, equilibria, drift, SVG chart); scenario panel (textarea, export/load, error); presets backed by `localStorage["ecolab.presets"]`; `announcer` plus focus-gated keyboard shortcuts; flex-wrap layout (side-by-side ≥ ~900px, stacked under 700px, canvas CSS-scaled).

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ecosystem Lab</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:radial-gradient(1200px 600px at 15% -10%, #16241b 0%, #0d1310 60%) no-repeat, #0d1310;
    color:#e8f0ea;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    font-size:14px;line-height:1.4;
    -webkit-font-smoothing:antialiased;
    overflow-x:hidden;
  }
  .app{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;padding:16px;max-width:1440px;margin:0 auto}
  #panel-world{flex:1 1 430px;min-width:0}
  #panel-side{flex:1 1 390px;min-width:0;display:flex;flex-direction:column;gap:14px}
  .panel,.card{background:#141c17;border:1px solid #263329;border-radius:14px;padding:14px}
  h1{font-size:18px;margin:0 0 12px;letter-spacing:.2px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:#9db0a3;margin:0 0 10px;font-weight:700}
  canvas{display:block;width:100%;height:auto;max-width:100%;background:#0a0f0c;border-radius:10px;border:1px solid #263329;image-rendering:pixelated}
  button{
    font:inherit;color:#e8f0ea;background:#1e2b23;border:1px solid #33473a;border-radius:9px;
    padding:7px 12px;cursor:pointer;transition:background .12s,border-color .12s;
  }
  button:hover{background:#26382d;border-color:#3f5a49}
  button:active{transform:translateY(1px)}
  button:focus,input:focus,textarea:focus,select:focus{outline:3px solid #7ee08e;outline-offset:2px}
  .controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
  .field{display:flex;align-items:center;gap:6px;min-width:0}
  .field label{color:#9db0a3;font-size:12px;letter-spacing:.03em}
  input[type=number],input[type=text],textarea{
    font:inherit;color:#e8f0ea;background:#0f1712;border:1px solid #33473a;border-radius:8px;padding:6px 8px;
    min-width:0;max-width:100%;
  }
  input[type=number]{width:74px}
  input[type=range]{width:130px;max-width:100%;accent-color:#57c26a;vertical-align:middle}
  textarea{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;resize:vertical}
  .counters{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 4px}
  .counter{flex:1 1 90px;background:#0f1712;border:1px solid #263329;border-radius:10px;padding:8px 10px}
  .counter .k{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#9db0a3}
  .counter b{font-size:18px;font-variant-numeric:tabular-nums}
  .sliders{display:flex;flex-direction:column;gap:6px;margin-top:6px}
  .slider-row{display:grid;grid-template-columns:1fr auto 38px;gap:8px;align-items:center}
  .slider-row label{font-size:12px;color:#c3d3c8}
  .slider-row output{font-size:12px;text-align:right;color:#7ee08e;font-variant-numeric:tabular-nums}
  svg{display:block;width:100%;height:auto;max-width:100%}
  .plot-bg{fill:#0f1712;stroke:#263329}
  .axis{fill:#9db0a3;font-size:12px;font-family:system-ui,sans-serif}
  polyline{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
  polyline.rabbits{stroke:#f0f0f0}
  polyline.foxes{stroke:#dc5014}
  polyline.ode-x{stroke:#57c26a}
  polyline.ode-y{stroke:#e0b44a}
  .legend{display:flex;gap:14px;font-size:12px;color:#9db0a3;margin-top:6px;flex-wrap:wrap}
  .swatch{display:inline-block;width:12px;height:3px;border-radius:2px;vertical-align:middle;margin-right:5px}
  .ode-grid{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin-bottom:10px}
  .ode-grid label{font-size:12px;color:#c3d3c8}
  .ode-grid input{width:100%}
  .ode-out{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:12px;color:#9db0a3;margin:10px 0}
  .ode-out b{color:#e8f0ea;font-variant-numeric:tabular-nums;word-break:break-all}
  .error{color:#ff9b7a;font-size:12px;min-height:16px;margin:6px 0}
  .preset-list{display:flex;flex-direction:column;gap:6px;margin-top:10px}
  [data-testid="preset-item"]{display:flex;align-items:center;gap:8px;background:#0f1712;border:1px solid #263329;border-radius:9px;padding:6px 8px}
  [data-testid="preset-item"] span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
  [data-testid="preset-item"] button{padding:4px 8px;font-size:12px}
  .sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
  .hint{font-size:11px;color:#7d8f83;margin-top:8px}
</style>
</head>
<body>
<div class="app">

  <section id="panel-world" class="panel" data-testid="panel-world">
    <h1>Ecosystem Lab</h1>
    <canvas data-testid="world" width="400" height="300" aria-label="World grid"></canvas>

    <div class="controls" style="margin-top:10px">
      <button type="button" data-testid="play">Play</button>
      <button type="button" data-testid="pause">Pause</button>
      <button type="button" data-testid="step">Step</button>
      <button type="button" data-testid="reset">Reset</button>
    </div>

    <div class="controls">
      <div class="field"><label for="seed">Seed</label>
        <input id="seed" data-testid="seed" type="number" step="1" value="42" /></div>
      <div class="field"><label for="speed">Speed</label>
        <input id="speed" data-testid="speed" type="range" min="1" max="60" step="1" value="10" />
        <output id="speed-val">10</output></div>
    </div>

    <div class="counters">
      <div class="counter"><span class="k">Tick</span><b data-testid="tick">0</b></div>
      <div class="counter"><span class="k">Rabbits</span><b data-testid="count-rabbits">0</b></div>
      <div class="counter"><span class="k">Foxes</span><b data-testid="count-foxes">0</b></div>
      <div class="counter"><span class="k">Grass</span><b data-testid="count-grass">0</b></div>
    </div>

    <h2 style="margin-top:14px">Parameters (applied on reset)</h2>
    <div class="sliders">
      <div class="slider-row">
        <label for="param-rabbits0">Rabbits at reset</label>
        <input type="range" id="param-rabbits0" data-testid="param-rabbits0" min="0" max="300" step="1" value="100" />
        <output id="param-rabbits0-val">100</output>
      </div>
      <div class="slider-row">
        <label for="param-foxes0">Foxes at reset</label>
        <input type="range" id="param-foxes0" data-testid="param-foxes0" min="0" max="60" step="1" value="6" />
        <output id="param-foxes0-val">6</output>
      </div>
      <div class="slider-row">
        <label for="param-rabbitBreed">Rabbit breed energy</label>
        <input type="range" id="param-rabbitBreed" data-testid="param-rabbitBreed" min="2" max="40" step="1" value="12" />
        <output id="param-rabbitBreed-val">12</output>
      </div>
      <div class="slider-row">
        <label for="param-foxBreed">Fox breed energy</label>
        <input type="range" id="param-foxBreed" data-testid="param-foxBreed" min="2" max="60" step="1" value="40" />
        <output id="param-foxBreed-val">40</output>
      </div>
      <div class="slider-row">
        <label for="param-foxGain">Fox gain per rabbit</label>
        <input type="range" id="param-foxGain" data-testid="param-foxGain" min="1" max="30" step="1" value="4" />
        <output id="param-foxGain-val">4</output>
      </div>
      <div class="slider-row">
        <label for="param-grassMax">Max grass</label>
        <input type="range" id="param-grassMax" data-testid="param-grassMax" min="1" max="10" step="1" value="4" />
        <output id="param-grassMax-val">4</output>
      </div>
    </div>
    <div class="hint">Space = play/pause · s = one tick · r = reset (when no control is focused)</div>
  </section>

  <section id="panel-side" data-testid="panel-side">

    <div class="card">
      <h2>Populations</h2>
      <svg data-testid="chart" viewBox="0 0 640 240" role="img" aria-label="Population chart">
        <rect class="plot-bg" x="46" y="18" width="576" height="182"></rect>
        <text class="axis" x="8" y="14">count</text>
        <text class="axis" x="334" y="230" text-anchor="middle">tick</text>
        <polyline class="rabbits" data-testid="series-rabbits" points=""></polyline>
        <polyline class="foxes" data-testid="series-foxes" points=""></polyline>
      </svg>
      <div class="legend">
        <span><i class="swatch" style="background:#f0f0f0"></i>rabbits</span>
        <span><i class="swatch" style="background:#dc5014"></i>foxes</span>
      </div>
    </div>

    <div class="card">
      <h2>Lotka&ndash;Volterra</h2>
      <div class="ode-grid">
        <label for="ode-alpha">&alpha; (prey growth)</label><input id="ode-alpha" data-testid="ode-alpha" type="number" step="any" value="1.1" />
        <label for="ode-beta">&beta; (predation)</label><input id="ode-beta" data-testid="ode-beta" type="number" step="any" value="0.4" />
        <label for="ode-gamma">&gamma; (predator death)</label><input id="ode-gamma" data-testid="ode-gamma" type="number" step="any" value="0.4" />
        <label for="ode-delta">&delta; (predator growth)</label><input id="ode-delta" data-testid="ode-delta" type="number" step="any" value="0.1" />
        <label for="ode-x0">x&#8320; (prey)</label><input id="ode-x0" data-testid="ode-x0" type="number" step="any" value="10" />
        <label for="ode-y0">y&#8320; (predator)</label><input id="ode-y0" data-testid="ode-y0" type="number" step="any" value="10" />
        <label for="ode-t">t (end time)</label><input id="ode-t" data-testid="ode-t" type="number" step="any" value="50" />
        <label for="ode-dt">dt (step)</label><input id="ode-dt" data-testid="ode-dt" type="number" step="any" value="0.01" />
      </div>
      <div class="controls"><button type="button" data-testid="ode-run">Run</button></div>
      <div class="ode-out">
        <span>x = <b data-testid="ode-x">&ndash;</b></span>
        <span>y = <b data-testid="ode-y">&ndash;</b></span>
        <span>eq x = &gamma;/&delta; = <b data-testid="ode-eq-x">&ndash;</b></span>
        <span>eq y = &alpha;/&beta; = <b data-testid="ode-eq-y">&ndash;</b></span>
        <span>drift = <b data-testid="ode-drift">&ndash;</b></span>
      </div>
      <svg data-testid="ode-chart" viewBox="0 0 640 240" role="img" aria-label="Lotka-Volterra trajectory">
        <rect class="plot-bg" x="46" y="18" width="576" height="182"></rect>
        <text class="axis" x="8" y="14">value</text>
        <text class="axis" x="334" y="230" text-anchor="middle">time</text>
        <polyline class="ode-x" data-testid="ode-series-x" points=""></polyline>
        <polyline class="ode-y" data-testid="ode-series-y" points=""></polyline>
      </svg>
    </div>

    <div class="card">
      <h2>Scenario</h2>
      <textarea data-testid="scenario-json" rows="4" spellcheck="false" aria-label="Scenario JSON"></textarea>
      <div class="controls" style="margin-top:8px">
        <button type="button" data-testid="scenario-export">Export scenario</button>
        <button type="button" data-testid="scenario-load">Load scenario</button>
      </div>
      <div class="error" data-testid="scenario-error" role="alert"></div>
      <div class="controls">
        <button type="button" data-testid="csv-export">Download CSV</button>
      </div>
    </div>

    <div class="card">
      <h2>Presets</h2>
      <div class="controls">
        <input type="text" data-testid="preset-name" placeholder="Preset name" aria-label="Preset name" />
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

  /* ---------------------------------------------------------------
     Defaults and helpers
  --------------------------------------------------------------- */
  var DEFAULTS = {
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

  var SLIDER_KEYS = ['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax'];
  var PRESET_KEY = 'ecolab.presets';

  function mulberry32(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function byId(t) {
    return document.querySelector('[data-testid="' + t + '"]');
  }

  /* ---------------------------------------------------------------
     State
  --------------------------------------------------------------- */
  var S = {
    P: Object.assign({}, DEFAULTS),
    seed: 42,
    tick: 0,
    idCounter: 1,
    rand: mulberry32(42),
    W: DEFAULTS.width,
    H: DEFAULTS.height,
    grass: [],
    rabbits: [],
    foxes: [],
    rabbitGrid: new Map(),
    foxGrid: new Map(),
    history: []
  };

  function idx(x, y) { return y * S.W + x; }

  function pick(list) {
    if (!list || list.length === 0) return null;
    return list[Math.floor(S.rand() * list.length)];
  }

  function neighbours(x, y) {
    var out = [];
    if (y - 1 >= 0) out.push([x, y - 1]);
    if (x + 1 < S.W) out.push([x + 1, y]);
    if (y + 1 < S.H) out.push([x, y + 1]);
    if (x - 1 >= 0) out.push([x - 1, y]);
    return out;
  }

  function addRabbit(x, y, energy) {
    var r = { id: S.idCounter++, x: x, y: y, energy: energy };
    S.rabbits.push(r);
    S.rabbitGrid.set(idx(x, y), r);
    return r;
  }

  function addFox(x, y, energy) {
    var f = { id: S.idCounter++, x: x, y: y, energy: energy };
    S.foxes.push(f);
    S.foxGrid.set(idx(x, y), f);
    return f;
  }

  function grassTotal() {
    var s = 0;
    for (var i = 0; i < S.grass.length; i++) s += S.grass[i];
    return s;
  }

  function makePoint() {
    return {
      tick: S.tick,
      rabbits: S.rabbits.length,
      foxes: S.foxes.length,
      grass: grassTotal()
    };
  }

  function counts() {
    return { rabbits: S.rabbits.length, foxes: S.foxes.length, grass: grassTotal() };
  }

  /* ---------------------------------------------------------------
     Reset
  --------------------------------------------------------------- */
  function doReset(seed, params) {
    var P = Object.assign({}, DEFAULTS, params || {});
    var W = Math.max(1, Math.floor(Number(P.width) || DEFAULTS.width));
    var H = Math.max(1, Math.floor(Number(P.height) || DEFAULTS.height));
    P.width = W;
    P.height = H;

    S.P = P;
    S.W = W;
    S.H = H;
    S.seed = seed;
    S.rand = mulberry32(seed);
    S.tick = 0;
    S.idCounter = 1;
    S.history = [];
    S.rabbits = [];
    S.foxes = [];
    S.rabbitGrid = new Map();
    S.foxGrid = new Map();

    var n = W * H;
    S.grass = new Array(n);
    var gm = Number(P.grassMax);
    if (!isFinite(gm)) gm = DEFAULTS.grassMax;

    var x, y, i;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        S.grass[y * W + x] = Math.floor(S.rand() * (gm + 1));
      }
    }

    for (i = 0; i < P.rabbits0; i++) {
      var freeR = [];
      for (y = 0; y < H; y++) {
        for (x = 0; x < W; x++) {
          if (!S.rabbitGrid.has(y * W + x)) freeR.push([x, y]);
        }
      }
      if (freeR.length === 0) continue;
      var sr = pick(freeR);
      addRabbit(sr[0], sr[1], P.rabbitStart);
    }

    for (i = 0; i < P.foxes0; i++) {
      var freeF = [];
      for (y = 0; y < H; y++) {
        for (x = 0; x < W; x++) {
          if (!S.foxGrid.has(y * W + x)) freeF.push([x, y]);
        }
      }
      if (freeF.length === 0) continue;
      var sf = pick(freeF);
      addFox(sf[0], sf[1], P.foxStart);
    }

    S.history.push(makePoint());
    syncControls();
    syncAll();
    return counts();
  }

  /* ---------------------------------------------------------------
     One tick
  --------------------------------------------------------------- */
  function doTick() {
    var P = S.P;
    var gm = Number(P.grassMax);
    if (!isFinite(gm)) gm = DEFAULTS.grassMax;

    /* 1. grass regrowth */
    for (var i = 0; i < S.grass.length; i++) {
      if (S.grass[i] < gm) S.grass[i]++;
    }

    /* 2. rabbits */
    var rabbits = S.rabbits.slice().sort(function (a, b) { return a.id - b.id; });
    for (var ri = 0; ri < rabbits.length; ri++) {
      var r = rabbits[ri];

      var cands = [], nb = neighbours(r.x, r.y), k;
      for (k = 0; k < nb.length; k++) {
        if (!S.rabbitGrid.has(idx(nb[k][0], nb[k][1]))) cands.push(nb[k]);
      }
      if (cands.length > 0) {
        var spot = pick(cands);
        S.rabbitGrid.delete(idx(r.x, r.y));
        r.x = spot[0]; r.y = spot[1];
        S.rabbitGrid.set(idx(r.x, r.y), r);
      }

      var cellK = idx(r.x, r.y);
      r.energy += P.rabbitGain * S.grass[cellK];
      S.grass[cellK] = 0;
      r.energy -= P.rabbitCost;

      if (r.energy >= P.rabbitBreed) {
        var spots = [], nb2 = neighbours(r.x, r.y);
        for (k = 0; k < nb2.length; k++) {
          if (!S.rabbitGrid.has(idx(nb2[k][0], nb2[k][1]))) spots.push(nb2[k]);
        }
        if (spots.length > 0) {
          var bspot = pick(spots);
          var child = Math.floor(r.energy / 2);
          r.energy -= child;
          addRabbit(bspot[0], bspot[1], child);
        }
      }

      if (r.energy <= 0) {
        S.rabbitGrid.delete(idx(r.x, r.y));
        var at = S.rabbits.indexOf(r);
        if (at >= 0) S.rabbits.splice(at, 1);
      }
    }

    /* 3. foxes */
    var foxes = S.foxes.slice().sort(function (a, b) { return a.id - b.id; });
    for (var fi = 0; fi < foxes.length; fi++) {
      var f = foxes[fi];
      var list = [], nbF = neighbours(f.x, f.y), j;

      for (j = 0; j < nbF.length; j++) {
        var kk = idx(nbF[j][0], nbF[j][1]);
        if (S.rabbitGrid.has(kk) && !S.foxGrid.has(kk)) list.push(nbF[j]);
      }
      if (list.length === 0) {
        for (j = 0; j < nbF.length; j++) {
          if (!S.foxGrid.has(idx(nbF[j][0], nbF[j][1]))) list.push(nbF[j]);
        }
      }
      if (list.length > 0) {
        var fspot = pick(list);
        S.foxGrid.delete(idx(f.x, f.y));
        f.x = fspot[0]; f.y = fspot[1];
        S.foxGrid.set(idx(f.x, f.y), f);
      }

      var fk = idx(f.x, f.y);
      var prey = S.rabbitGrid.get(fk);
      if (prey) {
        S.rabbitGrid.delete(fk);
        var pi = S.rabbits.indexOf(prey);
        if (pi >= 0) S.rabbits.splice(pi, 1);
        f.energy += P.foxGain;
      }

      f.energy -= P.foxCost;

      if (f.energy >= P.foxBreed) {
        var fspots = [], nbF2 = neighbours(f.x, f.y);
        for (j = 0; j < nbF2.length; j++) {
          if (!S.foxGrid.has(idx(nbF2[j][0], nbF2[j][1]))) fspots.push(nbF2[j]);
        }
        if (fspots.length > 0) {
          var fbspot = pick(fspots);
          var fchild = Math.floor(f.energy / 2);
          f.energy -= fchild;
          addFox(fbspot[0], fbspot[1], fchild);
        }
      }

      if (f.energy <= 0) {
        S.foxGrid.delete(idx(f.x, f.y));
        var fat = S.foxes.indexOf(f);
        if (fat >= 0) S.foxes.splice(fat, 1);
      }
    }

    /* 4. bookkeeping */
    S.tick++;
    S.history.push(makePoint());
  }

  function runTicks(n) {
    n = Math.floor(Number(n));
    if (!isFinite(n) || n < 0) n = 0;
    for (var i = 0; i < n; i++) doTick();
    syncAll();
    return counts();
  }

  /* ---------------------------------------------------------------
     Rendering: world
  --------------------------------------------------------------- */
  function drawWorld() {
    var canvas = byId('world');
    if (!canvas) return;
    var W = S.W, H = S.H;
    canvas.width = W * 10;
    canvas.height = H * 10;
    var ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return;

    var gm = Number(S.P.grassMax);
    if (!isFinite(gm) || gm <= 0) gm = 1;

    var x, y, g, G;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        g = S.grass[y * W + x];
        G = 60 + Math.round(160 * g / gm);
        ctx.fillStyle = 'rgb(30, ' + G + ', 30)';
        ctx.fillRect(x * 10, y * 10, 10, 10);
      }
    }

    var i;
    ctx.fillStyle = 'rgb(240, 240, 240)';
    for (i = 0; i < S.rabbits.length; i++) {
      ctx.fillRect(S.rabbits[i].x * 10 + 2, S.rabbits[i].y * 10 + 2, 6, 6);
    }
    ctx.fillStyle = 'rgb(220, 80, 20)';
    for (i = 0; i < S.foxes.length; i++) {
      ctx.fillRect(S.foxes[i].x * 10 + 2, S.foxes[i].y * 10 + 2, 6, 6);
    }
  }

  /* ---------------------------------------------------------------
     Rendering: charts
  --------------------------------------------------------------- */
  var PLOT = { l: 46, r: 622, t: 18, b: 200 };

  function niceMax(v) {
    if (!(v > 0) || !isFinite(v)) return 1;
    var e = Math.pow(10, Math.floor(Math.log10(v)));
    var m = v / e;
    var f;
    if (m <= 1) f = 1; else if (m <= 2) f = 2; else if (m <= 5) f = 5; else f = 10;
    return f * e;
  }

  function setPoints(el, xs, ys) {
    if (!el) return;
    var parts = [];
    for (var i = 0; i < xs.length; i++) {
      parts.push(xs[i].toFixed(2) + ',' + ys[i].toFixed(2));
    }
    el.setAttribute('points', parts.join(' '));
  }

  function drawChart() {
    var hist = S.history;
    var n = hist.length;
    var maxV = 1, i;
    for (i = 0; i < n; i++) {
      if (hist[i].rabbits > maxV) maxV = hist[i].rabbits;
      if (hist[i].foxes > maxV) maxV = hist[i].foxes;
    }
    maxV = niceMax(maxV);
    var span = PLOT.r - PLOT.l;
    var vspan = PLOT.b - PLOT.t;

    var rx = [], ry = [], fx = [], fy = [];
    for (i = 0; i < n; i++) {
      var px = n <= 1 ? PLOT.l : PLOT.l + (i / (n - 1)) * span;
      rx.push(px);
      fx.push(px);
      ry.push(PLOT.b - (hist[i].rabbits / maxV) * vspan);
      fy.push(PLOT.b - (hist[i].foxes / maxV) * vspan);
    }
    setPoints(byId('series-rabbits'), rx, ry);
    setPoints(byId('series-foxes'), fx, fy);
  }

  function drawOdeChart(xs, ys) {
    var n = xs.length;
    var maxV = 1, i;
    for (i = 0; i < n; i++) {
      if (xs[i] > maxV) maxV = xs[i];
      if (ys[i] > maxV) maxV = ys[i];
    }
    maxV = niceMax(maxV);
    var span = PLOT.r - PLOT.l;
    var vspan = PLOT.b - PLOT.t;

    var axs = [], ays = [], bxs = [], bys = [];
    for (i = 0; i < n; i++) {
      var px = n <= 1 ? PLOT.l : PLOT.l + (i / (n - 1)) * span;
      axs.push(px);
      bxs.push(px);
      ays.push(PLOT.b - (xs[i] / maxV) * vspan);
      bys.push(PLOT.b - (ys[i] / maxV) * vspan);
    }
    setPoints(byId('ode-series-x'), axs, ays);
    setPoints(byId('ode-series-y'), bxs, bys);
  }

  /* ---------------------------------------------------------------
     UI sync
  --------------------------------------------------------------- */
  function syncControls() {
    var seedEl = byId('seed');
    if (seedEl) seedEl.value = String(S.seed);
    for (var i = 0; i < SLIDER_KEYS.length; i++) {
      var k = SLIDER_KEYS[i];
      var el = byId('param-' + k);
      if (!el) continue;
      el.value = String(S.P[k]);
      var out = document.getElementById('param-' + k + '-val');
      if (out) out.textContent = String(S.P[k]);
    }
  }

  function updateCounters() {
    var c = counts();
    var t = byId('tick');
    var r = byId('count-rabbits');
    var f = byId('count-foxes');
    var g = byId('count-grass');
    if (t) t.textContent = String(S.tick);
    if (r) r.textContent = String(c.rabbits);
    if (f) f.textContent = String(c.foxes);
    if (g) g.textContent = String(c.grass);
  }

  function updateAnnouncer() {
    var a = byId('announcer');
    if (!a) return;
    if (playing) {
      a.textContent = '';
    } else {
      a.textContent = 'Tick ' + S.tick + ': ' + S.rabbits.length + ' rabbits, ' + S.foxes.length + ' foxes';
    }
  }

  function syncAll() {
    drawWorld();
    drawChart();
    updateCounters();
    updateAnnouncer();
  }

  /* ---------------------------------------------------------------
     Timing / play loop
  --------------------------------------------------------------- */
  var playing = false;
  var rafId = null;
  var lastTs = 0;
  var acc = 0;
  var speed = 10;

  var hasRaf = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function');
  var raf = hasRaf
    ? window.requestAnimationFrame.bind(window)
    : function (cb) { return setTimeout(function () { cb(Date.now()); }, 16); };
  var caf = (hasRaf && typeof window.cancelAnimationFrame === 'function')
    ? window.cancelAnimationFrame.bind(window)
    : clearTimeout;

  function loop() {
    if (!playing) return;
    var now = Date.now();
    if (!lastTs) lastTs = now;
    var dt = (now - lastTs) / 1000;
    lastTs = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.5) dt = 0.5;
    acc += dt * speed;
    var n = Math.floor(acc);
    if (n > 0) {
      acc -= n;
      if (n > 2000) n = 2000;
      runTicks(n);
    }
    if (playing) rafId = raf(loop);
  }

  function startPlay() {
    if (playing) return;
    playing = true;
    lastTs = 0;
    acc = 0;
    updateAnnouncer();
    rafId = raf(loop);
  }

  function stopPlay() {
    if (playing) {
      playing = false;
      if (rafId !== null) caf(rafId);
      rafId = null;
    }
    updateAnnouncer();
  }

  function togglePlay() {
    if (playing) stopPlay(); else startPlay();
  }

  /* ---------------------------------------------------------------
     Lotka-Volterra
  --------------------------------------------------------------- */
  function deriv(p, x, y) {
    return [p.alpha * x - p.beta * x * y, p.delta * x * y - p.gamma * y];
  }

  function rk4Step(p, x, y, dt) {
    var k1 = deriv(p, x, y);
    var k2 = deriv(p, x + dt * k1[0] / 2, y + dt * k1[1] / 2);
    var k3 = deriv(p, x + dt * k2[0] / 2, y + dt * k2[1] / 2);
    var k4 = deriv(p, x + dt * k3[0], y + dt * k3[1]);
    return [
      x + dt * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6,
      y + dt * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6
    ];
  }

  function odeSteps(t, dt) {
    if (!(dt > 0) || !isFinite(t) || !isFinite(dt)) return 0;
    var n = Math.round(t / dt);
    if (!(n > 0) || !isFinite(n)) n = 0;
    return n;
  }

  function odeSolve(p, t, dt) {
    var n = odeSteps(t, dt);
    var x = p.x0, y = p.y0;
    for (var i = 0; i < n; i++) {
      var r = rk4Step(p, x, y, dt);
      x = r[0]; y = r[1];
    }
    return { x: x, y: y };
  }

  function odeSeries(p, t, dt) {
    var n = odeSteps(t, dt);
    var x = p.x0, y = p.y0;
    var xs = [x], ys = [y];
    var stride = Math.max(1, Math.ceil(n / 1200));
    for (var i = 1; i <= n; i++) {
      var r = rk4Step(p, x, y, dt);
      x = r[0]; y = r[1];
      if (i % stride === 0 || i === n) { xs.push(x); ys.push(y); }
    }
    return { xs: xs, ys: ys, x: x, y: y };
  }

  function fmtNum(v) {
    if (!isFinite(v)) return String(v);
    return v.toPrecision(10);
  }

  var ODE_IDS = ['ode-alpha', 'ode-beta', 'ode-gamma', 'ode-delta', 'ode-x0', 'ode-y0', 'ode-t', 'ode-dt'];

  function readOdeParams() {
    function val(id, def) {
      var el = byId(id);
      var v = el ? Number(el.value) : NaN;
      return isFinite(v) ? v : def;
    }
    return {
      alpha: val('ode-alpha', 1.1),
      beta: val('ode-beta', 0.4),
      gamma: val('ode-gamma', 0.4),
      delta: val('ode-delta', 0.1),
      x0: val('ode-x0', 10),
      y0: val('ode-y0', 10),
      t: val('ode-t', 50),
      dt: val('ode-dt', 0.01)
    };
  }

  function runOde() {
    var p = readOdeParams();
    var series = odeSeries(p, p.t, p.dt);

    var ex = byId('ode-x'), ey = byId('ode-y');
    var eqx = byId('ode-eq-x'), eqy = byId('ode-eq-y'), drift = byId('ode-drift');
    if (ex) ex.textContent = fmtNum(series.x);
    if (ey) ey.textContent = fmtNum(series.y);
    if (eqx) eqx.textContent = fmtNum(p.gamma / p.delta);
    if (eqy) eqy.textContent = fmtNum(p.alpha / p.beta);

    function V(x, y) {
      return p.delta * x - p.gamma * Math.log(Math.max(x, 1e-300))
           + p.beta * y - p.alpha * Math.log(Math.max(y, 1e-300));
    }
    var d = Math.abs(V(series.x, series.y) - V(p.x0, p.y0));
    if (drift) drift.textContent = String(d);

    drawOdeChart(series.xs, series.ys);
    return { x: series.x, y: series.y };
  }

  /* ---------------------------------------------------------------
     CSV / scenario
  --------------------------------------------------------------- */
  function exportCSV() {
    var out = 'tick,rabbits,foxes,grass\n';
    for (var i = 0; i < S.history.length; i++) {
      var h = S.history[i];
      out += h.tick + ',' + h.rabbits + ',' + h.foxes + ',' + h.grass + '\n';
    }
    return out;
  }

  function exportScenario() {
    return JSON.stringify({
      version: 1,
      seed: S.seed,
      params: Object.assign({}, S.P)
    });
  }

  function setError(msg) {
    var el = byId('scenario-error');
    if (el) el.textContent = msg || '';
  }

  function applyScenarioObject(obj) {
    if (!obj || typeof obj !== 'object') {
      setError('Scenario must be an object');
      return false;
    }
    if (obj.version !== 1) {
      setError('Unsupported scenario version');
      return false;
    }
    if (!Number.isInteger(obj.seed)) {
      setError('Scenario seed must be an integer');
      return false;
    }
    var params = (obj.params && typeof obj.params === 'object') ? obj.params : {};
    doReset(obj.seed, params);
    setError('');
    return true;
  }

  function loadScenario(text) {
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      setError('Invalid scenario JSON');
      return false;
    }
    return applyScenarioObject(obj);
  }

  /* ---------------------------------------------------------------
     Presets
  --------------------------------------------------------------- */
  function readPresets() {
    try {
      var raw = window.localStorage.getItem(PRESET_KEY);
      if (!raw) return {};
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
      return obj;
    } catch (e) {
      return {};
    }
  }

  function writePresets(obj) {
    try {
      window.localStorage.setItem(PRESET_KEY, JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  }

  function renderPresets() {
    var list = byId('preset-list');
    if (!list) return;
    list.textContent = '';
    var presets = readPresets();
    var names = Object.keys(presets);
    for (var i = 0; i < names.length; i++) {
      (function (name) {
        var item = document.createElement('div');
        item.setAttribute('data-testid', 'preset-item');

        var label = document.createElement('span');
        label.textContent = name;

        var loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.setAttribute('data-testid', 'preset-load');
        loadBtn.textContent = 'Load';
        loadBtn.addEventListener('click', function () {
          var sc = readPresets()[name];
          if (!sc) return;
          var ta = byId('scenario-json');
          if (ta) ta.value = JSON.stringify(sc);
          applyScenarioObject(sc);
        });

        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.setAttribute('data-testid', 'preset-delete');
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', function () {
          var all = readPresets();
          delete all[name];
          writePresets(all);
          renderPresets();
        });

        item.appendChild(label);
        item.appendChild(loadBtn);
        item.appendChild(delBtn);
        list.appendChild(item);
      })(names[i]);
    }
  }

  /* ---------------------------------------------------------------
     Controls wiring
  --------------------------------------------------------------- */
  function readSeedFromInput() {
    var el = byId('seed');
    if (!el || String(el.value).trim() === '') return 42;
    var v = Number(el.value);
    if (!isFinite(v)) return 42;
    return Math.trunc(v);
  }

  function resetFromUI() {
    var params = {};
    for (var i = 0; i < SLIDER_KEYS.length; i++) {
      var k = SLIDER_KEYS[i];
      var el = byId('param-' + k);
      if (el) params[k] = Number(el.value);
    }
    doReset(readSeedFromInput(), params);
  }

  function wire() {
    var playBtn = byId('play');
    if (playBtn) playBtn.addEventListener('click', function () { startPlay(); });

    var pauseBtn = byId('pause');
    if (pauseBtn) pauseBtn.addEventListener('click', function () { stopPlay(); });

    var stepBtn = byId('step');
    if (stepBtn) stepBtn.addEventListener('click', function () { runTicks(1); });

    var resetBtn = byId('reset');
    if (resetBtn) resetBtn.addEventListener('click', function () { resetFromUI(); });

    var speedEl = byId('speed');
    if (speedEl) {
      speed = Number(speedEl.value) || 10;
      speedEl.addEventListener('input', function () {
        speed = Number(speedEl.value) || 1;
        var out = document.getElementById('speed-val');
        if (out) out.textContent = String(speedEl.value);
      });
      speedEl.addEventListener('change', function () {
        speed = Number(speedEl.value) || 1;
      });
    }

    for (var i = 0; i < SLIDER_KEYS.length; i++) {
      (function (k) {
        var el = byId('param-' + k);
        if (!el) return;
        el.addEventListener('input', function () {
          var out = document.getElementById('param-' + k + '-val');
          if (out) out.textContent = el.value;
        });
      })(SLIDER_KEYS[i]);
    }

    var odeBtn = byId('ode-run');
    if (odeBtn) odeBtn.addEventListener('click', function () { runOde(); });

    for (var o = 0; o < ODE_IDS.length; o++) {
      var oe = byId(ODE_IDS[o]);
      if (oe) oe.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); runOde(); }
      });
    }

    var csvBtn = byId('csv-export');
    if (csvBtn) csvBtn.addEventListener('click', function () {
      var text = exportCSV();
      try {
        var blob = new Blob([text], { type: 'text/csv' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'ecolab.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
      } catch (e) { /* download unavailable */ }
    });

    var sExp = byId('scenario-export');
    if (sExp) sExp.addEventListener('click', function () {
      var ta = byId('scenario-json');
      if (ta) ta.value = exportScenario();
    });

    var sLoad = byId('scenario-load');
    if (sLoad) sLoad.addEventListener('click', function () {
      var ta = byId('scenario-json');
      loadScenario(ta ? ta.value : '');
    });

    var pSave = byId('preset-save');
    if (pSave) pSave.addEventListener('click', function () {
      var nameEl = byId('preset-name');
      var name = nameEl ? String(nameEl.value).trim() : '';
      if (!name) return;
      var all = readPresets();
      all[name] = JSON.parse(exportScenario());
      writePresets(all);
      renderPresets();
    });

    document.addEventListener('keydown', function (ev) {
      var ae = document.activeElement;
      if (ae) {
        var tag = ae.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
        if (ae.isContentEditable) return;
      }
      if (ev.key === ' ' || ev.key === 'Spacebar' || ev.code === 'Space') {
        ev.preventDefault();
        togglePlay();
      } else if (ev.key === 's' || ev.key === 'S') {
        ev.preventDefault();
        runTicks(1);
      } else if (ev.key === 'r' || ev.key === 'R') {
        ev.preventDefault();
        resetFromUI();
      }
    });
  }

  /* ---------------------------------------------------------------
     Public API
  --------------------------------------------------------------- */
  function apiReset(seed, params) {
    return doReset(seed, params || {});
  }

  function apiStep(n) {
    if (n === undefined || n === null) n = 1;
    return runTicks(n);
  }

  function apiCell(x, y) {
    x = Math.floor(Number(x));
    y = Math.floor(Number(y));
    if (!(x >= 0 && x < S.W && y >= 0 && y < S.H)) {
      return { grass: 0, rabbit: null, fox: null };
    }
    var k = y * S.W + x;
    var r = S.rabbitGrid.get(k);
    var f = S.foxGrid.get(k);
    return {
      grass: S.grass[k],
      rabbit: r ? { id: r.id, energy: r.energy } : null,
      fox: f ? { id: f.id, energy: f.energy } : null
    };
  }

  function apiHistory() {
    return S.history.map(function (h) {
      return { tick: h.tick, rabbits: h.rabbits, foxes: h.foxes, grass: h.grass };
    });
  }

  function apiOde(p, t, dt) {
    var q = {
      alpha: Number(p.alpha),
      beta: Number(p.beta),
      gamma: Number(p.gamma),
      delta: Number(p.delta),
      x0: Number(p.x0),
      y0: Number(p.y0)
    };
    return odeSolve(q, Number(t), Number(dt));
  }

  window.lab = {
    reset: apiReset,
    step: apiStep,
    counts: counts,
    tick: function () { return S.tick; },
    cell: apiCell,
    history: apiHistory,
    ode: apiOde,
    exportCSV: exportCSV,
    exportScenario: exportScenario,
    loadScenario: loadScenario
  };

  /* ---------------------------------------------------------------
     Boot
  --------------------------------------------------------------- */
  function boot() {
    wire();
    renderPresets();
    doReset(42, {});
    runOde();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
</script>
</body>
</html>
```