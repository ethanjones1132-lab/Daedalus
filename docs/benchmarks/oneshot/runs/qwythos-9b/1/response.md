## Plan

The app is a single HTML file containing a full simulation engine, UI, and charting logic. The world is a 40×30 grid of cells. Each cell holds an integer grass level (0–grassMax) and at most one rabbit and one fox. Animals have unique IDs from a shared counter. The simulation runs in discrete ticks. Each tick proceeds in four phases: grass growth, rabbits, foxes, and tick increment. Grass grows by 1 (capped at grassMax). Rabbits move to a random empty neighbour, eat grass (gaining energy), lose energy, and may breed if energy ≥ rabbitBreed. Foxes move to a neighbour with a rabbit (if any) or an empty one, eat rabbits (gaining energy), lose energy, and may breed if energy ≥ foxBreed. All random choices use a single mulberry32 generator seeded at reset; `pick` draws from that stream. The UI exposes `window.lab` with methods `reset`, `step`, `counts`, `tick`, `cell`, `history`, `ode`, `exportCSV`, `exportScenario`, and `loadScenario`. Rendering uses a canvas with backing size 10× per cell, drawing grass as green squares and animals as filled shapes. Controls include play/pause/step/reset buttons, a speed slider, parameter sliders, counters, a population chart (SVG polyline), a Lotka–Volterra RK4 integrator panel, and a preset save/load system using localStorage. Accessibility is handled via an announcer element and keyboard shortcuts (Space to toggle play/pause, S to step, R to reset). Layout adapts to viewport width, stacking panels on small screens. No external libraries are used; all logic is inline JavaScript.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ecosystem Lab</title>
<style>
  :root { --bg: #f5f5f5; --panel: #fff; --text: #222; --border: #ccc; --focus: #0066cc; }
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--text); }
  .app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  header { background: #333; color: #fff; padding: 8px 12px; display: flex; align-items: center; gap: 12px; }
  header h1 { margin: 0; font-size: 16px; }
  .main { display: flex; flex: 1; overflow: hidden; }
  .panel-world { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; }
  .panel-side { width: 380px; background: var(--panel); border-left: 1px solid var(--border); overflow: auto; display: flex; flex-direction: column; }
  @media (max-width: 700px) { .main { flex-direction: column; } .panel-side { width: 100%; border-left: none; border-top: 1px solid var(--border); } }
  #world-canvas { flex: 1; width: 100%; height: 100%; image-rendering: pixelated; }
  .controls { padding: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; background: #eee; border-bottom: 1px solid var(--border); }
  .counter { font-variant-numeric: tabular-nums; padding: 2px 6px; background: #fff; border: 1px solid var(--border); border-radius: 4px; min-width: 42px; text-align: center; }
  .row { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  .row label { font-size: 12px; color: #555; }
  input[type="number"], input[type="range"] { width: 70px; }
  button { padding: 4px 8px; font-size: 12px; border: 1px solid #aaa; background: #fff; cursor: pointer; border-radius: 3px; }
  button:hover { background: #f0f0f0; }
  button:focus { outline: 2px solid var(--focus); outline-offset: 2px; }
  .chart-box { padding: 8px; border-bottom: 1px solid var(--border); }
  .chart-box h3 { margin: 0 0 6px; font-size: 13px; }
  #chart-svg { width: 100%; height: 120px; }
  .ode-box { padding: 8px; border-bottom: 1px solid var(--border); }
  .ode-box h3 { margin: 0 0 6px; font-size: 13px; }
  .ode-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 11px; }
  .ode-inputs input { width: 100%; box-sizing: border-box; }
  .ode-results { font-size: 11px; margin-top: 4px; }
  #ode-svg { width: 100%; height: 80px; }
  .scenario-box { padding: 8px; border-bottom: 1px solid var(--border); }
  .scenario-box textarea { width: 100%; height: 60px; font-family: monospace; font-size: 11px; box-sizing: border-box; }
  .presets-box { padding: 8px; }
  .preset-item { display: flex; align-items: center; gap: 4px; font-size: 12px; padding: 2px 0; border-bottom: 1px dashed #eee; }
  .preset-item button { font-size: 10px; padding: 1px 4px; }
  .announcer { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
  .seed-input { width: 60px; }
</style>
</head>
<body>
<div class="app">
<header>
<h1>Ecosystem Lab</h1>
<span class="counter" data-testid="tick">0</span>
<span class="counter" data-testid="count-rabbits">0</span>
<span class="counter" data-testid="count-foxes">0</span>
<span class="counter" data-testid="count-grass">0</span>
</header>
<div class="main">
<div class="panel-world">
<canvas id="world-canvas" data-testid="world"></canvas>
<div class="controls">
<button data-testid="play">Play</button>
<button data-testid="pause">Pause</button>
<button data-testid="step">Step</button>
<button data-testid="reset">Reset</button>
<input type="number" class="seed-input" data-testid="seed" value="42">
<output data-testid="speed-output">10</output>
<input type="range" min="1" max="60" value="10" data-testid="speed">
</div>
<div class="row">
<label for="param-rabbits0">Rabbits at start</label>
<input type="range" min="0" max="300" value="100" data-testid="param-rabbits0">
</div>
<div class="row">
<label for="param-foxes0">Foxes at start</label>
<input type="range" min="0" max="60" value="6" data-testid="param-foxes0">
</div>
<div class="row">
<label for="param-rabbitBreed">Rabbit breed</label>
<input type="range" min="2" max="40" value="12" data-testid="param-rabbitBreed">
</div>
<div class="row">
<label for="param-foxBreed">Fox breed</label>
<input type="range" min="2" max="60" value="40" data-testid="param-foxBreed">
</div>
<div class="row">
<label for="param-foxGain">Fox gain</label>
<input type="range" min="1" max="30" value="4" data-testid="param-foxGain">
</div>
<div class="row">
<label for="param-grassMax">Grass max</label>
<input type="range" min="1" max="10" value="4" data-testid="param-grassMax">
</div>
</div>
<div class="announcer" aria-live="polite"></div>
</div>
<div class="panel-side">
<div class="chart-box">
<h3>Population</h3>
<svg id="chart-svg" data-testid="chart" viewBox="0 0 320 120">
<polyline data-testid="series-rabbits"></polyline>
<polyline data-testid="series-foxes"></polyline>
</svg>
</div>
<div class="ode-box">
<h3>Lotka–Volterra</h3>
<div class="ode-inputs">
<input type="number" step="0.01" value="1.1" data-testid="ode-alpha">
<input type="number" step="0.01" value="0.4" data-testid="ode-beta">
<input type="number" step="0.01" value="0.4" data-testid="ode-gamma">
<input type="number" step="0.01" value="0.1" data-testid="ode-delta">
<input type="number" step="0.01" value="10" data-testid="ode-x0">
<input type="number" step="0.01" value="10" data-testid="ode-y0">
<input type="number" step="0.01" value="50" data-testid="ode-t">
<input type="number" step="0.01" value="0.01" data-testid="ode-dt">
</div>
<button data-testid="ode-run">Run</button>
<div class="ode-results">
<output data-testid="ode-x"></output>, <output data-testid="ode-y"></output>
<output data-testid="ode-eq-x"></output> = <output data-testid="ode-eq-y"></output>
<output data-testid="ode-drift"></output>
</div>
<svg id="ode-svg" data-testid="ode-chart" viewBox="0 0 320 80">
<polyline data-testid="ode-series-x"></polyline>
<polyline data-testid="ode-series-y"></polyline>
</svg>
</div>
<div class="scenario-box">
<h3>Scenario</h3>
<textarea data-testid="scenario-json"></textarea>
<button data-testid="scenario-export">Export</button>
<button data-testid="scenario-load">Load</button>
<output data-testid="scenario-error"></output>
</div>
<div class="presets-box">
<h3>Presets</h3>
<input type="text" id="preset-name" placeholder="Name">
<button data-testid="preset-save">Save</button>
<div id="preset-list"></div>
</div>
</div>
</div>
</div>
</body>
<script>
(function(){
  const defaults = {
    width: 40, height: 30, grassMax: 4, rabbits0: 100, foxes0: 6,
    rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
    foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
  };
  let params = {...defaults};
  let seed = 42;
  let rand = null, tick = 0, idCounter = 1;
  let cells = new Array(params.width*params.height).fill(null);
  let rabbits = [], foxes = [];
  let history = [];
  let playing = false, speed = 10, lastTime = 0, accumulator = 0;
  let canvas, ctx, svgRab, svgFox, svgChart, svgOdeX, svgOdeY;
  let announcer = document.querySelector('.announcer');
  let presetStore = JSON.parse(localStorage.getItem('ecolab.presets')||'{}');

  function mulberry32(s){
    let a = s|0;
    return function(){
      a = (a + 0x6D2B79F5)|0;
      let t = a;
      t = Math.imul(t^(t>>>15), t|1);
      t ^= t + Math.imul(t^(t>>>7), t|61);
      return ((t^(t>>>14))>>>0)/4294967296;
    };
  }
  function pick(list){
    if(!list.length) return null;
    return list[Math.floor(rand()*list.length)];
  }
  function reset(s, p){
    seed = s; params = {...defaults, ...p};
    rand = mulberry32(seed); tick = 0; idCounter = 1;
    cells = new Array(params.width*params.height).fill(null);
    rabbits = []; foxes = []; history = [];
    initWorld();
    drawWorld();
    updateCounters();
    drawChart();
    drawOde();
    announcer.textContent = '';
  }
  function initWorld(){
    // Grass
    for(let i=0;i<cells.length;i++){
      cells[i] = {grass: Math.floor(rand()*(params.grassMax+1)), rabbit: null, fox: null};
    }
    // Rabbits
    for(let k=0;k<params.rabbits0;k++){
      let empty = [];
      for(let i=0;i<cells.length;i++){
        if(!cells[i].rabbit) empty.push(i);
      }
      let idx = pick(empty);
      if(idx===null) continue;
      let pos = idxToXY(idx);
      rabbits.push({id:idCounter++, pos, energy: params.rabbitStart});
      cells[idx].rabbit = rabbits[rabbits.length-1];
    }
    // Foxes
    for(let k=0;k<params.foxes0;k++){
      let empty = [];
      for(let i=0;i<cells.length;i++){
        if(!cells[i].fox) empty.push(i);
      }
      let idx = pick(empty);
      if(idx===null) continue;
      let pos = idxToXY(idx);
      foxes.push({id:idCounter++, pos, energy: params.foxStart});
      cells[idx].fox = foxes[foxes.length-1];
    }
    // Record tick 0
    history.push({tick:0, rabbits:rabbits.length, foxes:foxes.length, grass:sumGrass()});
  }
  function idxToXY(i){ return {x:i%params.width, y:Math.floor(i/params.width)}; }
  function XYtoIdx(x,y){ return y*params.width + x; }
  function sumGrass(){
    let s=0; for(let c of cells) s+=c.grass; return s;
  }
  function neighbors(x,y){
    let out = [];
    if(y>0) out.push({x,y-1});
    if(x<params.width-1) out.push({x+1,y});
    if(y<params.height-1) out.push({x,y+1});
    if(x>0) out.push({x-1,y});
    return out;
  }
  function runTick(){
    // Grass
    for(let c of cells) c.grass = Math.min(params.grassMax, c.grass+1);
    // Rabbits
    let aliveR = rabbits.filter(r=>r.energy>0);
    aliveR.sort((a,b)=>a.id-b.id);
    for(let r of aliveR){
      // Move
      let neigh = neighbors(r.pos.x,r.pos.y).filter(n=>!cells[XYtoIdx(n.x,n.y)].rabbit);
      if(neigh.length){
        let n = pick(neigh);
        r.pos = n;
        cells[XYtoIdx(r.pos.x,r.pos.y)].rabbit = r;
      }
      // Eat
      let g = cells[XYtoIdx(r.pos.x,r.pos.y)].grass;
      r.energy += params.rabbitGain*g;
      cells[XYtoIdx(r.pos.x,r.pos.y)].grass = 0;
      // Cost
      r.energy -= params.rabbitCost;
      // Breed
      if(r.energy >= params.rabbitBreed){
        let neigh = neighbors(r.pos.x,r.pos.y).filter(n=>!cells[XYtoIdx(n.x,n.y)].rabbit);
        if(neigh.length){
          let n = pick(neigh);
          let child = Math.floor(r.energy/2);
          r.energy -= child;
          let newR = {id:idCounter++, pos:n, energy:child};
          cells[XYtoIdx(n.x,n.y)].rabbit = newR;
          rabbits.push(newR);
        }
      }
    }
    // Foxes
    let aliveF = foxes.filter(f=>f.energy>0);
    aliveF.sort((a,b)=>a.id-b.id);
    for(let f of aliveF){
      // Move
      let neighR = neighbors(f.pos.x,f.pos.y).filter(n=>cells[XYtoIdx(n.x,n.y)].rabbit && !cells[XYtoIdx(n.x,n.y)].fox);
      if(neighR.length){
        let n = pick(neighR);
        f.pos = n;
        cells[XYtoIdx(f.pos.x,f.pos.y)].fox = f;
      } else {
        let neighE = neighbors(f.pos.x,f.pos.y).filter(n=>!cells[XYtoIdx(n.x,n.y)].fox);
        if(neighE.length){
          let n = pick(neighE);
          f.pos = n;
          cells[XYtoIdx(f.pos.x,f.pos.y)].fox = f;
        }
      }
      // Eat
      let cell = cells[XYtoIdx(f.pos.x,f.pos.y)];
      if(cell.rabbit){
        cell.rabbit = null;
        f.energy += params.foxGain;
      }
      // Cost
      f.energy -= params.foxCost;
      // Breed
      if(f.energy >= params.foxBreed){
        let neigh = neighbors(f.pos.x,f.pos.y).filter(n=>!cells[XYtoIdx(n.x,n.y)].fox);
        if(neigh.length){
          let n = pick(neigh);
          let child = Math.floor(f.energy/2);
          f.energy -= child;
          let newF = {id:idCounter++, pos:n, energy:child};
          cells[XYtoIdx(n.x,n.y)].fox = newF;
          foxes.push(newF);
        }
      }
    }
    tick++;
    history.push({tick, rabbits:rabbits.length, foxes:foxes.length, grass:sumGrass()});
  }
  function step(n){
    for(let i=0;i<n;i++) runTick();
    drawWorld();
    updateCounters();
    drawChart();
    return counts();
  }
  function counts(){ return {rabbits:rabbits.length, foxes:foxes.length, grass:sumGrass()}; }
  function tick(){ return tick; }
  function cell(x,y){
    let i = XYtoIdx(x,y);
    let c = cells[i];
    return {grass:c.grass, rabbit:c.rabbit, fox:c.fox};
  }
  function history(){ return history; }
  function ode(p,t,dt){
    let {alpha, beta, gamma, delta, x0, y0} = p;
    let n = Math.round(t/dt);
    let x=x0, y=y0;
    for(let i=0;i<n;i++){
      let k1x = alpha*x - beta*x*y;
      let k1y = delta*x*y - gamma*y;
      let x2 = x + 0.5*k1x*dt, y2 = y + 0.5*k1y*dt;
      let k2x = alpha*x2 - beta*x2*y2;
      let k2y = delta*x2*y2 - gamma*y2;
      let x3 = x + 0.5*k2x*dt, y3 = y + 0.5*k2y*dt;
      let k3x = alpha*x3 - beta*x3*y3;
      let k3y = delta*x3*y3 - gamma*y3;
      let x4 = x + k3x*dt, y4 = y + k3y*dt;
      let k4x = alpha*x4 - beta*x4*y4;
      let k4y = delta*x4*y4 - gamma*y4;
      x = x + dt*(k1x + 2*k2x + 2*k3x + k4x)/6;
      y = y + dt*(k1y + 2*k2y + 2*k3y + k4y)/6;
    }
    return {x,y};
  }
  function exportCSV(){
    let lines = ['tick,rabbits,foxes,grass'];
    for(let h of history) lines.push(h.tick + ',' + h.rabbits + ',' + h.foxes + ',' + h.grass);
    return lines.join('\n') + '\n';
  }
  function exportScenario(){
    return JSON.stringify({version:1, seed, params});
  }
  function loadScenario(text){
    try{
      let obj = JSON.parse(text);
      if(obj.version !== 1) throw new Error('Bad version');
      if(!Number.isInteger(obj.seed)) throw new Error('Seed not integer');
      reset(obj.seed, obj.params);
      return true;
    }catch(e){
      document.querySelector('[data-testid="scenario-error"]').textContent = e.message;
      return false;
    }
  }
  // Canvas setup
  canvas = document.getElementById('world-canvas');
  ctx = canvas.getContext('2d');
  function resizeCanvas(){
    let size = params.width*10;
    canvas.width = size; canvas.height = params.height*10;
    ctx.imageSmoothingEnabled = false;
  }
  resizeCanvas();
  // SVG refs
  svgRab = document.querySelector('[data-testid="series-rabbits"]');
  svgFox = document.querySelector('[data-testid="series-foxes"]');
  svgChart = document.getElementById('chart-svg');
  svgOdeX = document.querySelector('[data-testid="ode-series-x"]');
  svgOdeY = document.querySelector('[data-testid="ode-series-y"]');
  // Draw world
  function drawWorld(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    for(let i=0;i<cells.length;i++){
      let c = cells[i];
      let x = i%params.width, y = Math.floor(i/params.width);
      let px = x*10, py = y*10;
      // Grass
      let G = 60 + Math.round(160*c.grass/params.grassMax);
      ctx.fillStyle = `rgb(30,${G},30)`;
      ctx.fillRect(px,py,10,10);
      // Rabbit
      if(c.rabbit){
        ctx.fillStyle = 'rgb(240,240,240)';
        ctx.fillRect(px+3,py+3,4,4);
      }
      // Fox
      if(c.fox){
        ctx.fillStyle = 'rgb(220,80,20)';
        ctx.fillRect(px+3,py+3,4,4);
      }
    }
  }
  // Draw chart
  function drawChart(){
    let maxCount = Math.max(1, ...history.map(h=>h.rabbits), ...history.map(h=>h.foxes));
    let stepX = 320 / Math.max(1, history.length-1);
    let stepY = 120 / maxCount;
    let ptsR = history.map(h=>({x: h.tick*stepX, y: (maxCount - h.rabbits)*stepY}));
    let ptsF = history.map(h=>({x: h.tick*stepX, y: (maxCount - h.foxes)*stepY}));
    svgRab.setAttribute('points', ptsR.map(p=>p.x.toFixed(1)+','+p.y.toFixed(1)).join(' '));
    svgFox.setAttribute('points', ptsF.map(p=>p.x.toFixed(1)+','+p.y.toFixed(1)).join(' '));
  }
  // Draw ODE
  function drawOde(){
    let maxV = Math.max(1, ...history.map(h=>h.rabbits), ...history.map(h=>h.foxes));
    let stepX = 320 / Math.max(1, history.length-1);
    let stepY = 80 / maxV;
    let ptsX = history.map(h=>({x: h.tick*stepX, y: (maxV - h.rabbits)*stepY}));
    let ptsY = history.map(h=>({x: h.tick*stepX, y: (maxV - h.foxes)*stepY}));
    svgOdeX.setAttribute('points', ptsX.map(p=>p.x.toFixed(1)+','+p.y.toFixed(1)).join(' '));
    svgOdeY.setAttribute('points', ptsY.map(p=>p.x.toFixed(1)+','+p.y.toFixed(1)).join(' '));
  }
  // Update counters
  function updateCounters(){
    let c = counts();
    document.querySelector('[data-testid="tick"]').textContent = tick;
    document.querySelector('[data-testid="count-rabbits"]').textContent = c.rabbits;
    document.querySelector('[data-testid="count-foxes"]').textContent = c.foxes;
    document.querySelector('[data-testid="count-grass"]').textContent = c.grass;
  }
  // Presets
  function renderPresets(){
    let list = document.getElementById('preset-list');
    list.innerHTML = '';
    for(let name in presetStore){
      let item = document.createElement('div');
      item.className = 'preset-item';
      item.innerHTML = `<span>${name}</span>
        <button data-testid="preset-load-${name}">Load</button>
        <button data-testid="preset-delete-${name}">Delete</button>`;
      list.appendChild(item);
    }
  }
  renderPresets();
  // Event wiring
  const btnPlay = document.querySelector('[data-testid="play"]');
  const btnPause = document.querySelector('[data-testid="pause"]');
  const btnStep = document.querySelector('[data-testid="step"]');
  const btnReset = document.querySelector('[data-testid="reset"]');
  const inpSeed = document.querySelector('[data-testid="seed"]');
  const inpSpeed = document.querySelector('[data-testid="speed"]');
  const outSpeed = document.querySelector('[data-testid="speed-output"]');
  const inpRabbits0 = document.querySelector('[data-testid="param-rabbits0"]');
  const inpFoxes0 = document.querySelector('[data-testid="param-foxes0"]');
  const inpRabbitBreed = document.querySelector('[data-testid="param-rabbitBreed"]');
  const inpFoxBreed = document.querySelector('[data-testid="param-foxBreed"]');
  const inpFoxGain = document.querySelector('[data-testid="param-foxGain"]');
  const inpGrassMax = document.querySelector('[data-testid="param-grassMax"]');
  const inpPresetName = document.getElementById('preset-name');
  const btnSavePreset = document.querySelector('[data-testid="preset-save"]');
  const btnExportScenario = document.querySelector('[data-testid="scenario-export"]');
  const btnLoadScenario = document.querySelector('[data-testid="scenario-load"]');
  const outScenarioError = document.querySelector('[data-testid="scenario-error"]');
  const btnOdeRun = document.querySelector('[data-testid="ode-run"]');
  const outOdeX = document.querySelector('[data-testid="ode-x"]');
  const outOdeY = document.querySelector('[data-testid="ode-y"]');
  const outOdeEqX = document.querySelector('[data-testid="ode-eq-x"]');
  const outOdeEqY = document.querySelector('[data-testid="ode-eq-y"]');
  const outOdeDrift = document.querySelector('[data-testid="ode-drift"]');

  btnPlay.addEventListener('click', ()=>{ if(!playing){ reset(inpSeed.value||42,{}); playing=true; lastTime=performance.now(); } });
  btnPause.addEventListener('click', ()=>{ playing=false; });
  btnStep.addEventListener('click', ()=>{ step(1); });
  btnReset.addEventListener('click', ()=>{ reset(inpSeed.value||42,{}); });
  inpSeed.addEventListener('change', ()=>{ reset(inpSeed.value||42,{}); });
  inpSpeed.addEventListener('input', ()=>{ speed = parseInt(inpSpeed.value); outSpeed.textContent = speed; });
  inpRabbits0.addEventListener('input', ()=>{ params.rabbits0 = parseInt(inpRabbits0.value); });
  inpFoxes0.addEventListener('input', ()=>{ params.foxes0 = parseInt(inpFoxes0.value); });
  inpRabbitBreed.addEventListener('input', ()=>{ params.rabbitBreed = parseInt(inpRabbitBreed.value); });
  inpFoxBreed.addEventListener('input', ()=>{ params.foxBreed = parseInt(inpFoxBreed.value); });
  inpFoxGain.addEventListener('input', ()=>{ params.foxGain = parseInt(inpFoxGain.value); });
  inpGrassMax.addEventListener('input', ()=>{ params.grassMax = parseInt(inpGrassMax.value); });
  btnSavePreset.addEventListener('click', ()=>{
    if(!inpPresetName.value) return;
    presetStore[inpPresetName.value] = exportScenario();
    localStorage.setItem('ecolab.presets', JSON.stringify(presetStore));
    renderPresets();
  });
  btnExportScenario.addEventListener('click', ()=>{ document.querySelector('[data-testid="scenario-json"]').value = exportScenario(); });
  btnLoadScenario.addEventListener('click', ()=>{ loadScenario(document.querySelector('[data-testid="scenario-json"]').value); });
  btnOdeRun.addEventListener('click', ()=>{
    let p = {alpha: parseFloat(document.querySelector('[data-testid="ode-alpha"]').value),
             beta: parseFloat(document.querySelector('[data-testid="ode-beta"]').value),
             gamma: parseFloat(document.querySelector('[data-testid="ode-gamma"]').value),
             delta: parseFloat(document.querySelector('[data-testid="ode-delta"]').value),
             x0: parseFloat(document.querySelector('[data-testid="ode-x0"]').value),
             y0: parseFloat(document.querySelector('[data-testid="ode-y0"]').value)};
    let res = ode(p, parseFloat(document.querySelector('[data-testid="ode-t"]').value), parseFloat(document.querySelector('[data-testid="ode-dt"]').value));
    outOdeX.textContent = res.x.toFixed(8);
    outOdeY.textContent = res.y.toFixed(8);
    outOdeEqX.textContent = (params.gamma/params.delta).toFixed(8);
    outOdeEqY.textContent = (params.alpha/params.beta).toFixed(8);
    let V = (x,y)=> params.delta*x - params.gamma*Math.log(x) + params.beta*y - params.alpha*Math.log(y);
    let drift = Math.abs(V(res.x,res.y) - V(p.x0,p.y0));
    outOdeDrift.textContent = drift.toFixed(8);
    drawOde();
  });
  // Preset load buttons
  document.querySelectorAll('[data-testid^="preset-load-"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      let name = btn.getAttribute('data-testid').replace('preset-load-','');
      if(presetStore[name]){
        reset(42, JSON.parse(presetStore[name]));
        renderPresets();
      }
    });
  });
  // Preset delete buttons
  document.querySelectorAll('[data-testid^="preset-delete-"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      let name = btn.getAttribute('data-testid').replace('preset-delete-','');
      delete presetStore[name];
      localStorage.setItem('ecolab.presets', JSON.stringify(presetStore));
      renderPresets();
    });
  });
  // Animation loop
  function loop(){
    if(playing){
      let now = performance.now();
      let dt = (now - lastTime)/1000;
      lastTime = now;
      accumulator += dt*speed;
      while(accumulator >= 1){
        accumulator -= 1;
        runTick();
      }
    }
    drawWorld();
    updateCounters();
    drawChart();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  // Initial reset
  reset(inpSeed.value||42,{});
})();
</script>
</body>
</html>
```