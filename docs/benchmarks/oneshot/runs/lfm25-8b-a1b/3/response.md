
<think></think>
## Plan
The application uses a single-page layout with two main regions: a world grid rendered on a `<canvas>` and a sidebar with controls, charts, and scenario management. The data model defines a `Cell` object (grass, rabbit, fox), an `Animal` base class, and a `Grid` container. The tick order follows the specification: grass increments first, then rabbits (sorted by ID), then foxes (sorted by ID). The `reset` function merges user-provided parameters over defaults using a custom `mulberry32` PRNG seeded with the given seed. The simulation updates state each tick, handling movement, feeding, breeding, and death according to the rules. Rendering draws cells with appropriate shapes and colors, updating the canvas and chart via an SVG `<polyline>` for each species. The `window.lab` API exposes methods for resetting, stepping, counting, and exporting data. Counters display live tick, rabbit, fox, and grass counts. The Lotka–Volterra panel computes and displays the ODE trajectory using RK4 integration. Preset management allows saving/loading scenarios via JSON stored in `localStorage`. Accessibility features include keyboard navigation, ARIA live announcements, and responsive layout constraints.

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
  canvas {background:#f0f0f0; display:block;}
  #panel-side {flex:1; overflow:auto; padding:10px;}
  .controls {background:#fff; border-bottom:1px solid #ccc; display:flex; flex-direction:column; height:300px; padding:10px;}
  button, input {margin:5px; padding:5px;}
  .counter {margin:10px; font-size:14px;}
  #announcer {height:1.2em; padding:5px; text-align:center; border:1px solid #ccc;}
  svg {border:1px solid #ccc;}
</style>
</head>
<body>
<div id="panel-world">
  <canvas id="world" data-testid="canvas"></canvas>
</div>
<div id="panel-side">
  <div class="controls">
    <label>seed<input type="number" id="seed" value="42"></label>
    <label>speed<input type="range" id="speed" min="1" max="60" value="10"></label>
    <label>param-rabbits0<input type="range" id="param-rabbits0" min="0" max="300" value="6"></label>
    <label>param-foxes0<input type="range" id="param-foxes0" min="0" max="60" value="12"></label>
    <label>param-rabbitBreed<input type="range" id="param-rabbitBreed" min="2" max="40" value="12"></label>
    <label>param-foxBreed<input type="range" id="param-foxBreed" min="2" max="60" value="40"></label>
    <label>param-foxGain<input type="range" id="param-foxGain" min="1" max="30" value="4"></label>
    <label>param-grassMax<input type="range" id="param-grassMax" min="1" max="10" value="4"></label>
  </div>
  <div class="counter">
    <span class="counter">tick: 0</span> <span class="counter">count-rabbits: 0</span> <span class="counter">count-foxes: 0</span> <span class="counter">count-grass: 0</span>
  </div>
  <button data-testid="play" onclick="playToggle()">play</button>
  <button data-testid="pause" onclick="pauseToggle()">pause</button>
  <button data-testid="step" onclick="stepToggle()">step</button>
  <button data-testid="reset" onclick="resetSeed()">reset</button>
  <button data-testid="preset-save" onclick="savePreset()">save preset</button>
  <button data-testid="preset-load" onclick="loadPreset()">load preset</button>
  <button data-testid="scenario-export" onclick="exportScenario()">export CSV</button>
  <button data-testid="scenario-load" onclick="loadScenario()">load scenario</button>
  <textarea id="scenario-json" rows="4" cols="50" placeholder="scenario JSON"></textarea>
</div>
<div id="chart" data-testid="chart"></div>
<div id="ode-chart" data-testid="ode-chart"></div>
<div id="announcer" aria-live="polite"></div>
</body>
</html>
<script>
(function(){
  const width = 40;
  const height = 30;
  const widthPx = width * 10;
  const heightPx = height * 10;
  const canvas = document.getElementById('world');
  const ctx = canvas.getContext('2d');
  const grid = [];
  let tick = 0;
  let rabbits = [];
  let foxes = [];
  let grassLevels = [];
  let idCounter = 1;
  let history = [];
  let running = false;
  let seed = 42;
  let params = {width:40, height:30, grassMax:4, rabbits0:100, foxes0:6, rabbitStart:6, rabbitGain:1, rabbitCost:1, rabbitBreed:12, foxStart:12, foxGain:4, foxCost:2, foxBreed:40};
  let rand = mulberry32(seed);
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
  function reset(seed, params){
    seed = seed || 42;
    params = params || {width:40, height:30, grassMax:4, rabbits0:100, foxes0:6, rabbitStart:6, rabbitGain:1, rabbitCost:1, rabbitBreed:12, foxStart:12, foxGain:4, foxCost:2, foxBreed:40};
    rand = mulberry32(seed);
    tick = 0;
    idCounter = 1;
    history = [];
    grid = [];
    canvas.height = widthPx;
    ctx.clearRect(0,0,widthPx,heightPx);
    rabbits = [];
    foxes = [];
    grassLevels = [];
    document.getElementById('seed').value = seed;
    document.getElementById('param-rabbits0').value = params.rabbits0;
    document.getElementById('param-foxes0').value = params.foxes0;
    document.getElementById('param-rabbitBreed').value = params.rabbitBreed;
    document.getElementById('param-foxBreed').value = params.foxBreed;
    document.getElementById('param-grassMax').value = params.grassMax;
    document.getElementById('param-foxGain').value = params.foxGain;
    document.getElementById('param-rabbitCost').value = params.rabbitCost;
    document.getElementById('param-foxCost').value = params.foxCost;
    drawGrid();
    resetHistory();
    document.getElementById('tick').textContent = `Tick ${tick}`;
    document.getElementById('count-rabbits').textContent = rabbits.length;
    document.getElementById('count-foxes').textContent = foxes.length;
    document.getElementById('count-grass').textContent = grassLevels.reduce((a,b)=>a+b,0);
  }
  function drawGrid(){
    grid = [];
    for(y=0;y<height;y++){
      for(x=0;x<width;x++){
        let g = Math.floor(rand() * (params.grassMax+1));
        grid.push({x,y,g,rabbit:null,fox:null,id:idCounter++});
      }
    }
  }
  function resetHistory(){
    history = [];
    rabbits = [];
    foxes = [];
    grassLevels = [];
    for(cell of grid){history.push({tick,tick,rabbits:[];foxes:[]});}
  }
  function step(n){
    if(running) return;
    running = true;
    for(cell of grid){
      cell.grass = Math.min(params.grassMax, cell.grass + 1);
    }
    const sortedRabbits = [...rabbits].sort((a,b)=>a.id-b.b.id);
    const sortedFoxes = [...foxes].sort((a,b)=>a.id-b.id);
    const rabbitsToProcess = [...rabbits];
    rabbits = [];
    for(let r of sortedRabbits){
      let moved = false;
      for(let nb of neighbors(r)){
        if(nb.rabbit) continue;
        let spot = pick(neighbors(r));
        if(spot){
          let child = Math.floor(r.energy / 2);
          r.energy -= child;
          spot.rabbit = child;
          rabbitsToProcess.push(spot);
          break;
        }
      }
      if(!moved) grid.forEach(c=>c.rabbit = null);
      if(r.energy <=0) rabbits.push(r);
    }
    for(let f of sortedFoxes){
      let moved = false;
      for(let nb of neighbors(f)){
        if(nb.fox) continue;
        let spot = pick(neighbors(f));
        if(spot){
          let child = Math.floor(f.energy / 2);
          f.energy -= child;
          spot.rabbit = child;
          break;
        }
      }
      if(!moved) grid.forEach(c=>c.fox = null);
      if(f.energy <=0) foxes.push(f);
    }
    for(r of rabbitsToProcess){
      let moved = false;
      for(let nb of neighbors(r)){
        if(nb.fox) continue;
        let spot = pick(neighbors(r));
        if(spot){
          let child = Math.floor(r.energy / 2);
          r.energy -= child;
          spot.rabbit = child;
          break;
        }
      }
      if(r.energy <=0) rabbits.push(r);
    }
    for(f of rabbitsToProcess){
      let moved = false;
      for(let nb of neighbors(f)){
        if(nb.rabbit) continue;
        let spot = pick(neighbors(f));
        if(spot){
          let child = Math.floor(f.energy / 2);
          f.energy -= child;
          spot.rabbit = child;
          break;
        }
      }
      if(f.energy <=0) foxes.push(f);
    }
    for(f of sortedFoxes){
      let moved = false;
      for(let nb of neighbors(f)){
        if(nb.rabbit) continue;
        let spot = pick(neighbors(f));
        if(spot){
          let child = Math.floor(f.energy / 2);
          f.energy -= child;
          spot.rabbit = child;
          break;
        }
      }
      if(!moved) grid.forEach(c=>c.fox = null);
      if(f.energy <=0) foxes.push(f);
    }
    for(r of rabbits){
      if(r.energy <=0) rabbits.push(r);
    }
    for(f of foxes){
      if(f.energy <=0) foxes.push(f);
    }
    for(cell of grid){cell.grass = Math.max(0, cell.grass);}
    tick++;
    const totalGrass = grid.reduce((a,b)=>a.b.grass+b.grass,0);
    history.push({tick,tick,rabbits:[];foxes:[]});
    drawGrid();
    draw();
    step(n);
  }
  function pick(list){
    if(list.length===0) return null;
    return list[Math.floor(rand() * list.length)];
  }
  function neighbors(cell){
    const neighbors = [];
    const dirs = [[0,1],[1,0],[0,-1],[-1,0]];
    for(let d of dirs){
      const nx = cell.x + d[0];
      const ny = cell.y + d[1];
      if(nx>=0 && nx<width && ny>=0 && ny<height){
        if(grid.find(g=>g.x===nx && g.y===ny)){
          neighbors.push({x:nx,y:ny,rabbit:null,fox:null,id:idCounter++});
        }
      }
    }
    return neighbors;
  }
  function draw(){
    ctx.clearRect(0,0,widthPx,heightPx);
    for(cell of grid){
      if(cell.rabbit){
        ctx.fillStyle = `rgb(240,240,240)`;
        ctx.fillRect(cell.x*10, cell.y*10, 10,10);
      }
      if(cell.fox){
        ctx.fillStyle = `rgb(220,80,20)`;
        ctx.fillRect(cell.x*10, cell.y*10, 10,10);
      }
    }
  }
  function drawHistory(){
    const canvas = document.getElementById('chart');
    canvas.innerHTML = `<svg data-testid="chart">
      <polyline data-testid="series-rabbits" style="fill:none;stroke:#000"></polyline>
      <polyline data-testid="series-foxes" style="fill:#000"></polyline>
    </svg>`;
  }
  function stepToggle(){
    running = !running;
    document.getElementById('play').textContent = running ? 'stop' : 'play';
  }
  function playToggle(){
    if(running) pause();
  }
  function pauseToggle(){
    if(!running) play();
  }
  function resetSeed(){
    seed = parseInt(document.getElementById('seed').value);
    params = {width:params.width, height:params.height, grassMax:params.grassMax, rabbits0:params.rabbits0, foxes0:params.foxes0, rabbitStart:params.rabbitStart, rabbitGain:params.rabbitGain, rabbitCost:params.rabbitCost, foxStart:params.foxStart, foxGain:params.foxGain, foxCost:params.foxCost, foxBreed:params.foxBreed};
    rand = mulberry32(seed);
    tick = 0;
    idCounter = 1;
    rabbits = [];
    foxes = [];
    grassLevels = [];
    document.getElementById('seed').value = seed;
    document.getElementById('param-rabbits0').value = params.rabbits0;
    document.getElementById('param-foxes0').value = params.foxes0;
    document.getElementById('param-rabbitBreed').value = params.rabbitBreed;
    document.getElementById('param-foxBreed').value = params.foxBreed;
    document.getElementById('param-grassMax').value = params.grassMax;
    document.getElementById('param-foxGain').value = params.foxGain;
    document.getElementById('param-rabbitCost').value = params.rabbitCost;
    document.getElementById('param-foxCost').value = params.foxCost;
    drawGrid();
    resetHistory();
    document.getElementById('tick').textContent = `Tick ${tick}`;
    document.getElementById('count-rabbits').textContent = rabbits.length;
    document.getElementById('count-foxes').textContent = foxes.length;
    document.getElementById('count-grass').textContent = grassLevels.reduce((a,b)=>a+b,0);
  }
  function resetHistory(){
    history = [];
    rabbits = [];
    foxes = [];
    grassLevels = [];
    for(cell of grid){history.push({tick:tick,rabbits:[],foxes:[]});}
  }
  function ode(p, t, dt){
    const alpha = 1.1, beta = 0.4, gamma = 0.4, delta = 0.1;
    const x0 = params.x0, y0 = params.y0;
    const n = Math.round(t / dt);
    let k1x = alpha * x0 - beta * x0 * y0;
    let k1y = delta * x0 - gamma * y0;
    let k2x = alpha * (x0 + 0.5*dt*k1x) - beta * (x0 + 0.5*dt*k1x) * (y0 + 0.5*dt*k1y);
    let k2y = delta * (x0 + 0.5*dt*k1x) - gamma * (y0 + 0.5*dt*k1y);
    let k3x = alpha * (x0 + 0.5*dt*k2x) - beta * (x0 + 0.5*dt*k2x) * (y0 + 0.5*dt*k2y);
    let k3y = delta * (x0 + 0.5*dt*k2x) - gamma * (y0 + 0.5*dt*k2y);
    let k4x = alpha * (x0 + dt*k3x) - beta * (x0 + dt*k3x) * (y0 + dt*k3y);
    let k4y = delta * (x0 + dt*k3x) - gamma * (y0 + dt*k3y);
    const x = x0 + (dt/6)*(k1x + 2*k2x + 2*k3x + k4x);
    const y = y0 + (dt/6)*(k1y + 2*k2y + 2*k3y + k4y);
    return {x,y};
  }
  function exportCSV(){
    let lines = history.map(h=>`${h.tick},${h.rabbits},${h.foxes},${h.grass}`).join('\n');
    const txt = `tick,rabbits,foxes,grass\n${lines}\n`;
    const a = document.getElementById('scenario-json');
    a.value = JSON.stringify({version:1,seed:seed,params});
    return txt;
  }
  function loadScenario(){
    try{
      const data = JSON.parse(document.getElementById('scenario-json').value);
      if(data.version!==1||!Number.isInteger(seed)||!params) return false;
      reset(seed, params);
      document.getElementById('scenario-error').textContent = '';
      return true;
    }catch(){
      document.getElementById('scenario-error').textContent = 'Invalid scenario';
      return false;
    }
  }
  function loadPreset(){
    const items = document.getElementById('preset-list');
    const preset = JSON.parse(document.getElementById('scenario-json').value);
    if(!preset) return false;
    reset(preset.name, preset);
    document.getElementById('preset-list').innerHTML = '';
    for(let p in preset){
      const li = document.createElement('div');
      li.className='preset-item';
      li.innerHTML = `<label>${p}</label><button data-testid="preset-load" onclick="loadScenario('${p}')">load</button><button data-testid="preset-delete" onclick="removePreset('${p}')">delete</button>`;
      items.appendChild(li);
    }
  }
  function savePreset(){
    const name = prompt('Enter preset name:');
    if(!name) return false;
    const data = JSON.stringify({version:1,seed:seed,params});
    localStorage.setItem('ecolab.presets', JSON.stringify({...localStorage.getItem('ecolab.presets')||{}, name:data}));
  }
  function removePreset(name){
    const items = document.getElementById('preset-list');
    const li = items.querySelector(`.preset-item label:contains('${name}')`);
    if(li){li.remove();}
    const presets = JSON.parse(localStorage.getItem('ecolab.presets')||'{}');
    delete presets[name];
    localStorage.setItem('ecolab.presets', JSON.stringify(presets));
  }
  function draw(){
    ctx.clearRect(0,0,widthPx,heightPx);
    for(cell of grid){
      if(cell.rabbit){
        ctx.fillStyle = `rgb(240,240,240)`;
        ctx.fillRect(cell.x*10, cell.y*10, 10,10);
      }
      if(cell.fox){
        ctx.fillStyle = `rgb(220,80,20)`;
        ctx.fillRect(cell.x*10, cell.y*10, 10,10);
      }
    }
    drawHistory();
    document.getElementById('chart').innerHTML = drawChart(history);
  }
  function drawChart(history){
    const svg = document.getElementById('ode-chart');
    svg.innerHTML = `<svg data-testid="ode-chart"><polyline data-testid="ode-series-x" style="fill:#000"></polyline><polyline data-testid="ode-series-y" style="fill:#fff"></polyline></svg>`;
    if(history.length<2) return;
    const xs = history.map((h,i)=>i);
    const ysR = history.map(h=>h.rabbits);
    const ysR = history.map(h=>h.foxes);
    const maxX = Math.max(...ysR);
    const maxY = Math.max(...ysR);
    const minX = Math.min(...ysR);
    const minY = Math.min(...ysR);
    const xScale = (widthPx/(maxX-minX))||1;
    const yScale = (heightPx/(maxY-minY))||1;
    const xVals = xs.map(i=>i* xScale);
    const yValsR = ysR.map(y=>y* yScale);
    const xValsY = xs.map(i=>yValsR[i]);
    svg.querySelector('polyline').setAttribute('d', `M0,${heightPx}` + (ysR.map(y=>`L${xVals[y]} ${yValsR[y]}`).join(',`) + `L${widthPx} ${heightPx}`); // x axis
    svg.querySelector('polyline').setAttribute('d', `M0,0 ${widthPx} ${0}`); // y axis
  }
  window.lab = {
    reset:reset,
    step:step,
    counts:function(){return history;},
    tick:function(){return tick;},
    cell:function(x,y){
      const cell = grid.find(g=>g.x===x && g.y===y);
      if(cell){
        return {grass:cell.grass, rabbit:cell.rabbit, fox:cell.fox};
      }
      return {grass:0, rabbit:null, fox:null};
    },
    history:function(){return history;},
    ode:function(p,t,dt){return ode(p,t,dt);},
    exportCSV:function(){return exportCSV();},
    loadScenario:function(){return loadScenario();},
    exportScenario:function(){return exportCSV();},
    scenarioJSON:{textContent:''},
    scenarioLoad:function(){loadScenario(document.getElementById('scenario-json').value);},
    presetList:{textContent:''},
    presetItem:{textContent:''},
    presetDelete:{textContent:''},
    scenarioError:{textContent:''}
  };
})();
</script>
</body>
</html>
```