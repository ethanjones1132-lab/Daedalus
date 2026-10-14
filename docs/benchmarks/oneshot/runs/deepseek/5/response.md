## Plan

**Data model.** One module-level state object: `params` (13 defaults merged with a passed object, never with current values), `seed`, `rand` (single mulberry32 stream), `tick`, `nextId` (shared counter), `cells` (flat row-major array of `{grass, rabbit, fox}` where the latter two hold animal references or null), `rabbits`/`foxes` arrays (creation order = ascending id), and `history` of `{tick, rabbits, foxes, grass}`. An animal is `{id, x, y, energy, alive}`; positions live in the cell grid, so moves are a swap of two cell slots.

**Tick order.** (1) grass: `min(grassMax, grass+1)` per cell. (2) rabbits, snapshot of alive ids sorted ascending, each: move to a random rabbit-free neighbour (one draw only if the list is non-empty), eat `rabbitGain × grass` and zero the cell, pay `rabbitCost`, breed if `energy ≥ rabbitBreed` (one draw for the spot; child = `floor(energy/2)` subtracted from parent), die if `energy ≤ 0`. (3) foxes, same snapshot rule: prefer a neighbour holding a rabbit and no fox, else any fox-free neighbour, else stay; then eat the co-located rabbit (+`foxGain`), pay `foxCost`, breed into a fox-free neighbour, die. Newborns never act in their birth tick. (4) `tick++`, push history point. Reset uses the same stream for grass (row-major), then rabbit placements, then fox placements, then records tick 0.

**Components.** RNG; world/tick engine; canvas renderer (10 px cells, grass `rgb(30,G,30)`, rabbits white, foxes orange on top); counters; transport controls + seed/speed; six parameter sliders; SVG population chart (two polylines, one point per history entry); RK4 `ode` used by both the API and the Lotka–Volterra panel (trajectory polylines, final values, equilibria, drift); CSV export; scenario textarea export/load with error message; preset list in `localStorage`; announcer; focus-visible styling; keyboard shortcuts (Space / s / r) disabled while a control has focus; responsive two-panel layout.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ecosystem Lab</title>
<style>
:root{
  --bg:#eef2ee;--panel:#ffffff;--line:#d5ded6;--ink:#1b2a20;--muted:#5f6f63;
  --green:#2f7d4f;--orange:#c8571f;--focus:#1a6fe0;
}
*{box-sizing:border-box;}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  overflow-x:hidden;
}
.app{padding:12px;max-width:1360px;margin:0 auto;}
.panel{
  background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;
  box-shadow:0 1px 2px rgba(16,32,20,.05);margin-bottom:14px;min-width:0;
}
h1{font-size:18px;margin:0 0 10px;}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:18px 0 8px;}
h2:first-child{margin-top:0;}
canvas#world{
  display:block;max-width:100%;height:auto;background:#000;
  border:1px solid var(--line);border-radius:6px;image-rendering:pixelated;
}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;}
.row label{font-size:12px;color:var(--muted);}
button{
  font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);
  background:#f7faf7;color:var(--ink);cursor:pointer;
}
button:hover{background:#eef4ee;}
button:active{transform:translateY(1px);}
input[type=number],input[type=text],textarea{
  font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:8px;
  background:#fff;color:inherit;max-width:100%;
}
input[type=number]{width:90px;}
input[type=range]{accent-color:var(--green);width:100%;min-width:0;}
#speed{width:160px;max-width:45vw;}
.chip{font-size:12px;color:var(--muted);}
.num{font-variant-numeric:tabular-nums;font-weight:600;color:var(--ink);}
.counters{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}
.counter{
  flex:1 1 84px;background:#f6faf7;border:1px solid var(--line);border-radius:9px;
  padding:6px 10px;display:flex;flex-direction:column;
}
.counter .k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);}
.counter .v{font-size:18px;font-weight:650;font-variant-numeric:tabular-nums;}
.sliders{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 18px;margin-top:14px;}
.slider label{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted);margin-bottom:2px;}
.slider .val{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums;}
.slider input[type=range]{display:block;width:100%;}
.chart{width:100%;height:auto;display:block;background:#fff;border:1px solid var(--line);border-radius:9px;}
.axis-label{font-size:10px;fill:var(--muted);}
.axis-line{stroke:#c8d2c9;stroke-width:1;}
.ode-inputs{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:8px;}
.field{display:flex;flex-direction:column;gap:2px;min-width:0;}
.field label{font-size:11px;color:var(--muted);}
.field input{width:100%;min-width:0;}
.ode-out{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px 14px;margin-top:10px;}
.ode-out div{font-size:12px;color:var(--muted);}
.ode-out span{color:var(--ink);font-variant-numeric:tabular-nums;font-weight:600;}
textarea{
  width:100%;min-height:78px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:12px;resize:vertical;
}
.error{color:#a3220f;font-size:12px;min-height:16px;margin-top:6px;}
.preset-list{list-style:none;padding:0;margin:8px 0 0;}
.preset-item{
  display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);
  border-radius:8px;background:#f9fbf9;margin-bottom:6px;
}
.preset-item .preset-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.preset-item button{padding:4px 9px;font-size:12px;}
.sr-only{
  position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0;
}
*:focus{outline:3px solid var(--focus);outline-offset:2px;}
@media (min-width:1000px){
  .app{display:flex;gap:14px;align-items:flex-start;}
  #panel-world{flex:1 1 0;min-width:0;}
  #panel-side{flex:0 0 430px;width:430px;max-width:430px;}
  .panel{margin-bottom:0;}
}
</style>
</head>
<body>
<div class="app">

  <section id="panel-world" data-testid="panel-world" class="panel">
    <h1>Ecosystem Lab</h1>

    <div id="canvas-wrap">
      <canvas id="world" data-testid="world" width="400" height="300"></canvas>
    </div>

    <div class="row">
      <button type="button" data-testid="play" id="btn-play">Play</button>
      <button type="button" data-testid="pause" id="btn-pause">Pause</button>
      <button type="button" data-testid="step" id="btn-step">Step</button>
      <button type="button" data-testid="reset" id="btn-reset">Reset</button>
    </div>

    <div class="row">
      <label for="seed">Seed</label>
      <input type="number" id="seed" data-testid="seed" value="42" step="1">
      <label for="speed">Speed</label>
      <input type="range" id="speed" data-testid="speed" min="1" max="60" step="1" value="10">
      <span class="chip"><span class="num" id="speed-val">10</span> ticks/s</span>
    </div>

    <div class="counters">
      <div class="counter"><span class="k">Tick</span><span class="v" data-testid="tick">0</span></div>
      <div class="counter"><span class="k">Rabbits</span><span class="v" data-testid="count-rabbits">0</span></div>
      <div class="counter"><span class="k">Foxes</span><span class="v" data-testid="count-foxes">0</span></div>
      <div class="counter"><span class="k">Grass</span><span class="v" data-testid="count-grass">0</span></div>
    </div>

    <div class="sliders">
      <div class="slider">
        <label for="param-rabbits0">Rabbits at start <span class="val" id="val-rabbits0">100</span></label>
        <input type="range" id="param-rabbits0" data-testid="param-rabbits0" min="0" max="300" step="1" value="100">
      </div>
      <div class="slider">
        <label for="param-foxes0">Foxes at start <span class="val" id="val-foxes0">6</span></label>
        <input type="range" id="param-foxes0" data-testid="param-foxes0" min="0" max="60" step="1" value="6">
      </div>
      <div class="slider">
        <label for="param-rabbitBreed">Rabbit breed energy <span class="val" id="val-rabbitBreed">12</span></label>
        <input type="range" id="param-rabbitBreed" data-testid="param-rabbitBreed" min="2" max="40" step="1" value="12">
      </div>
      <div class="slider">
        <label for="param-foxBreed">Fox breed energy <span class="val" id="val-foxBreed">40</span></label>
        <input type="range" id="param-foxBreed" data-testid="param-foxBreed" min="2" max="60" step="1" value="40">
      </div>
      <div class="slider">
        <label for="param-foxGain">Fox gain per rabbit <span class="val" id="val-foxGain">4</span></label>
        <input type="range" id="param-foxGain" data-testid="param-foxGain" min="1" max="30" step="1" value="4">
      </div>
      <div class="slider">
        <label for="param-grassMax">Max grass <span class="val" id="val-grassMax">4</span></label>
        <input type="range" id="param-grassMax" data-testid="param-grassMax" min="1" max="10" step="1" value="4">
      </div>
    </div>
  </section>

  <section id="panel-side" data-testid="panel-side" class="panel">
    <h2>Populations</h2>
    <svg data-testid="chart" class="chart" viewBox="0 0 420 220" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Population history chart">
      <rect x="0" y="0" width="420" height="220" fill="#ffffff"></rect>
      <line class="axis-line" x1="44" y1="20" x2="44" y2="186"></line>
      <line class="axis-line" x1="44" y1="186" x2="390" y2="186"></line>
      <text class="axis-label" x="10" y="16">count</text>
      <text class="axis-label" x="217" y="212" text-anchor="middle">tick</text>
      <polyline data-testid="series-rabbits" fill="none" stroke="#2f7d4f" stroke-width="1.6" points=""></polyline>
      <polyline data-testid="series-foxes" fill="none" stroke="#c8571f" stroke-width="1.6" points=""></polyline>
    </svg>
    <div class="row">
      <span class="chip"><span style="color:#2f7d4f">━</span> rabbits</span>
      <span class="chip"><span style="color:#c8571f">━</span> foxes</span>
    </div>

    <h2>Lotka–Volterra</h2>
    <div class="ode-inputs">
      <div class="field"><label for="ode-alpha">α</label><input type="number" id="ode-alpha" data-testid="ode-alpha" step="0.01" value="1.1"></div>
      <div class="field"><label for="ode-beta">β</label><input type="number" id="ode-beta" data-testid="ode-beta" step="0.01" value="0.4"></div>
      <div class="field"><label for="ode-gamma">γ</label><input type="number" id="ode-gamma" data-testid="ode-gamma" step="0.01" value="0.4"></div>
      <div class="field"><label for="ode-delta">δ</label><input type="number" id="ode-delta" data-testid="ode-delta" step="0.01" value="0.1"></div>
      <div class="field"><label for="ode-x0">x₀</label><input type="number" id="ode-x0" data-testid="ode-x0" step="0.1" value="10"></div>
      <div class="field"><label for="ode-y0">y₀</label><input type="number" id="ode-y0" data-testid="ode-y0" step="0.1" value="10"></div>
      <div class="field"><label for="ode-t">t</label><input type="number" id="ode-t" data-testid="ode-t" step="1" value="50"></div>
      <div class="field"><label for="ode-dt">dt</label><input type="number" id="ode-dt" data-testid="ode-dt" step="0.001" value="0.01"></div>
    </div>
    <div class="row"><button type="button" data-testid="ode-run" id="ode-run">Run</button></div>
    <svg data-testid="ode-chart" class="chart" viewBox="0 0 420 220" preserveAspectRatio="xMidYMid meet" style="margin-top:10px" role="img" aria-label="Lotka-Volterra trajectory chart">
      <rect x="0" y="0" width="420" height="220" fill="#ffffff"></rect>
      <line class="axis-line" x1="44" y1="20" x2="44" y2="186"></line>
      <line class="axis-line" x1="44" y1="186" x2="390" y2="186"></line>
      <text class="axis-label" x="10" y="16">value</text>
      <text class="axis-label" x="217" y="212" text-anchor="middle">time</text>
      <polyline data-testid="ode-series-x" fill="none" stroke="#2f7d4f" stroke-width="1.4" points=""></polyline>
      <polyline data-testid="ode-series-y" fill="none" stroke="#c8571f" stroke-width="1.4" points=""></polyline>
    </svg>
    <div class="ode-out">
      <div>x = <span data-testid="ode-x"></span></div>
      <div>y = <span data-testid="ode-y"></span></div>
      <div>γ/δ = <span data-testid="ode-eq-x"></span></div>
      <div>α/β = <span data-testid="ode-eq-y"></span></div>
      <div>drift = <span data-testid="ode-drift"></span></div>
    </div>

    <h2>Scenario</h2>
    <textarea data-testid="scenario-json" id="scenario-json" spellcheck="false" placeholder="Scenario JSON…"></textarea>
    <div class="row">
      <button type="button" data-testid="scenario-export" id="scenario-export">Export to text</button>
      <button type="button" data-testid="scenario-load" id="scenario-load">Load from text</button>
      <button type="button" data-testid="csv-export" id="csv-export">Download CSV</button>
    </div>
    <div class="error" data-testid="scenario-error" id="scenario-error"></div>

    <h2>Presets</h2>
    <div class="row">
      <label for="preset-name">Name</label>
      <input type="text" id="preset-name" data-testid="preset-name" placeholder="My scenario">
      <button type="button" data-testid="preset-save" id="preset-save">Save</button>
    </div>
    <ul class="preset-list" data-testid="preset-list" id="preset-list"></ul>

    <div id="announcer" data-testid="announcer" class="sr-only" aria-live="polite"></div>
  </section>

</div>

<script>
(function () {
  'use strict';

  /* ---------------------------------------------------------------- RNG */
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

  /* ----------------------------------------------------------- defaults */
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
  var PARAM_KEYS = ['width', 'height', 'grassMax', 'rabbits0', 'foxes0', 'rabbitStart',
    'rabbitGain', 'rabbitCost', 'rabbitBreed', 'foxStart', 'foxGain', 'foxCost', 'foxBreed'];
  var SLIDER_KEYS = ['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax'];

  /* -------------------------------------------------------------- state */
  var P = Object.assign({}, DEFAULTS);
  var W = P.width, H = P.height;
  var rand = mulberry32(0);
  var seed = 42;
  var tickCount = 0;
  var nextId = 1;
  var cells = [];
  var rabbits = [];
  var foxes = [];
  var history = [];
  var playing = false;
  var rafId = null;
  var lastTs = 0;
  var acc = 0;

  /* --------------------------------------------------------------- DOM */
  var canvas = document.getElementById('world');
  var seedEl = document.getElementById('seed');
  var speedEl = document.getElementById('speed');
  var speedValEl = document.getElementById('speed-val');
  var btnPlay = document.getElementById('btn-play');
  var btnPause = document.getElementById('btn-pause');
  var btnStep = document.getElementById('btn-step');
  var btnReset = document.getElementById('btn-reset');
  var elTick = document.querySelector('[data-testid="tick"]');
  var elRab = document.querySelector('[data-testid="count-rabbits"]');
  var elFox = document.querySelector('[data-testid="count-foxes"]');
  var elGra = document.querySelector('[data-testid="count-grass"]');
  var chartR = document.querySelector('[data-testid="series-rabbits"]');
  var chartF = document.querySelector('[data-testid="series-foxes"]');
  var odeChartX = document.querySelector('[data-testid="ode-series-x"]');
  var odeChartY = document.querySelector('[data-testid="ode-series-y"]');
  var odeXEl = document.querySelector('[data-testid="ode-x"]');
  var odeYEl = document.querySelector('[data-testid="ode-y"]');
  var odeEqXEl = document.querySelector('[data-testid="ode-eq-x"]');
  var odeEqYEl = document.querySelector('[data-testid="ode-eq-y"]');
  var odeDriftEl = document.querySelector('[data-testid="ode-drift"]');
  var scenarioEl = document.getElementById('scenario-json');
  var scenarioErrEl = document.getElementById('scenario-error');
  var presetNameEl = document.getElementById('preset-name');
  var presetListEl = document.getElementById('preset-list');
  var announcerEl = document.getElementById('announcer');

  /* ------------------------------------------------------------ helpers */
  function pick(list) {
    if (!list.length) return undefined;
    return list[Math.floor(rand() * list.length)];
  }

  function neighbors(x, y) {
    var out = [];
    if (y > 0) out.push([x, y - 1]);
    if (x < W - 1) out.push([x + 1, y]);
    if (y < H - 1) out.push([x, y + 1]);
    if (x > 0) out.push([x - 1, y]);
    return out;
  }

  function grassSum() {
    var s = 0;
    for (var i = 0; i < cells.length; i++) s += cells[i].grass;
    return s;
  }

  function counts() {
    return { rabbits: rabbits.length, foxes: foxes.length, grass: grassSum() };
  }

  function killRabbit(r) {
    r.alive = false;
    var c = cells[r.y * W + r.x];
    if (c && c.rabbit === r) c.rabbit = null;
    var i = rabbits.indexOf(r);
    if (i >= 0) rabbits.splice(i, 1);
  }

  function killFox(f) {
    f.alive = false;
    var c = cells[f.y * W + f.x];
    if (c && c.fox === f) c.fox = null;
    var i = foxes.indexOf(f);
    if (i >= 0) foxes.splice(i, 1);
  }

  function moveAnimal(a, nx, ny, kind) {
    var from = cells[a.y * W + a.x];
    if (from[kind] === a) from[kind] = null;
    a.x = nx;
    a.y = ny;
    cells[ny * W + nx][kind] = a;
  }

  /* -------------------------------------------------------------- reset */
  function reset(seedValue, params) {
    var s;
    if (typeof seedValue === 'number' && isFinite(seedValue)) s = Math.trunc(seedValue);
    else s = parseInt(seedValue, 10);
    if (!isFinite(s)) s = 0;
    seed = s;

    P = Object.assign({}, DEFAULTS, params || {});
    W = Math.max(1, Math.floor(P.width) || 1);
    H = Math.max(1, Math.floor(P.height) || 1);

    rand = mulberry32(seed);
    tickCount = 0;
    nextId = 1;
    rabbits = [];
    foxes = [];
    history = [];

    var n = W * H, i, j;
    cells = new Array(n);
    for (i = 0; i < n; i++) {
      cells[i] = { grass: Math.floor(rand() * (P.grassMax + 1)), rabbit: null, fox: null };
    }

    for (i = 0; i < P.rabbits0; i++) {
      var free = [];
      for (j = 0; j < n; j++) if (!cells[j].rabbit) free.push(j);
      if (!free.length) break;
      var spot = pick(free);
      var r = {
        id: nextId++, x: spot % W, y: Math.floor(spot / W),
        energy: P.rabbitStart, alive: true
      };
      cells[spot].rabbit = r;
      rabbits.push(r);
    }

    for (i = 0; i < P.foxes0; i++) {
      var free2 = [];
      for (j = 0; j < n; j++) if (!cells[j].fox) free2.push(j);
      if (!free2.length) break;
      var spot2 = pick(free2);
      var f = {
        id: nextId++, x: spot2 % W, y: Math.floor(spot2 / W),
        energy: P.foxStart, alive: true
      };
      cells[spot2].fox = f;
      foxes.push(f);
    }

    history.push({
      tick: 0,
      rabbits: rabbits.length,
      foxes: foxes.length,
      grass: grassSum()
    });

    canvas.width = W * 10;
    canvas.height = H * 10;

    updateAll();
    return counts();
  }

  /* --------------------------------------------------------------- tick */
  function doTick() {
    var i, j, k;
    var n = cells.length;

    /* 1. grass grows */
    for (i = 0; i < n; i++) {
      var c = cells[i];
      if (c.grass < P.grassMax) c.grass = c.grass + 1;
    }

    /* 2. rabbits */
    var rlist = rabbits.slice().sort(function (a, b) { return a.id - b.id; });
    for (k = 0; k < rlist.length; k++) {
      var r = rlist[k];
      if (!r.alive) continue;

      /* move */
      var nb = neighbors(r.x, r.y);
      var opts = [];
      for (j = 0; j < nb.length; j++) {
        if (!cells[nb[j][1] * W + nb[j][0]].rabbit) opts.push(nb[j]);
      }
      if (opts.length) {
        var t1 = pick(opts);
        moveAnimal(r, t1[0], t1[1], 'rabbit');
      }

      /* eat */
      var ci = r.y * W + r.x;
      r.energy += P.rabbitGain * cells[ci].grass;
      cells[ci].grass = 0;

      /* cost */
      r.energy -= P.rabbitCost;

      /* breed */
      if (r.energy >= P.rabbitBreed) {
        var nb2 = neighbors(r.x, r.y);
        var spots = [];
        for (j = 0; j < nb2.length; j++) {
          if (!cells[nb2[j][1] * W + nb2[j][0]].rabbit) spots.push(nb2[j]);
        }
        if (spots.length) {
          var t2 = pick(spots);
          var childE = Math.floor(r.energy / 2);
          r.energy -= childE;
          var nr = { id: nextId++, x: t2[0], y: t2[1], energy: childE, alive: true };
          cells[t2[1] * W + t2[0]].rabbit = nr;
          rabbits.push(nr);
        }
      }

      /* die */
      if (r.energy <= 0) killRabbit(r);
    }

    /* 3. foxes */
    var flist = foxes.slice().sort(function (a, b) { return a.id - b.id; });
    for (k = 0; k < flist.length; k++) {
      var f = flist[k];
      if (!f.alive) continue;

      /* move */
      var nb3 = neighbors(f.x, f.y);
      var hunt = [];
      for (j = 0; j < nb3.length; j++) {
        var cc = cells[nb3[j][1] * W + nb3[j][0]];
        if (cc.rabbit && !cc.fox) hunt.push(nb3[j]);
      }
      if (!hunt.length) {
        for (j = 0; j < nb3.length; j++) {
          if (!cells[nb3[j][1] * W + nb3[j][0]].fox) hunt.push(nb3[j]);
        }
      }
      if (hunt.length) {
        var t3 = pick(hunt);
        moveAnimal(f, t3[0], t3[1], 'fox');
      }

      /* eat */
      var here = cells[f.y * W + f.x];
      if (here.rabbit) {
        killRabbit(here.rabbit);
        f.energy += P.foxGain;
      }

      /* cost */
      f.energy -= P.foxCost;

      /* breed */
      if (f.energy >= P.foxBreed) {
        var nb4 = neighbors(f.x, f.y);
        var spots2 = [];
        for (j = 0; j < nb4.length; j++) {
          if (!cells[nb4[j][1] * W + nb4[j][0]].fox) spots2.push(nb4[j]);
        }
        if (spots2.length) {
          var t4 = pick(spots2);
          var childF = Math.floor(f.energy / 2);
          f.energy -= childF;
          var nf = { id: nextId++, x: t4[0], y: t4[1], energy: childF, alive: true };
          cells[t4[1] * W + t4[0]].fox = nf;
          foxes.push(nf);
        }
      }

      /* die */
      if (f.energy <= 0) killFox(f);
    }

    /* 4. record */
    tickCount += 1;
    history.push({
      tick: tickCount,
      rabbits: rabbits.length,
      foxes: foxes.length,
      grass: grassSum()
    });
  }

  /* ------------------------------------------------------------- render */
  function draw() {
    var ctx;
    try { ctx = canvas.getContext('2d'); } catch (e) { return; }
    if (!ctx) return;

    var x, y, i, c, g;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        c = cells[y * W + x];
        g = 60 + Math.round(160 * c.grass / P.grassMax);
        ctx.fillStyle = 'rgb(30,' + g + ',30)';
        ctx.fillRect(x * 10, y * 10, 10, 10);
      }
    }
    for (i = 0; i < cells.length; i++) {
      if (cells[i].rabbit) {
        x = (i % W) * 10;
        y = Math.floor(i / W) * 10;
        ctx.fillStyle = 'rgb(240,240,240)';
        ctx.fillRect(x + 2, y + 2, 6, 6);
      }
    }
    for (i = 0; i < cells.length; i++) {
      if (cells[i].fox) {
        x = (i % W) * 10;
        y = Math.floor(i / W) * 10;
        ctx.fillStyle = 'rgb(220,80,20)';
        ctx.fillRect(x + 2, y + 2, 6, 6);
      }
    }
  }

  function updateChart() {
    var n = history.length;
    var maxT = 1;
    if (n) maxT = Math.max(1, history[n - 1].tick);
    var maxC = 1;
    for (var i = 0; i < n; i++) {
      if (history[i].rabbits > maxC) maxC = history[i].rabbits;
      if (history[i].foxes > maxC) maxC = history[i].foxes;
    }
    var ptsR = [], ptsF = [];
    for (i = 0; i < n; i++) {
      var h = history[i];
      var px = 44 + (h.tick / maxT) * 346;
      ptsR.push(px.toFixed(2) + ',' + (186 - (h.rabbits / maxC) * 166).toFixed(2));
      ptsF.push(px.toFixed(2) + ',' + (186 - (h.foxes / maxC) * 166).toFixed(2));
    }
    chartR.setAttribute('points', ptsR.join(' '));
    chartF.setAttribute('points', ptsF.join(' '));
  }

  function updateCounters() {
    elTick.textContent = String(tickCount);
    elRab.textContent = String(rabbits.length);
    elFox.textContent = String(foxes.length);
    elGra.textContent = String(grassSum());
  }

  function updateAnnouncer() {
    announcerEl.textContent = 'Tick ' + tickCount + ': ' + rabbits.length +
      ' rabbits, ' + foxes.length + ' foxes';
  }

  function updateAll() {
    draw();
    updateChart();
    updateCounters();
    updateAnnouncer();
  }

  /* ------------------------------------------------------------- timing */
  function currentSpeed() {
    var v = parseFloat(speedEl.value);
    if (!isFinite(v) || v <= 0) v = 10;
    return v;
  }

  function loop(ts) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    if (!isFinite(dt) || dt < 0) dt = 0;
    lastTs = ts;
    acc += dt * currentSpeed();
    var steps = Math.floor(acc);
    if (steps > 0) {
      acc -= steps;
      for (var i = 0; i < steps; i++) doTick();
      updateAll();
    }
    rafId = requestAnimationFrame(loop);
  }

  function startPlay() {
    if (playing) return;
    playing = true;
    lastTs = 0;
    acc = 0;
    rafId = requestAnimationFrame(loop);
    updateAnnouncer();
  }

  function stopPlay() {
    playing = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    updateAnnouncer();
  }

  /* --------------------------------------------------------- CSV / JSON */
  function exportCSV() {
    var out = 'tick,rabbits,foxes,grass\n';
    for (var i = 0; i < history.length; i++) {
      var h = history[i];
      out += h.tick + ',' + h.rabbits + ',' + h.foxes + ',' + h.grass + '\n';
    }
    return out;
  }

  function exportScenario() {
    var params = {};
    for (var i = 0; i < PARAM_KEYS.length; i++) params[PARAM_KEYS[i]] = P[PARAM_KEYS[i]];
    return JSON.stringify({ version: 1, seed: seed, params: params });
  }

  function setError(msg) {
    scenarioErrEl.textContent = msg || '';
  }

  function applyScenario(obj) {
    reset(obj.seed, obj.params || {});
    syncControls();
  }

  function loadScenario(text) {
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      setError('Invalid scenario: the text is not valid JSON.');
      return false;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      setError('Invalid scenario: expected a JSON object.');
      return false;
    }
    if (obj.version !== 1) {
      setError('Invalid scenario: unsupported version.');
      return false;
    }
    if (typeof obj.seed !== 'number' || !Number.isInteger(obj.seed)) {
      setError('Invalid scenario: seed must be an integer.');
      return false;
    }
    setError('');
    applyScenario(obj);
    return true;
  }

  /* --------------------------------------------------------------- ODE */
  function num(v) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function rk4Step(p, x, y, dt) {
    var k1x = p.alpha * x - p.beta * x * y;
    var k1y = p.delta * x * y - p.gamma * y;
    var x2 = x + dt / 2 * k1x, y2 = y + dt / 2 * k1y;
    var k2x = p.alpha * x2 - p.beta * x2 * y2;
    var k2y = p.delta * x2 * y2 - p.gamma * y2;
    var x3 = x + dt / 2 * k2x, y3 = y + dt / 2 * k2y;
    var k3x = p.alpha * x3 - p.beta * x3 * y3;
    var k3y = p.delta * x3 * y3 - p.gamma * y3;
    var x4 = x + dt * k3x, y4 = y + dt * k3y;
    var k4x = p.alpha * x4 - p.beta * x4 * y4;
    var k4y = p.delta * x4 * y4 - p.gamma * y4;
    return [
      x + dt / 6 * (k1x + 2 * k2x + 2 * k3x + k4x),
      y + dt / 6 * (k1y + 2 * k2y + 2 * k3y + k4y)
    ];
  }

  function normODE(p) {
    p = p || {};
    return {
      alpha: num(p.alpha), beta: num(p.beta), gamma: num(p.gamma), delta: num(p.delta),
      x0: num(p.x0), y0: num(p.y0)
    };
  }

  function odeIntegrate(p, t, dt) {
    var q = normODE(p);
    var x = q.x0, y = q.y0;
    if (!(dt > 0) || !isFinite(dt) || !isFinite(t)) return { x: x, y: y };
    var n = Math.round(t / dt);
    if (!isFinite(n) || n < 0) return { x: x, y: y };
    if (n > 2000000) n = 2000000;
    for (var i = 0; i < n; i++) {
      var s = rk4Step(q, x, y, dt);
      x = s[0];
      y = s[1];
    }
    return { x: x, y: y };
  }

  function odeTrajectory(p, t, dt) {
    var q = normODE(p);
    var pts = [{ t: 0, x: q.x0, y: q.y0 }];
    if (!(dt > 0) || !isFinite(dt) || !isFinite(t)) return pts;
    var n = Math.round(t / dt);
    if (!isFinite(n) || n < 0) return pts;
    if (n > 2000000) n = 2000000;
    var x = q.x0, y = q.y0;
    for (var i = 1; i <= n; i++) {
      var s = rk4Step(q, x, y, dt);
      x = s[0];
      y = s[1];
      pts.push({ t: i * dt, x: x, y: y });
    }
    return pts;
  }

  function fmt(v) {
    if (typeof v !== 'number' || !isFinite(v)) return String(v);
    return v.toPrecision(15);
  }

  var ODE_KEYS = ['alpha', 'beta', 'gamma', 'delta', 'x0', 'y0', 't', 'dt'];

  function readODEInputs() {
    var o = {};
    for (var i = 0; i < ODE_KEYS.length; i++) {
      var k = ODE_KEYS[i];
      var el = document.querySelector('[data-testid="ode-' + k + '"]');
      var v = el ? parseFloat(el.value) : NaN;
      o[k] = isFinite(v) ? v : 0;
    }
    return o;
  }

  function runODE() {
    var o = readODEInputs();
    var p = { alpha: o.alpha, beta: o.beta, gamma: o.gamma, delta: o.delta, x0: o.x0, y0: o.y0 };
    var pts = odeTrajectory(p, o.t, o.dt);
    var end = pts[pts.length - 1];

    odeXEl.textContent = fmt(end.x);
    odeYEl.textContent = fmt(end.y);
    odeEqXEl.textContent = o.delta !== 0 ? fmt(o.gamma / o.delta) : 'Infinity';
    odeEqYEl.textContent = o.beta !== 0 ? fmt(o.alpha / o.beta) : 'Infinity';

    function V(x, y) {
      return o.delta * x - o.gamma * Math.log(x) + o.beta * y - o.alpha * Math.log(y);
    }
    var drift = Math.abs(V(end.x, end.y) - V(o.x0, o.y0));
    odeDriftEl.textContent = typeof drift === 'number' && isFinite(drift)
      ? String(drift) : String(drift);

    drawODEChart(pts, o);
  }

  function drawODEChart(pts, o) {
    var n = pts.length;
    var maxT = 1;
    if (n > 1) maxT = pts[n - 1].t;
    if (!(maxT > 0)) maxT = 1;
    var maxY = 1;
    for (var i = 0; i < n; i++) {
      if (isFinite(pts[i].x) && pts[i].x > maxY) maxY = pts[i].x;
      if (isFinite(pts[i].y) && pts[i].y > maxY) maxY = pts[i].y;
    }
    if (!isFinite(maxY) || maxY <= 0) maxY = 1;

    var step = Math.max(1, Math.ceil(n / 600));
    var sample = [];
    for (i = 0; i < n; i += step) sample.push(pts[i]);
    if (sample[sample.length - 1] !== pts[n - 1]) sample.push(pts[n - 1]);

    var sx = [], sy = [];
    for (i = 0; i < sample.length; i++) {
      var q = sample[i];
      var px = 44 + (q.t / maxT) * 346;
      var vx = isFinite(q.x) ? q.x : 0;
      var vy = isFinite(q.y) ? q.y : 0;
      sx.push(px.toFixed(2) + ',' + (186 - (vx / maxY) * 166).toFixed(2));
      sy.push(px.toFixed(2) + ',' + (186 - (vy / maxY) * 166).toFixed(2));
    }
    odeChartX.setAttribute('points', sx.join(' '));
    odeChartY.setAttribute('points', sy.join(' '));
  }

  /* ---------------------------------------------------------- presets */
  var PRESET_KEY = 'ecolab.presets';

  function readPresets() {
    try {
      var raw = localStorage.getItem(PRESET_KEY);
      if (!raw) return {};
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
      return o;
    } catch (e) {
      return {};
    }
  }

  function writePresets(o) {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
  }

  function renderPresets() {
    var presets = readPresets();
    var names = Object.keys(presets);
    presetListEl.innerHTML = '';
    names.forEach(function (name) {
      var li = document.createElement('li');
      li.className = 'preset-item';
      li.setAttribute('data-testid', 'preset-item');

      var span = document.createElement('span');
      span.className = 'preset-name';
      span.textContent = name;

      var loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.setAttribute('data-testid', 'preset-load');
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', function () {
        var all = readPresets();
        if (!(name in all)) return;
        loadScenario(JSON.stringify(all[name]));
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

      li.appendChild(span);
      li.appendChild(loadBtn);
      li.appendChild(delBtn);
      presetListEl.appendChild(li);
    });
  }

  /* ------------------------------------------------------------ controls */
  function sliderParams() {
    var o = {};
    for (var i = 0; i < SLIDER_KEYS.length; i++) {
      var k = SLIDER_KEYS[i];
      var el = document.querySelector('[data-testid="param-' + k + '"]');
      var v = el ? parseInt(el.value, 10) : NaN;
      o[k] = isFinite(v) ? v : DEFAULTS[k];
    }
    return o;
  }

  function syncControls() {
    seedEl.value = String(seed);
    for (var i = 0; i < SLIDER_KEYS.length; i++) {
      var k = SLIDER_KEYS[i];
      var el = document.querySelector('[data-testid="param-' + k + '"]');
      var lab = document.getElementById('val-' + k);
      if (el) el.value = String(P[k]);
      if (lab) lab.textContent = String(P[k]);
    }
  }

  function uiReset() {
    stopPlay();
    var s = parseInt(seedEl.value, 10);
    if (!isFinite(s)) s = 0;
    seedEl.value = String(s);
    reset(s, sliderParams());
  }

  btnPlay.addEventListener('click', function () { startPlay(); });
  btnPause.addEventListener('click', function () { stopPlay(); });
  btnStep.addEventListener('click', function () {
    stopPlay();
    doTick();
    updateAll();
  });
  btnReset.addEventListener('click', uiReset);

  speedEl.addEventListener('input', function () {
    speedValEl.textContent = speedEl.value;
  });

  SLIDER_KEYS.forEach(function (k) {
    var el = document.querySelector('[data-testid="param-' + k + '"]');
    var lab = document.getElementById('val-' + k);
    if (el && lab) {
      el.addEventListener('input', function () { lab.textContent = el.value; });
    }
  });

  document.getElementById('scenario-export').addEventListener('click', function () {
    scenarioEl.value = exportScenario();
    setError('');
  });

  document.getElementById('scenario-load').addEventListener('click', function () {
    loadScenario(scenarioEl.value);
  });

  document.getElementById('csv-export').addEventListener('click', function () {
    download('ecolab.csv', exportCSV(), 'text/csv');
  });

  function download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      try {
        var a2 = document.createElement('a');
        a2.href = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(text);
        a2.download = filename;
        document.body.appendChild(a2);
        a2.click();
        a2.remove();
      } catch (e2) { /* ignore */ }
    }
  }

  document.getElementById('preset-save').addEventListener('click', function () {
    var name = (presetNameEl.value || '').trim();
    if (!name) name = 'Untitled';
    var all = readPresets();
    try {
      all[name] = JSON.parse(exportScenario());
    } catch (e) {
      all[name] = { version: 1, seed: seed, params: Object.assign({}, P) };
    }
    writePresets(all);
    renderPresets();
  });

  document.getElementById('ode-run').addEventListener('click', runODE);

  /* ----------------------------------------------------------- shortcuts */
  document.addEventListener('keydown', function (e) {
    var ae = document.activeElement;
    if (ae) {
      var tag = ae.tagName ? ae.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      if (ae.isContentEditable) return;
    }
    if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (playing) stopPlay(); else startPlay();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      stopPlay();
      doTick();
      updateAll();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      uiReset();
    }
  });

  /* ---------------------------------------------------------- public API */
  window.lab = {
    reset: function (s, params) {
      stopPlay();
      return reset(s, params || {});
    },
    step: function (n) {
      var k = (n === undefined || n === null) ? 1 : Math.floor(n);
      if (!isFinite(k) || k < 0) k = 0;
      for (var i = 0; i < k; i++) doTick();
      updateAll();
      return counts();
    },
    counts: function () { return counts(); },
    tick: function () { return tickCount; },
    cell: function (x, y) {
      x = Math.trunc(x); y = Math.trunc(y);
      if (!(x >= 0 && y >= 0 && x < W && y < H)) return { grass: 0, rabbit: null, fox: null };
      var c = cells[y * W + x];
      return {
        grass: c.grass,
        rabbit: c.rabbit ? { id: c.rabbit.id, energy: c.rabbit.energy } : null,
        fox: c.fox ? { id: c.fox.id, energy: c.fox.energy } : null
      };
    },
    history: function () {
      return history.map(function (h) {
        return { tick: h.tick, rabbits: h.rabbits, foxes: h.foxes, grass: h.grass };
      });
    },
    ode: function (p, t, dt) {
      return odeIntegrate(p, num(t), num(dt));
    },
    exportCSV: function () { return exportCSV(); },
    exportScenario: function () { return exportScenario(); },
    loadScenario: function (text) { return loadScenario(text); }
  };

  /* --------------------------------------------------------------- boot */
  reset(42, {});
  seedEl.value = '42';
  syncControls();
  renderPresets();
  runODE();
})();
</script>
</body>
</html>
```