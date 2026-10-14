## Plan

**Data model.** `params` holds the 13 merged values. The world is a row-major array `grass` of `width*height` integers, plus parallel `rabbitGrid`/`foxGrid` arrays holding animal objects or `null`, and `rabbits`/`foxes` lists. Animals are `{id, x, y, energy}` with one shared id counter. `hist` stores one `{tick, rabbits, foxes, grass}` per tick. `rand` is the single mulberry32 stream; `pick` draws a number only when its list is non-empty.

**Tick order.** (1) grass +1, capped. (2) Rabbits snapshot by ascending id: move to a random rabbit-free neighbour (else stay); eat `rabbitGain * grass` and zero the cell; pay `rabbitCost`; breed if energy ≥ `rabbitBreed`, splitting `floor(energy/2)` into a random free neighbour; die if energy ≤ 0. (3) Foxes snapshot by id: move to a random neighbour holding a rabbit and no fox, else any neighbour without a fox, else stay; eat the rabbit now in its cell; pay `foxCost`; breed into a random fox-free neighbour; die if ≤ 0. (4) `tick++`, push the history point.

**Components.** `window.lab` API (reset, step, counts, tick, cell, history, ode, exportCSV, exportScenario, loadScenario); canvas renderer (10 px cells, grass gradient, rabbit/fox marks, fox over rabbit); population SVG chart; Lotka–Volterra panel (RK4 integrator, V-function drift, trajectory chart); scenario textarea with error line; localStorage presets; controls (play/pause/step/reset, seed, speed, six parameter sliders) driven by a `performance.now()` accumulator so speed changes apply instantly; polite announcer plus body-focus keyboard shortcuts.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ecosystem Lab</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0;max-width:100%}
  body{
    background:#0b1310;color:#e8f2ea;
    font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-text-size-adjust:100%;
  }
  h1{font-size:1.25rem;margin:0}
  h2{font-size:.78rem;margin:0 0 8px;text-transform:uppercase;letter-spacing:.1em;color:#8fb59c;font-weight:600}
  h3{font-size:.78rem;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.08em;color:#8fb59c;font-weight:600}
  .topbar{max-width:1400px;margin:0 auto;padding:16px 16px 4px}
  .topbar p{margin:3px 0 0;color:#8fb59c;font-size:.84rem}
  .layout{max-width:1400px;margin:0 auto;padding:10px 16px 40px}
  .panel{background:#121d16;border:1px solid #253a2c;border-radius:14px;padding:14px;margin:0 0 16px;min-width:0}
  @media (min-width:1000px){
    .layout{display:flex;gap:16px;align-items:flex-start}
    #panel-world{flex:1 1 420px;min-width:0;margin-bottom:0}
    #panel-side{flex:1 1 460px;max-width:580px;min-width:0;margin-bottom:0}
  }
  canvas{display:block;max-width:100%;height:auto;margin:0 auto;image-rendering:pixelated;border-radius:6px}
  .canvas-wrap{background:#0a0f0c;border:1px solid #253a2c;border-radius:10px;padding:8px;margin-bottom:10px;overflow:hidden}
  .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
  button{
    font:inherit;color:#e8f2ea;background:#1c2b21;border:1px solid #2f4636;border-radius:10px;
    padding:7px 12px;cursor:pointer;
  }
  button:hover{background:#24382a;border-color:#41603f}
  button:active{transform:translateY(1px)}
  :focus{outline:3px solid #ffd166;outline-offset:2px}
  input[type="number"],input[type="text"],textarea{
    font:inherit;color:#e8f2ea;background:#0e1712;border:1px solid #2f4636;border-radius:9px;
    padding:6px 8px;min-width:0;max-width:100%;
  }
  input[type="number"]{width:92px}
  input[type="range"]{width:100%;min-width:110px;accent-color:#5fd18b;background:transparent}
  textarea{width:100%;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.78rem}
  label{font-size:.8rem;color:#a8c4b1}
  .counters{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
  .counter{background:#182619;border:1px solid #253a2c;border-radius:10px;padding:6px 10px;display:flex;gap:8px;align-items:baseline;min-width:74px}
  .clabel{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#8fb59c}
  .cval{font-variant-numeric:tabular-nums;font-weight:600}
  .params{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 18px;margin-top:8px}
  .param{display:grid;grid-template-columns:1fr auto;align-items:center;gap:0 8px}
  .param label{grid-column:1/-1;font-size:.8rem}
  .param input[type="range"]{grid-column:1/2}
  .param .val{grid-column:2/3;font-variant-numeric:tabular-nums;font-size:.85rem;color:#cfe4d6;text-align:right;min-width:2.2em}
  .announcer{margin-top:10px;font-size:.82rem;color:#9fbfa9;min-height:1.2em}
  .chart{width:100%;height:auto;display:block;background:#0d1812;border:1px solid #253a2c;border-radius:10px}
  .ode-grid{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin-bottom:8px}
  .ode-grid input{width:100%}
  .stats{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
  .stat{background:#182619;border:1px solid #253a2c;border-radius:10px;padding:5px 10px;display:flex;gap:7px;align-items:baseline}
  .sval{font-variant-numeric:tabular-nums;font-size:.85rem;word-break:break-all}
  .error{color:#ff9a8a;font-size:.82rem;min-height:1.2em}
  .preset-list{display:flex;flex-direction:column;gap:6px;margin-top:8px}
  .preset-item{display:flex;align-items:center;gap:8px;background:#182619;border:1px solid #253a2c;border-radius:10px;padding:6px 10px;flex-wrap:wrap}
  .preset-item .pname{flex:1 1 100px;min-width:0;overflow-wrap:anywhere;font-size:.86rem}
  .preset-item button{padding:4px 9px;font-size:.82rem}
  .hint{font-size:.76rem;color:#7d9a88;margin:0 0 6px}
</style>
</head>
<body>
<header class="topbar">
  <h1>Ecosystem Lab</h1>
  <p>Grass, rabbits and foxes on a grid — with Lotka–Volterra comparison and shareable scenarios.</p>
</header>

<main class="layout">
  <section id="panel-world" data-testid="panel-world" class="panel" aria-label="World">
    <h2>World</h2>
    <div class="canvas-wrap">
      <canvas data-testid="world" width="400" height="300" role="img" aria-label="Simulation grid"></canvas>
    </div>

    <div class="row">
      <button data-testid="play" type="button">Play</button>
      <button data-testid="pause" type="button">Pause</button>
      <button data-testid="step" type="button">Step</button>
      <button data-testid="reset" type="button">Reset</button>
    </div>

    <div class="row">
      <label for="seed">Seed</label>
      <input id="seed" data-testid="seed" type="number" step="1" value="42">
      <label for="speed">Speed</label>
      <input id="speed" data-testid="speed" type="range" min="1" max="60" step="1" value="10">
      <span class="val" id="speed-out">10</span>
    </div>

    <div class="counters">
      <div class="counter"><span class="clabel">Tick</span><span class="cval" data-testid="tick">0</span></div>
      <div class="counter"><span class="clabel">Rabbits</span><span class="cval" data-testid="count-rabbits">0</span></div>
      <div class="counter"><span class="clabel">Foxes</span><span class="cval" data-testid="count-foxes">0</span></div>
      <div class="counter"><span class="clabel">Grass</span><span class="cval" data-testid="count-grass">0</span></div>
    </div>

    <h3>Parameters (applied on reset)</h3>
    <div class="params">
      <div class="param">
        <label for="param-rabbits0">Rabbits at reset</label>
        <input id="param-rabbits0" data-testid="param-rabbits0" type="range" min="0" max="300" step="1" value="100">
        <span class="val" id="out-rabbits0">100</span>
      </div>
      <div class="param">
        <label for="param-foxes0">Foxes at reset</label>
        <input id="param-foxes0" data-testid="param-foxes0" type="range" min="0" max="60" step="1" value="6">
        <span class="val" id="out-foxes0">6</span>
      </div>
      <div class="param">
        <label for="param-rabbitBreed">Rabbit breed energy</label>
        <input id="param-rabbitBreed" data-testid="param-rabbitBreed" type="range" min="2" max="40" step="1" value="12">
        <span class="val" id="out-rabbitBreed">12</span>
      </div>
      <div class="param">
        <label for="param-foxBreed">Fox breed energy</label>
        <input id="param-foxBreed" data-testid="param-foxBreed" type="range" min="2" max="60" step="1" value="40">
        <span class="val" id="out-foxBreed">40</span>
      </div>
      <div class="param">
        <label for="param-foxGain">Fox energy per rabbit</label>
        <input id="param-foxGain" data-testid="param-foxGain" type="range" min="1" max="30" step="1" value="4">
        <span class="val" id="out-foxGain">4</span>
      </div>
      <div class="param">
        <label for="param-grassMax">Grass max level</label>
        <input id="param-grassMax" data-testid="param-grassMax" type="range" min="1" max="10" step="1" value="4">
        <span class="val" id="out-grassMax">4</span>
      </div>
    </div>

    <div class="announcer" data-testid="announcer" aria-live="polite"></div>
  </section>

  <section id="panel-side" data-testid="panel-side" class="panel" aria-label="Analysis">
    <h2>Populations</h2>
    <svg data-testid="chart" viewBox="0 0 400 200" class="chart" role="img" aria-label="Population history chart">
      <line x1="44" y1="14" x2="44" y2="172" stroke="#33513e" stroke-width="1"></line>
      <line x1="44" y1="172" x2="392" y2="172" stroke="#33513e" stroke-width="1"></line>
      <line x1="44" y1="93" x2="392" y2="93" stroke="#22392c" stroke-width="1"></line>
      <text x="392" y="188" fill="#9fbfa9" font-size="11" text-anchor="end">tick</text>
      <text x="6" y="20" fill="#9fbfa9" font-size="11">count</text>
      <polyline data-testid="series-rabbits" fill="none" stroke="#f0f0f0" stroke-width="1.5" points=""></polyline>
      <polyline data-testid="series-foxes" fill="none" stroke="#dc5014" stroke-width="1.5" points=""></polyline>
    </svg>

    <h2 style="margin-top:16px">Lotka–Volterra</h2>
    <p class="hint">dx/dt = αx − βxy &nbsp;·&nbsp; dy/dt = δxy − γy</p>
    <div class="ode-grid">
      <label for="ode-alpha">α</label><input id="ode-alpha" data-testid="ode-alpha" type="number" step="any" value="1.1">
      <label for="ode-beta">β</label><input id="ode-beta" data-testid="ode-beta" type="number" step="any" value="0.4">
      <label for="ode-gamma">γ</label><input id="ode-gamma" data-testid="ode-gamma" type="number" step="any" value="0.4">
      <label for="ode-delta">δ</label><input id="ode-delta" data-testid="ode-delta" type="number" step="any" value="0.1">
      <label for="ode-x0">x₀</label><input id="ode-x0" data-testid="ode-x0" type="number" step="any" value="10">
      <label for="ode-y0">y₀</label><input id="ode-y0" data-testid="ode-y0" type="number" step="any" value="10">
      <label for="ode-t">time t</label><input id="ode-t" data-testid="ode-t" type="number" step="any" value="50">
      <label for="ode-dt">step dt</label><input id="ode-dt" data-testid="ode-dt" type="number" step="any" value="0.01">
    </div>
    <div class="row"><button data-testid="ode-run" type="button">Run RK4</button></div>
    <div class="stats">
      <div class="stat"><span class="clabel">x</span><span class="sval" data-testid="ode-x">–</span></div>
      <div class="stat"><span class="clabel">y</span><span class="sval" data-testid="ode-y">–</span></div>
      <div class="stat"><span class="clabel">γ/δ</span><span class="sval" data-testid="ode-eq-x">–</span></div>
      <div class="stat"><span class="clabel">α/β</span><span class="sval" data-testid="ode-eq-y">–</span></div>
      <div class="stat"><span class="clabel">drift</span><span class="sval" data-testid="ode-drift">–</span></div>
    </div>
    <svg data-testid="ode-chart" viewBox="0 0 400 190" class="chart" role="img" aria-label="Lotka-Volterra trajectory chart">
      <line x1="40" y1="12" x2="40" y2="164" stroke="#33513e" stroke-width="1"></line>
      <line x1="40" y1="164" x2="392" y2="164" stroke="#33513e" stroke-width="1"></line>
      <text x="392" y="180" fill="#9fbfa9" font-size="11" text-anchor="end">time</text>
      <text x="6" y="18" fill="#9fbfa9" font-size="11">value</text>
      <polyline data-testid="ode-series-x" fill="none" stroke="#5fd18b" stroke-width="1.5" points=""></polyline>
      <polyline data-testid="ode-series-y" fill="none" stroke="#dc5014" stroke-width="1.5" points=""></polyline>
    </svg>

    <h2 style="margin-top:16px">Scenario</h2>
    <textarea data-testid="scenario-json" id="scenario-json" rows="4" spellcheck="false" aria-label="Scenario JSON"></textarea>
    <div class="row">
      <button data-testid="scenario-export" type="button">Export scenario</button>
      <button data-testid="scenario-load" type="button">Load scenario</button>
      <button data-testid="csv-export" type="button">Download CSV</button>
    </div>
    <div data-testid="scenario-error" class="error" role="alert"></div>

    <h2 style="margin-top:16px">Presets</h2>
    <div class="row">
      <input id="preset-name" data-testid="preset-name" type="text" placeholder="Preset name" aria-label="Preset name">
      <button data-testid="preset-save" type="button">Save preset</button>
    </div>
    <div data-testid="preset-list" id="preset-list" class="preset-list"></div>
  </section>
</main>

<script>
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* defaults + randomness                                              */
  /* ------------------------------------------------------------------ */
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

  /* ------------------------------------------------------------------ */
  /* state                                                              */
  /* ------------------------------------------------------------------ */
  let params = Object.assign({}, DEFAULTS);
  let rand = mulberry32(42);
  let currentSeed = 42;
  let curTick = 0;
  let idCounter = 1;
  let grass = [];
  let rabbitGrid = [];
  let foxGrid = [];
  let rabbits = [];
  let foxes = [];
  let hist = [];

  let playing = false;
  let speed = 10;
  let timer = null;
  let lastTime = 0;
  let acc = 0;

  const SLIDER_KEYS = ['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax'];

  const q = function (sel) { return document.querySelector(sel); };
  const byId = function (a, b) { return a.id - b.id; };

  const canvas = q('[data-testid="world"]');
  const ctx = canvas.getContext('2d');
  const chart = q('[data-testid="chart"]');
  const polyR = chart.querySelector('[data-testid="series-rabbits"]');
  const polyF = chart.querySelector('[data-testid="series-foxes"]');
  const odeChart = q('[data-testid="ode-chart"]');
  const odePolyX = odeChart.querySelector('[data-testid="ode-series-x"]');
  const odePolyY = odeChart.querySelector('[data-testid="ode-series-y"]');
  const seedInput = q('[data-testid="seed"]');
  const speedInput = q('[data-testid="speed"]');
  const speedOut = q('#speed-out');
  const announcer = q('[data-testid="announcer"]');
  const errorEl = q('[data-testid="scenario-error"]');
  const scenarioJson = q('[data-testid="scenario-json"]');
  const presetList = q('#preset-list');
  const presetName = q('[data-testid="preset-name"]');

  /* ------------------------------------------------------------------ */
  /* small helpers                                                      */
  /* ------------------------------------------------------------------ */
  function pick(list) {
    if (!list.length) return undefined;
    return list[Math.floor(rand() * list.length)];
  }

  function neighbors(x, y) {
    const w = params.width, h = params.height, out = [];
    if (y > 0) out.push([x, y - 1]);
    if (x < w - 1) out.push([x + 1, y]);
    if (y < h - 1) out.push([x, y + 1]);
    if (x > 0) out.push([x - 1, y]);
    return out;
  }

  function sumGrass() {
    let s = 0;
    for (let i = 0; i < grass.length; i++) s += grass[i];
    return s;
  }

  function counts()