
<think></think>
## Plan
The application uses a single-page layout with a side panel for controls and a main panel for the simulation. The data model stores the grid as a 2‑D array of cells, each containing grass level, a rabbit, and a fox. A global id counter assigns unique IDs to all animals. The reset function merges user‑provided parameters with defaults, creates the grid, populates it with rabbits and foxes, and records the initial history point. One tick updates grass growth, animal movement, feeding, breeding, and death according to the rules defined in the specification. The Lotka–Volterra panel is driven by the `ode` function, which integrates the differential equations using RK4. The UI is built with inline CSS and vanilla JavaScript; no external libraries are used. The `window.lab` API exposes methods for resetting, stepping, counting, and exporting data. Controls (sliders, buttons, counters) are native elements that interact with the simulation state. All components are listed in the plan.

## Code
```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Ecosystem Lab</title>
<style>
  body {font-family: Arial, sans-serif; margin:0; display:flex; height:100vh; overflow:hidden;}
  #panel-world {flex:1; overflow:hidden;}
  #panel-side {flex:1; display:flex; flex-direction:column; padding:10px;}
  canvas {background:#f0f0f0; cursor:none;}
  .controls {background:#fff; padding:10px; border-right:1px solid #ccc; display:flex; flex-direction:column; gap:5px;}
  button, input {padding:4px 8px; margin:0;}
  #announcer {font-size:0.9em; height:1.2em; text-align:center; margin-top:5px;}
  #chart {width:100%; height:200px;}
  #scenario-json {width:100%; height:60px; margin-bottom:10px;}
</style>
</head>
<body>
<div id="panel-world">
  <canvas id="world"></canvas>
  <div class="controls">
    <label>seed<input type="number" id="seed" value="42"></label>
    <label>speed<input type="range" id="speed" min="1" max="60" value="10"></label>
    <label>param-rabbits0<span>0–300</span></label>
    <label>param-foxes0<span>0–60</span></label>
    <label>param-rabbitBreed<span>2–40</span></label>
    <label>param-foxBreed<span>2–60</span></label>
    <label>param-foxGain<span>1–30</span></label>
    <label>param-grassMax<span>1–10</span></label>
  </div>
  <div id="count-rabbits">0</div>
  <div id="count-foxes">0</div>
  <div id="count-grass">0</div>
  <button data-testid="play">Play</button>
  <button data-testid="pause">Pause</button>
  <button data-testid="step">Step</button>
  <button data-testid="reset">Reset</button>
  <button data-testid="preset-save">Save preset</button>
  <button data-testid="preset-load">Load preset</button>
  <button data-testid="scenario-export">Export CSV</button>
  <textarea id="scenario-json" rows="4" cols="50"></textarea>
  <button id="scenario-error" style="display:none; margin-top:10px;">Error</button>
</div>
<div id="panel-side">
  <h2>Population Chart</h2>
  <svg id="chart" width="100%" height="100%"></svg>
  <h2>Lotka–Volterra</h2>
  <svg id="ode-chart" width="100%" height="100%"></svg>
</div>
<div id="announcer" aria-live="polite">Tick 0: 0 rabbits, 0 foxes</div>
<script>
function mulberry32(seed){
  let a = seed|0;
  return function(){
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand, tick = 0, id = 1, history = [];
function reset(seed, params){
  rand = mulberry32(seed);
  tick = 0;
  id = 1;
  history = [];
  // defaults
  const defaults = {
    width:40, height:30, grassMax:4,
    rabbits0:100, foxes0:6, rabbitStart:100,
    rabbitGain:1, rabbitCost:1, rabbitBreed:12,
    foxStart:12, foxGain:4, foxCost:2, foxBreed:40
  };
  // merge params
  params = {width:width||defaults.width, height:height||defaults.height,
            grassMax:grassMax||defaults.grassMax,
            rabbits0:rabbits0||defaults.rabbits0,
            foxes0:foxes0||defaults.foxes0,
            rabbitStart:rabbitStart||defaults.rabbitStart,
            rabbitGain:rabbitGain||defaults.rabbitGain,
            rabbitCost:foxCost||defaults.rabbitCost,
            foxBreed:foxBreed||defaults.foxBreed,
            foxGain:foxGain||defaults.foxGain
  };
  // grass
  for(let y=0;y<defaults.height;y++){
    for(let x=0;x<defaults.width;x++){
      cells[y][x].grass = Math.floor(rand() * (defaults.grassMax+1));
    }
  }
  // rabbits
  let rabbits = [];
  for(let i=0;i<defaults.rabbits0;i++){
    let cellsWithNoRabbit = [];
    for(let y=0;y<defaults.height;y++) for(let x=0;x<defaults.width;x++) if(!cells[y][x].rabbit){
      cellsWithNoRabbit.push({x,y});
    }
    let r = pick(cellsWithNoRabbit);
    if(r){
      rabbits.push({id:id++, energy:r, pos:{x,y}});
    }
  }
  // foxes
  let foxes = [];
  for(let i=0;i<defaults.foxes0;i++){
    let cellsWithNoFox = [];
    for(let y=0;y<defaults.height;y++) for(let x=0;x<defaults.width;x++) if(!cells[y][x].fox){
      cellsWithNoFox.push({x,y});
    }
    let f = pick(cellsWithNoFox);
    if(f){
      foxes.push({id:id++, energy:f, pos:{x,y}});
    }
  }
  // history point
  history.push({tick,tick,rabbits.length,foxes.length,0});
  redraw();
}
function step(n=1){
  for(let i=0;i<n;i++) tick();
  redraw();
}
function count(){
  return {rabbits:history.length, foxes:history.length, grass:0};
}
function ode(p,t,dt){
  const alpha=1.1, beta=0.4, gamma=0.4, delta=0.1,
    x0=10, y0=10, dt=50;
  let x=x0,y=y0;
  const steps=Math.round(t/dt);
  for(let s=0;s<steps; s++){
    const k1x=delta*x - gamma*y;
    const k1y=beta*x - gamma*Math.log(y);
    const k2x=delta*x + x - gamma*Math.log(y + 1e-12),
          k2y=beta*x + y - gamma*Math.log(y + 1e-12);
    const k3x=delta*x + x - gamma*Math.log(y + 1e-12),
          k3y=beta*x + y - gamma*Math.log(y + 1e-12);
    const k4x=delta*x + x - gamma*Math.log(y + 1e-12),
          k4y=beta*x + y - gamma*Math.log(y + 1e-12);
    x+=dt/6*(k1x+k3x);
    y+=dt/6*(k2y+k4y);
    x=Math.max(0, Math.min(defaults.height-1, x));
    y=Math.max(0, Math.min(defaults.width-1, y));
  }
  return {x,y};
}
function exportCSV(){
  let out = [\"tick,rabbits,foxes,grass\"];
  history.forEach(h=>out.push(`${h.tick},${h.rabbits},${h.foxes},${h.grass}`));
  const txt = out.join('\n');
  const a = document.getElementById('scenario-json');
  a.value = txt;
  return txt;
}
function exportScenario(){
  try{
    const json = JSON.parse(document.getElementById('scenario-json').value);
    if(json.version!==1||!Number.isInteger(json.seed)) throw null;
    reset(json.seed, json.params);
    return true;
  }catch(){
    document.getElementById('scenario-error').textContent='Invalid scenario';
    return false;
  }
}
function pick(list){
  if(!list.length) return null;
  return list[Math.floor(rand() * list.length)];
}
function redraw(){
  const canvas = document.getElementById('world');
  const ctx = canvas.getContext('2d');
  const cells = Array.from({length:defaults.height}).fill({grass:0});
  for(let y=0;y<defaults.height;y++) for(let x=0;x<defaults.width;x++){
    const cell = cells[y][x];
    ctx.fillStyle = `rgb(30, ${60 + Math.round(160*cell.grass/defaults.grassMax)}, 30)`;
    ctx.fillRect(x*10, y*10, 10, 10);
  }
  // rabbits
  for(let a of history){
    ctx.fillStyle = `rgb(240,240,240)`;
    ctx.fillRect(a.rabbit.id-1, a.rabbit.pos.y*10, 4,4);
  }
  // foxes
  for(let a of history){
    ctx.fillStyle = `rgb(220,80,20)`;
    ctx.fillRect(a.fox.id-1, a.fox.pos.y*10, 4,4);
  }
}
function tick(){
  // grass
  for(let y=0;y<defaults.height;y++) for(let x=0;x<defaults.width;x++){
    cells[y][x].grass = Math.min(defaults.grassMax, cells[y][x].grass + 1);
  }
  // rabbits
  let rabbitsAlive = [...history].filter(a=>a.rabbit).slice().sort((a,b)=>a.id-b.id);
  rabbitsAlive.forEach(r=>{
    let nb = [];
    for(let y=0;y<defaults.height;y++) for(let x=0;x<defaults.width;x++) if(!cells[y][x].rabbit){
      nb.push({x,y});
    }
    let r = pick(nb);
    if(r){
      let nb2 = [...history].filter(a=>a.rabbit).slice().sort((a,b)=>a.id-b.id);
      let nbBreed = Math.floor(r.energy/2);
      let parent = pick(nbBreed ? nbBreed : nb);
      if(parent){
        parent.energy -= nbBreed;
        let child = Math.floor(r.energy/2);
        // place child
        let placed = false;
        for(let y=0;y<defaults.height;y++) for(let x=0;x<defaults.width;x++){
          if(!cells[y][x].rabbit && !cells[y][x].fox){
            ctx.fillStyle = `rgb(240,240,240)`;
            ctx.fillRect(x*10, y*10, 4,4);
            placed = true;
            break;
          }
        }
        if(!placed){
          // fallback to nearest empty cell
          for(let y=0;y<defaults.height;y++) for(let x=0;x<defaults.width;x++){
            if(!cells[y][x].rabbit){
              ctx.fillStyle = `rgb(240,240,240)`;
              ctx.fillRect(x*10, y*10, 4,4);
              break;
            }
          }
        }
      }
    }
    r.energy += r.rabbitGain * r.grass;
    r.grass = 0;
    r.energy -= r.rabbitCost;
    if(r.energy <= 0) delete history[history.length-1];
  });
  // foxes
  let foxesAlive = [...history].filter(a=>a.fox).slice().sort((a,b)=>a.id-b.id);
  foxesAlive.forEach(f=>{
    let nb = [];
    for(let y=0;y<defaults.height;y++) for(let x=0;x<defaults.width;x++) if(!cells[y][x].fox){
      nb.push({x,y});
    }
    let f = pick(nb);
    if(f){
      let nbBreed = Math.floor(f.energy/2);
      let parent = pick(nbBreed ? nbBreed : nb);
      if(parent){
        parent.energy -= nbBreed;
        let child = Math.floor(f.energy/2);
        let placed = false;
        for(let y=0;y<defaults.height;y++) for(let x=0;x<defaults.width;x++){
          if(!cells[y][x].fox && !cells[y][x].rabbit){
            ctx.fillStyle = `rgb(220,80,20)`;
            ctx.fillRect(x*10, y*10, 4,4);
            placed = true;
            break;
          }
        }
        if(!placed){
          for(let y=0;y<defaults.height;y++) for(let x=0;x<defaults.width;x++){
            if(!cells[y][x].fox && !cells[y][x].rabbit){
              ctx.fillStyle = `rgb(220,80,20)`;
              ctx.fillRect(x*10, y*10, 4,4);
              break;
            }
          }
        }
      }
    }
    f.energy += f.foxGain * f.grass;
    f.grass = 0;
    f.energy -= f.foxCost;
    if(f.energy <= 0) delete history[history.length-1];
  });
  tick++;
  history.push({tick,tick,rabbits.length,foxes.length,0});
  counts();
}
function counts(){
  return history;
}
function history(){
  return history;
}
function tickStep(){
  if(lab.pause){
    return;
  }
  if(lab.play){
    step();
    return;
  }
  if(lab.step){
    step(1);
    return;
  }
}
document.getElementById('play').addEventListener('click',()=>{lab.pause=lab.play=!lab.pause;});
document.getElementById('pause').addEventListener('click',()=>{lab.pause=!lab.pause;});
document.getElementById('step').addEventListener('click',()=>{step();});
document.getElementById('reset').addEventListener('click',()=>{reset(Number(document.getElementById('seed').value), params);});
document.getElementById('preset-save').addEventListener('click',()=>{const name = document.getElementById('preset-name').value; if(name) saveScenario(name);});
document.getElementById('preset-load').addEventListener('click',()=>{const name = document.getElementById('preset-name').value; if(name) loadScenario(name);});
document.getElementById('scenario-export').addEventListener('click',()=>{exportCSV();});
document.getElementById('scenario-error').addEventListener('click',()=>{document.getElementById('scenario-error').textContent='';});
function saveScenario(name){
  const presets = JSON.parse(localStorage.getItem('ecolab.presets')||'{}');
  presets[name] = {seed:Number(document.getElementById('seed').value)||0, params};
  localStorage.setItem('ecolab.presets', JSON.stringify(presets));
}
function loadScenario(name){
  const presets = JSON.parse(document.getElementById('scenario-json').value);
  if(!presets[name]) return false;
  reset(presets[name].seed, presets[name].params);
  return true;
}
window.lab = {
  reset:reset,
  step:step,
  counts:{counts},
  tick:{tick},
  cell:{cell},
  history:{history},
  ode:{ode},
  exportCSV:exportCSV,
  exportScenario:exportScenario,
  loadScenario:loadScenario,
  preset:null
};
</script>
</body>
</html>
```