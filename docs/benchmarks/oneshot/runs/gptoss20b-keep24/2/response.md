## Plan

**Data model**  
- `grid`: 2‑dimensional array of cells `{grass, rabbit, fox}`.  
- `animals`: Map `id → {type, x, y, energy}`.  
- `nextId`: integer counter for new animals.  
- `rand`: mulberry32 generator.  
- `tick`: current tick number.  
- `history`: array of `{tick, rabbits, foxes, grass}`.  
- `params`: merged defaults + user overrides.  

**Tick order**  
1. Grass growth.  
2. Rabbits phase (sorted by id).  
3. Foxes phase (sorted by id).  
4. Increment tick and record history.  

**Components**  
- `WorldCanvas` – `<canvas data-testid="world">`.  
- `Controls` – play/pause/step/reset, seed, speed, sliders.  
- `Counters` – tick, rabbits, foxes, grass.  
- `Chart` – `<svg data-testid="chart">` with two polylines.  
- `CSVExport` – button to download CSV.  
- `ScenarioPanel` – textarea, export/load buttons, error message.  
- `ODEPanel` – inputs, run button, outputs, chart.  
- `PresetPanel` – name input, save button, list of presets.  
- `Announcer` – live region for pause status.  

All components are plain DOM elements; state is kept in the global `lab` object and updated via helper functions that re‑render only the affected parts.  

---

```html
<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><title>Ecosystem Lab</title>
<style>
body{font-family:Arial;margin:0;padding:0;display:flex;flex-wrap:wrap;}
.panel-world{flex:1 1 600px;display:flex;flex-direction:column;gap:10px;}
.panel-side{flex:1 1 400px;display:flex;flex-direction:column;gap:10px;}
canvas{border:1px solid #000;}
svg{border:1px solid #000;}
button,input,textarea{font-size:1rem;}
label{display:block;margin-bottom:4px;}
.counter{font-weight:bold;}
@media(max-width:700px){.panel-side{margin-top:10px;}}
</style>
</head>
<body>
<div class="panel-world">
<canvas data-testid="world"></canvas>
<div>
<button data-testid="play">Play</button>
<button data-testid="pause">Pause</button>
<button data-testid="step">Step</button>
<button data-testid="reset">Reset</button>
</div>
<div>
<label for="seed">Seed</label>
<input type="number" id="seed" data-testid="seed" value="42">
<label for="speed">Speed</label>
<input type="range" id="speed" data-testid="speed" min="1" max="60" value="10">
</div>
<div>
<label for="param-rabbits0">Rabbits</label>
<input type="range" id="param-rabbits0" data-testid="param-rabbits0" min="0" max="300" value="100">
<label for="param-foxes0">Foxes</label>
<input type="range" id="param-foxes0" data-testid="param-foxes0" min="0" max="60" value="6">
<label for="param-rabbitBreed">Rabbit Breed</label>
<input type="range" id="param-rabbitBreed" data-testid="param-rabbitBreed" min="2" max="40" value="12">
<label for="param-foxBreed">Fox Breed</label>
<input type="range" id="param-foxBreed" data-testid="param-foxBreed" min="2" max="60" value="40">
<label for="param-foxGain">Fox Gain</label>
<input type="range" id="param-foxGain" data-testid="param-foxGain" min="1" max="30" value="4">
<label for="param-grassMax">Grass Max</label>
<input type="range" id="param-grassMax" data-testid="param-grassMax" min="1" max="10" value="4">
</div>
<div>
<span class="counter" data-testid="tick">0</span>
<span class="counter" data-testid="count-rabbits">0</span>
<span class="counter" data-testid="count-foxes">0</span>
<span class="counter" data-testid="count-grass">0</span>
</div>
<div>
<button data-testid="csv-export">Export CSV</button>
</div>
<div>
<textarea id="scenario-json" data-testid="scenario-json" rows="4"></textarea>
<button data-testid="scenario-export">Export Scenario</button>
<button data-testid="scenario-load">Load Scenario</button>
<message id="scenario-error" data-testid="scenario-error"></message>
</div>
<div>
<label for="preset-name">Preset Name</label>
<input id="preset-name" data-testid="preset-name" placeholder="Name">
<button data-testid="preset-save">Save Preset</button>
<ul id="preset-list" data-testid="preset-list"></ul>
</div>
<div id="announcer" aria-live="polite"></div>
</div>
<div class="panel-side">
<svg data-testid="chart" width="400" height="200"></svg>
<div>
<label for="ode-alpha">α</label>
<input type="number" id="ode-alpha" data-testid="ode-alpha" step="0.01" value="1.1">
<label for="ode-beta">β</label>
<input type="number" id="ode-beta" data-testid="ode-beta" step="0.01" value="0.4">
<label for="ode-gamma">γ</label>
<input type="number" id="ode-gamma" data-testid="ode-gamma" step="0.01" value="0.4">
<label for="ode-delta">δ</label>
<input type="number" id="ode-delta" data-testid="ode-delta" step="0.01" value="0.1">
<label for="ode-x0">x₀</label>
<input type="number" id="ode-x0" data-testid="ode-x0" step="0.1" value="10">
<label for="ode-y0">y₀</label>
<input type="number" id="ode-y0" data-testid="ode-y0" step="0.1" value="10">
<label for="ode-t">t</label>
<input type="number" id="ode-t" data-testid="ode-t" step="1" value="50">
<label for="ode-dt">Δt</label>
<input type="number" id="ode-dt" data-testid="ode-dt" step="0.01" value="0.01">
<button data-testid="ode-run">Run ODE</button>
<div>
<span id="ode-x" data-testid="ode-x"></span>
<span id="ode-y" data-testid="ode-y"></span>
<span id="ode-eq-x" data-testid="ode-eq-x"></span>
<span id="ode-eq-y" data-testid="ode-eq-y"></span>
<span id="ode-drift" data-testid="ode-drift"></span>
</div>
<svg data-testid="ode-chart" width="400" height="200"></svg>
</div>
</div>
<script>
(() => {
const defaults = {width:40,height:30,grassMax:4,rabbits0:100,foxes0:6,rabbitStart:6,rabbitGain:1,rabbitCost:1,rabbitBreed:12,foxStart:12,foxGain:4,foxCost:2,foxBreed:40};
let params = {...defaults};
let width, height, grassMax;
let grid, animals, nextId, rand, tick, history, canvas, ctx;
let playing = false, lastTime=0, speed=10;
function mulberry32(seed){let a=seed|0;return()=>{a=(a+0x6D2B79F5)|0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
function reset(seed, p={}){params={...defaults,...p};width=params.width;height=params.height;grassMax=params.grassMax;grid=Array.from({length:height},()=>Array.from({length:width},()=>({grass:0,rabbit:null,fox:null})));animals=new Map();nextId=1;rand=mulberry32(seed);tick=0;history=[{tick, rabbits:0, foxes:0, grass:0}];
for(let y=0;y<height;y++)for(let x=0;x<width;x++)grid[y][x].grass=Math.floor(rand()*(grassMax+1));
for(let i=0;i<params.rabbits0;i++){let cells=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(!grid[y][x].rabbit)cells.push({x,y});if(cells.length){let {x,y}=pick(cells);createAnimal('rabbit',x,y,params.rabbitStart);}}
for(let i=0;i<params.foxes0;i++){let cells=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(!grid[y][x].fox)cells.push({x,y});if(cells.length){let {x,y}=pick(cells);createAnimal('fox',x,y,params.foxStart);}}
record();draw();updateCounters();}
function pick(list){return list[Math.floor(rand()*list.length)];}
function createAnimal(type,x,y,energy){let id=nextId++;animals.set(id,{id,type,x,y,energy});grid[y][x][type]={id,energy};}
function neighbors(x,y){let arr=[];let dirs=[[0,-1],[1,0],[0,1],[-1,0]];for(let [dx,dy] of dirs){let nx=x+dx,ny=y+dy;if(nx>=0&&nx<width&&ny>=0&&ny<height)arr.push({x:nx,y:ny});}return arr;}
function step(n=1){for(let i=0;i<n;i++)tickOne();draw();updateCounters();}
function tickOne(){//Grass
for(let y=0;y<height;y++)for(let x=0;x<width;x++)grid[y][x].grass=Math.min(grassMax,grid[y][x].grass+1);
//Rabbits
let rIds=[...animals.values()].filter(a=>a.type==='rabbit').sort((a,b)=>a.id-b.id);
for(let a of rIds){let {x,y,energy}=a;let neigh=neighbors(x,y).filter(n=>!grid[n.y][n.x].rabbit);if(neigh.length){let {x:nx, y:ny}=pick(neigh);grid[y][x].rabbit=null;grid[ny][nx].rabbit={id:a.id,energy};a.x=nx;a.y=ny;}}
let cell=grid[a.y][a.x];energy+=params.rabbitGain*cell.grass;cell.grass=0;energy-=params.rabbitCost;if(energy>=params.rabbitBreed){let neigh=neighbors(a.x,a.y).filter(n=>!grid[n.y][n.x].rabbit);if(neigh.length){let {x:nx,y:ny}=pick(neigh);let child=Math.floor(energy/2);energy-=child;createAnimal('rabbit',nx,ny,child);}}
if(energy<=0){grid[a.y][a.x].rabbit=null;animals.delete(a.id);continue;}a.energy=energy;}
let fIds=[...animals.values()].filter(a=>a.type==='fox').sort((a,b)=>a.id-b.id);
for(let a of fIds){let {x,y,energy}=a;let neigh=neighbors(x,y).filter(n=>grid[n.y][n.x].rabbit && !grid[n.y][n.x].fox);if(neigh.length){let {x:nx,y:ny}=pick(neigh);grid[y][x].fox=null;grid[ny][nx].fox={id:a.id,energy};a.x=nx;a.y=ny;}}
let cell=grid[a.y][a.x];if(cell.rabbit){grid[a.y][a.x].rabbit=null;animals.delete(cell.rabbit.id);energy+=params.foxGain;}
energy-=params.foxCost;if(energy>=params.foxBreed){let neigh=neighbors(a.x,a.y).filter(n=>!grid[n.y][n.x].fox);if(neigh.length){let {x:nx,y:ny}=pick(neigh);let child=Math.floor(energy/2);energy-=child;createAnimal('fox',nx,ny,child);}}
if(energy<=0){grid[a.y][a.x].fox=null;animals.delete(a.id);continue;}a.energy=energy;}
tick++;record();}
function record(){let rabbits=0,foxes=0,grass=0;for(let a of animals.values()){if(a.type==='rabbit')rabbits++;else foxes++;}for(let y=0;y<height;y++)for(let x=0;x<width;x++)grass+=grid[y][x].grass;history.push({tick,rabbits,foxes,grass});}
function draw(){ctx.clearRect(0,0,width*10,height*10);for(let y=0;y<height;y++)for(let x=0;x<width;x++){let g=grid[y][x].grass;let G=60+Math.round(160*g/grassMax);ctx.fillStyle=`rgb(30,${G},30)`;ctx.fillRect(x*10,y*10,10,10);if(grid[y][x].rabbit){ctx.fillStyle='rgb(240,240,240)';ctx.fillRect(x*10+3,y*10+3,4,4);}if(grid[y][x].fox){ctx.fillStyle='rgb(220,80,20)';ctx.fillRect(x*10+3,y*10+3,4,4);}}}
function updateCounters(){document.querySelector('[data-testid="tick"]').textContent=tick;let rabbits=0,foxes=0;for(let a of animals.values()){if(a.type==='rabbit')rabbits++;else foxes++;}document.querySelector('[data-testid="count-rabbits"]').textContent=rabbits;document.querySelector('[data-testid="count-foxes"]').textContent=foxes;let grass=0;for(let y=0;y<height;y++)for(let x=0;x<width;x++)grass+=grid[y][x].grass;document.querySelector('[data-testid="count-grass"]').textContent=grass;}
function updateChart(){let svg=document.querySelector('[data-testid="chart"]');let r=svg.querySelector('[data-testid="series-rabbits"]');let f=svg.querySelector('[data-testid="series-foxes"]');let pts=history.map(h=>`${h.tick},${h.rabbits},${h.foxes}`).join(' ');r.setAttribute('points',pts);f.setAttribute('points',pts);}
function exportCSV(){let lines=['tick,rabbits,foxes,grass'];for(let h of history)lines.push(`${h.tick},${h.rabbits},${h.foxes},${h.grass}`);return lines.join('\\n')+'\\n';}
function exportScenario(){return JSON.stringify({version:1,seed:seed,params});}
function loadScenario(text){try{let obj=JSON.parse(text);if(obj.version!==1||!Number.isInteger(obj.seed))throw'bad';reset(obj.seed,obj.params||{});document.querySelector('#scenario-error').textContent='';return true;}catch{document.querySelector('#scenario-error').textContent='Invalid scenario';return false;}}
function ode(p,t,dt){let {alpha,beta,gamma,delta,x0,y0}=p;let x=x0,y=y0;let n=Math.round(t/dt);for(let i=0;i<n;i++){let k1x=alpha*x-beta*x*y,k1y=delta*x*y-gamma*y;let k2x=alpha*(x+dt*k1x/2)-beta*(x+dt*k1x/2)*(y+dt*k1y/2),k2y=delta*(x+dt*k1x/2)*(y+dt*k1y/2)-gamma*(y+dt*k1y/2);let k3x=alpha*(x+dt*k2x/2)-beta*(x+dt*k2x/2)*(y+dt*k2y/2),k3y=delta*(x+dt*k2x/2)*(y+dt*k2y/2)-gamma*(y+dt*k2y/2);let k4x=alpha*(x+dt*k3x)-beta*(x+dt*k3x)*(y+dt*k3y),k4y=delta*(x+dt*k3x)*(y+dt*k3y)-gamma*(y+dt*k3y);x+=dt*(k1x+2*k2x+2*k3x+k4x)/6; y+=dt*(k1y+2*k2y+2*k3y+k4y)/6;}return{x,y};}
function runODE(){let p={alpha:+document.querySelector('#ode-alpha').value,beta:+document.querySelector('#ode-beta').value,gamma:+document.querySelector('#ode-gamma').value,delta:+document.querySelector('#ode-delta').value,x0:+document.querySelector('#ode-x0').value,y0:+document.querySelector('#ode-y0').value};let t=+document.querySelector('#ode-t').value,dt=+document.querySelector('#ode-dt').value;let {x,y}=ode(p,t,dt);document.querySelector('#ode-x').textContent=x.toPrecision(8);document.querySelector('#ode-y').textContent=y.toPrecision(8);document.querySelector('#ode-eq-x').textContent=(p.gamma/p.delta).toPrecision(8);document.querySelector('#ode-eq-y').textContent=(p.alpha/p.beta).toPrecision(8);let V=(x,y)=>p.delta*x-p.gamma*Math.log(x)+p.beta*y-p.alpha*Math.log(y);let drift=Math.abs(V(x,y)-V(p.x0,p.y0));document.querySelector('#ode-drift').textContent=drift.toPrecision(8);let svg=document.querySelector('#ode-chart');let r=svg.querySelector('[data-testid="ode-series-x"]');let f=svg.querySelector('[data-testid="ode-series-y"]');let pts=Array.from({length:Math.round(t/dt)+1},(_,i)=>{let ti=i*dt;let {x:xi,y:yi}=ode(p,ti,dt);return `${ti},${xi},${yi}`}).join(' ');r.setAttribute('points',pts);f.setAttribute('points',pts);}
function loadPresets(){let raw=localStorage.getItem('ecolab.presets');let obj={};try{obj=JSON.parse(raw);}catch{}let list=document.querySelector('#preset-list');list.innerHTML='';for(let name in obj){let li=document.createElement('li');li.textContent=name;let loadBtn=document.createElement('button');loadBtn.textContent='Load';loadBtn.onclick=()=>{loadScenario(JSON.stringify(obj[name]));};let delBtn=document.createElement('button');delBtn.textContent='Delete';delBtn.onclick=()=>{delete obj[name];localStorage.setItem('ecolab.presets',JSON.stringify(obj));loadPresets();};li.appendChild(loadBtn);li.appendChild(delBtn);list.appendChild(li);} }
function savePreset(){let name=document.querySelector('#preset-name').value.trim();if(!name)return;let obj={seed:seed,params:{...params}};let raw=localStorage.getItem('ecolab.presets');let store={};try{store=JSON.parse(raw);}catch{}store[name]=obj;localStorage.setItem('ecolab.presets',JSON.stringify(store));loadPresets();}
function init(){canvas=document.querySelector('[data-testid="world"]');canvas.width=width*10;canvas.height=height*10;ctx=canvas.getContext('2d');document.querySelector('[data-testid="play"]').onclick=()=>{playing=true;lastTime=performance.now();requestAnimationFrame(loop);};document.querySelector('[data-testid="pause"]').onclick=()=>playing=false;document.querySelector('[data-testid="step"]').onclick=()=>{step();updateChart();};document.querySelector('[data-testid="reset"]').onclick=()=>{let s=document.querySelector('#seed').valueAsNumber;reset(s,{});updateChart();};document.querySelector('#csv-export').onclick=()=>{let a=document.createElement('a');a.href='data:text/csv,'+encodeURIComponent(exportCSV());a.download='ecolab.csv';a.click();};document.querySelector('#scenario-export').onclick=()=>{document.querySelector('#scenario-json').value=exportScenario();};document.querySelector('#scenario-load').onclick=()=>{loadScenario(document.querySelector('#scenario-json').value);};document.querySelector('#preset-save').onclick=savePreset;document.querySelector('#ode-run').onclick=runODE;window.lab={reset,step,counts:()=>history[history.length-1],tick:()=>tick,cell:(x,y)=>{let c=grid[y][x];return{grass:c.grass,rabbit:c.rabbit?{id:c.rabbit.id,energy:c.rabbit.energy}:null,fox:c.fox?{id:c.fox.id,energy:c.fox.energy}:null};},history:()=>history,ode,exportCSV,exportScenario,loadScenario};loadPresets();updateChart();reset(42,{});document.querySelector('#seed').value=42;}
function loop(now){if(!playing)return;let dt=(now-lastTime)/1000;lastTime=now;let ticks=Math.floor(dt*speed);if(ticks>0){step(ticks);updateChart();updateCounters();}requestAnimationFrame(loop);}
init();
})();
</script>
</body></html>