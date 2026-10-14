## Plan

**Data model**  
- `grid`: 2‑D array of cells `{grass, rabbit, fox}`.  
- `animals`: two maps `rabbits` and `foxes` keyed by id → `{id, x, y, energy}`.  
- `idCounter`: next id.  
- `rand`: mulberry32 generator.  
- `params`: merged defaults + user overrides.  
- `history`: array of `{tick, rabbits, foxes, grass}`.  
- `tickCount`: current tick.  

**Tick order**  
1. Grow grass.  
2. Rabbits phase: sorted by id, each moves, eats, loses cost, breeds, dies.  
3. Foxes phase: sorted by id, each moves (prefers rabbit cells), eats, loses cost, breeds, dies.  
4. Increment tick, record history.  

**Components**  
- `WorldCanvas`: `<canvas data-testid="world">` draws grid, grass, rabbits, foxes.  
- `Controls`: play/pause, step, reset, seed, speed, sliders.  
- `Counters`: tick, rabbits, foxes, grass.  
- `Chart`: `<svg data-testid="chart">` with two polylines.  
- `CSVExport`: button `csv-export`.  
- `ScenarioPanel`: textarea, export/load buttons, error message.  
- `ODEPanel`: inputs, run button, outputs, chart.  
- `PresetsPanel`: name input, save button, list of presets with load/delete.  
- `Announcer`: live region for accessibility.  

All components are plain DOM elements; state is kept in the global `lab` object. Event listeners update state, then call `render()` which updates canvas, counters, charts, and history. Playback uses `requestAnimationFrame` with timestamps to schedule ticks at the user‑selected speed. Keyboard shortcuts are handled on `document` when no form control is focused.  

The `window.lab` API exposes the required methods, all delegating to the internal simulation functions. Reset clears history, re‑initialises grid, animals, and id counter, then records tick 0. `step(n)` runs `n` ticks synchronously. `ode(p,t,dt)` implements RK4 on the Lotka–Volterra equations. CSV and scenario export/import use `JSON.stringify`/`JSON.parse`. Presets are stored in `localStorage["ecolab.presets"]`.  

The layout uses CSS grid/flex to place `panel-world` and `panel-side`. Media queries switch to column layout below 700 px. The canvas backing size is `width*10 × height*10`; CSS scales it to fit the container. All controls have `data-testid` attributes as specified.  

---

```html
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Ecosystem Lab</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:0;display:flex;flex-direction:column;min-height:100vh}
#app{display:flex;flex:1;overflow:hidden}
.panel-world{flex:1;display:flex;flex-direction:column;overflow:auto;padding:10px}
.panel-side{width:350px;display:flex;flex-direction:column;overflow:auto;padding:10px}
canvas{border:1px solid #ccc;background:#000}
svg{border:1px solid #ccc;background:#fff}
label{display:block;margin-top:5px}
input[type=range]{width:100%}
.counter{margin-top:5px}
button{margin:2px}
[data-testid]{outline:none}
[data-testid]:focus{outline:2px solid #00f}
#announcer{position:absolute;left:-9999px}
@media(max-width:700px){#app{flex-direction:column} .panel-side{width:auto}}
</style></head><body>
<div id="app">
<div class="panel-world">
<canvas data-testid="world"></canvas>
<div class="controls">
<button data-testid="play">Play</button>
<button data-testid="pause">Pause</button>
<button data-testid="step">Step</button>
<button data-testid="reset">Reset</button>
<label>Seed<input type="number" data-testid="seed" value="42"></label>
<label>Speed<input type="range" data-testid="speed" min="1" max="60" value="10"></label>
<label>Rabbits<input type="range" data-testid="param-rabbits0" min="0" max="300" value="100"><span></span></label>
<label>Foxes<input type="range" data-testid="param-foxes0" min="0" max="60" value="6"><span></span></label>
<label>Rabbit Breed<input type="range" data-testid="param-rabbitBreed" min="2" max="40" value="12"><span></span></label>
<label>Fox Breed<input type="range" data-testid="param-foxBreed" min="2" max="60" value="40"><span></span></label>
<label>Fox Gain<input type="range" data-testid="param-foxGain" min="1" max="30" value="4"><span></span></label>
<label>Grass Max<input type="range" data-testid="param-grassMax" min="1" max="10" value="4"><span></span></label>
</div>
<div class="counters">
<span data-testid="tick">0</span>
<span data-testid="count-rabbits">0</span>
<span data-testid="count-foxes">0</span>
<span data-testid="count-grass">0</span>
</div>
<svg data-testid="chart" width="400" height="200"></svg>
</div>
<div class="panel-side">
<div class="scenario">
<textarea data-testid="scenario-json" rows="4" cols="30"></textarea>
<button data-testid="scenario-export">Export</button>
<button data-testid="scenario-load">Load</button>
<message data-testid="scenario-error"></message>
</div>
<div class="ode">
<label>α<input type="number" data-testid="ode-alpha" step="0.1" value="1.1"></label>
<label>β<input type="number" data-testid="ode-beta" step="0.1" value="0.4"></label>
<label>γ<input type="number" data-testid="ode-gamma" step="0.1" value="0.4"></label>
<label>δ<input type="number" data-testid="ode-delta" step="0.1" value="0.1"></label>
<label>x0<input type="number" data-testid="ode-x0" step="1" value="10"></label>
<label>y0<input type="number" data-testid="ode-y0" step="1" value="10"></label>
<label>t<input type="number" data-testid="ode-t" step="1" value="50"></label>
<label>dt<input type="number" data-testid="ode-dt" step="0.01" value="0.01"></label>
<button data-testid="ode-run">Run</button>
<div>Final x: <span data-testid="ode-x"></span></div>
<div>Final y: <span data-testid="ode-y"></span></div>
<div>Equilibrium x: <span data-testid="ode-eq-x"></span></div>
<div>Equilibrium y: <span data-testid="ode-eq-y"></span></div>
<div>Drift: <span data-testid="ode-drift"></span></div>
<svg data-testid="ode-chart" width="400" height="200"></svg>
</div>
<div class="presets">
<label>Name<input type="text" data-testid="preset-name"></label>
<button data-testid="preset-save">Save</button>
<div data-testid="preset-list"></div>
</div>
<button data-testid="csv-export">Export CSV</button>
</div>
</div>
<div id="announcer" aria-live="polite"></div>
<script>
(() => {
const defaults={width:40,height:30,grassMax:4,rabbits0:100,foxes0:6,rabbitStart:6,rabbitGain:1,rabbitCost:1,rabbitBreed:12,foxStart:12,foxGain:4,foxCost:2,foxBreed:40};
let params={...defaults};
let width=params.width,height=params.height,grassMax=params.grassMax;
let grid=[],rabbits=new Map(),foxes=new Map(),idCounter=1,rand=null,tickCount=0,history=[],playing=false,playSpeed=10,lastTime=0;
const canvas=document.querySelector('[data-testid="world"]'),ctx=canvas.getContext('2d');
const counters={tick:document.querySelector('[data-testid="tick"]'),rabbits:document.querySelector('[data-testid="count-rabbits"]'),foxes:document.querySelector('[data-testid="count-foxes"]'),grass:document.querySelector('[data-testid="count-grass"]')};
const chart=document.querySelector('[data-testid="chart"]'),chartR=document.querySelector('[data-testid="series-rabbits"]'),chartF=document.querySelector('[data-testid="series-foxes"]');
const odeChart=document.querySelector('[data-testid="ode-chart"]'),odeXR=document.querySelector('[data-testid="ode-series-x"]'),odeYR=document.querySelector('[data-testid="ode-series-y"]');
const announcer=document.getElementById('announcer');
function mulberry32(seed){let a=seed|0;return()=>{a=(a+0x6D2B79F5)|0;let t=a;t= Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;}}
function reset(seed,over={}){params={...defaults,...over};width=params.width;height=params.height;grassMax=params.grassMax;grid=Array.from({length:height},()=>Array.from({length:width},()=>({grass:0,rabbit:null,fox:null})));rabbits.clear();foxes.clear();idCounter=1;rand=mulberry32(seed);tickCount=0;history=[];
for(let y=0;y<height;y++)for(let x=0;x<width;x++)grid[y][x].grass=Math.floor(rand()*(grassMax+1));
for(let i=0;i<params.rabbits0;i++){let cells=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(!grid[y][x].rabbit)cells.push({x,y});if(cells.length){let {x,y}=pick(cells);let id=idCounter++;grid[y][x].rabbit={id,energy:params.rabbitStart};rabbits.set(id,{id,x,y,energy:params.rabbitStart});}}
for(let i=0;i<params.foxes0;i++){let cells=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(!grid[y][x].fox)cells.push({x,y});if(cells.length){let {x,y}=pick(cells);let id=idCounter++;grid[y][x].fox={id,energy:params.foxStart};foxes.set(id,{id,x,y,energy:params.foxStart});}}
record();draw();updateCounters();updateChart();updatePresets();}
function pick(list){return list[Math.floor(rand()*list.length)];}
function neighbors(x,y){let arr=[];if(y>0)arr.push({x,y-1});if(x<width-1)arr.push({x+1,y});if(y<height-1)arr.push({x,y+1});if(x>0)arr.push({x-1,y});return arr;}
function step(n=1){for(let i=0;i<n;i++)tick();draw();updateCounters();updateChart();}
function tick(){for(let y=0;y<height;y++)for(let x=0;x<width;x++)grid[y][x].grass=Math.min(grassMax,grid[y][x].grass+1);
let rIds=[...rabbits.keys()].sort((a,b)=>a-b);for(let id of rIds){let a=rabbits.get(id);let cell=grid[a.y][a.x];let neigh=neighbors(a.x,a.y).filter(n=>!grid[n.y][n.x].rabbit);if(neigh.length){let {x,y}=pick(neigh);grid[a.y][a.x].rabbit=null;grid[y][x].rabbit={id,energy:a.energy};a.x=x;a.y=y;}
cell=grid[a.y][a.x];a.energy+=params.rabbitGain*cell.grass;cell.grass=0;a.energy-=params.rabbitCost;if(a.energy>=params.rabbitBreed){let neigh2=neighbors(a.x,a.y).filter(n=>!grid[n.y][n.x].rabbit);if(neigh2.length){let {x,y}=pick(neigh2);let child=Math.floor(a.energy/2);a.energy-=child;let cid=idCounter++;grid[y][x].rabbit={id:cid,energy:child};rabbits.set(cid,{id:cid,x,y,energy:child});}}
if(a.energy<=0){grid[a.y][a.x].rabbit=null;rabbits.delete(id);}}
let fIds=[...foxes.keys()].sort((a,b)=>a-b);for(let id of fIds){let a=foxes.get(id);let cell=grid[a.y][a.x];let neigh=neighbors(a.x,a.y).filter(n=>grid[n.y][n.x].rabbit && !grid[n.y][n.x].fox);if(neigh.length){let {x,y}=pick(neigh);grid[a.y][a.x].fox=null;grid[y][x].fox={id,energy:a.energy};a.x=x;a.y=y;}
cell=grid[a.y][a.x];if(cell.rabbit){cell.rabbit=null;rabbits.delete(cell.rabbit.id);a.energy+=params.foxGain;}
a.energy-=params.foxCost;if(a.energy>=params.foxBreed){let neigh2=neighbors(a.x,a.y).filter(n=>!grid[n.y][n.x].fox);if(neigh2.length){let {x,y}=pick(neigh2);let child=Math.floor(a.energy/2);a.energy-=child;let cid=idCounter++;grid[y][x].fox={id:cid,energy:child};foxes.set(cid,{id:cid,x,y,energy:child});}}
if(a.energy<=0){grid[a.y][a.x].fox=null;foxes.delete(id);}}
tickCount++;record();}
function record(){history.push({tick:tickCount,rabbits:rabbits.size,foxes:foxes.size,grass:sumGrass()});}
function sumGrass(){let s=0;for(let y=0;y<height;y++)for(let x=0;x<width;x++)s+=grid[y][x].grass;return s;}
function draw(){canvas.width=width*10;canvas.height=height*10;for(let y=0;y<height;y++)for(let x=0;x<width;x++){let c=grid[y][x];let G=60+Math.round(160*c.grass/grassMax);ctx.fillStyle=`rgb(30,${G},30)`;ctx.fillRect(x*10,y*10,10,10);if(c.rabbit){ctx.fillStyle='rgb(240,240,240)';ctx.fillRect(x*10+3,y*10+3,4,4);}if(c.fox){ctx.fillStyle='rgb(220,80,20)';ctx.fillRect(x*10+3,y*10+3,4,4);}}}
function updateCounters(){counters.tick.textContent=tickCount;counters.rabbits.textContent=rabbits.size;counters.foxes.textContent=foxes.size;counters.grass.textContent=sumGrass();}
function updateChart(){let pts=history.map(h=>`${h.tick},${h.rabbits}`).join(' ');chartR.setAttribute('points',pts);pts=history.map(h=>`${h.tick},${h.foxes}`).join(' ');chartF.setAttribute('points',pts);}
function updatePresets(){let list=document.querySelector('[data-testid="preset-list"]');list.innerHTML='';let data=localStorage.getItem('ecolab.presets');let obj={};try{obj=JSON.parse(data||'{}');}catch(e){}
for(let name in obj){let div=document.createElement('div');div.textContent=name+' ';let load=document.createElement('button');load.textContent='Load';load.onclick=()=>{loadScenario(obj[name]);};let del=document.createElement('button');del.textContent='Del';del.onclick=()=>{delete obj[name];localStorage.setItem('ecolab.presets',JSON.stringify(obj));updatePresets();};div.append(load,del);list.append(div);}}
function exportCSV(){let lines=['tick,rabbits,foxes,grass'];for(let h of history)lines.push(`${h.tick},${h.rabbits},${h.foxes},${h.grass}`);return lines.join('\\n')+'\\n';}
function exportScenario(){return JSON.stringify({version:1,seed:seed,params});}
function loadScenario(text){try{let obj=JSON.parse(text);if(obj.version!==1||typeof obj.seed!=='number')throw'bad';reset(obj.seed,obj.params||{});return true;}catch(e){document.querySelector('[data-testid="scenario-error"]').textContent='Invalid scenario';return false;}}
function ode(p,t,dt){let x=p.x0,y=p.y0;let n=Math.round(t/dt);for(let i=0;i<n;i++){let k1x=dt*(p.alpha*x-p.beta*x*y);let k1y=dt*(p.delta*x*y-p.gamma*y);let k2x=dt*(p.alpha*(x+k1x/2)-p.beta*(x+k1x/2)*(y+k1y/2));let k2y=dt*(p.delta*(x+k1x/2)*(y+k1y/2)-p.gamma*(y+k1y/2));let k3x=dt*(p.alpha*(x+k2x/2)-p.beta*(x+k2x/2)*(y+k2y/2));let k3y=dt*(p.delta*(x+k2x/2)*(y+k2y/2)-p.gamma*(y+k2y/2));let k4x=dt*(p.alpha*(x+k3x)-p.beta*(x+k3x)*(y+k3y));let k4y=dt*(p.delta*(x+k3x)*(y+k3y)-p.gamma*(y+k3y));x+= (k1x+2*k2x+2*k3x+k4x)/6; y+= (k1y+2*k2y+2*k3y+k4y)/6;}return{x,y};}
function runODE(){let p={alpha:+document.querySelector('[data-testid="ode-alpha"]').value,beta:+document.querySelector('[data-testid="ode-beta"]').value,gamma:+document.querySelector('[data-testid="ode-gamma"]').value,delta:+document.querySelector('[data-testid="ode-delta"]').value,x0:+document.querySelector('[data-testid="ode-x0"]').value,y0:+document.querySelector('[data-testid="ode-y0"]').value};let t=+document.querySelector('[data-testid="ode-t"]').value,dt=+document.querySelector('[data-testid="ode-dt"]').value;let res=ode(p,t,dt);document.querySelector('[data-testid="ode-x"]').textContent=res.x.toPrecision(8);document.querySelector('[data-testid="ode-y"]').textContent=res.y.toPrecision(8);document.querySelector('[data-testid="ode-eq-x"]').textContent=(p.gamma/p.delta).toPrecision(8);document.querySelector('[data-testid="ode-eq-y"]').textContent=(p.alpha/p.beta).toPrecision(8);let V0=p.delta*p.x0-p.gamma*Math.log(p.x0)+p.beta*p.y0-p.alpha*Math.log(p.y0);let V1=p.delta*res.x-p.gamma*Math.log(res.x)+p.beta*res.y-p.alpha*Math.log(res.y);document.querySelector('[data-testid="ode-drift"]').textContent=Math.abs(V1-V0).toPrecision(8);let ptsX=history.map((h,i)=>`${i},${h.rabbits}`).join(' ');let ptsY=history.map((h,i)=>`${i},${h.foxes}`).join(' ');odeXR.setAttribute('points',ptsX);odeYR.setAttribute('points',ptsY);}
function play(){playing=true;lastTime=performance.now();loop();}
function pause(){playing=false;}
function loop(){if(!playing)return;let now=performance.now();let elapsed=(now-lastTime)/1000;let ticks=Math.floor(elapsed*playSpeed);if(ticks>0){step(ticks);lastTime=now;updateCounters();updateChart();updatePresets();}requestAnimationFrame(loop);}
function init(){document.querySelector('[data-testid="seed"]').value=42;document.querySelectorAll('[data-testid^="param-"]').forEach(e=>{let span=e.nextElementSibling;span.textContent=e.value;e.oninput=()=>{span.textContent=e.value;}});document.querySelector('[data-testid="play"]').onclick=play;document.querySelector('[data-testid="pause"]').onclick=pause;document.querySelector('[data-testid="step"]').onclick=()=>{step();updateCounters();updateChart();};document.querySelector('[data-testid="reset"]').onclick=()=>{let seed=parseInt(document.querySelector('[data-testid="seed"]').value)||0;let over={rabbits0:+document.querySelector('[data-testid="param-rabbits0"]').value,foxes0:+document.querySelector('[data-testid="param-foxes0"]').value,rabbitBreed:+document.querySelector('[data-testid="param-rabbitBreed"]').value,foxBreed:+document.querySelector('[data-testid="param-foxBreed"]').value,foxGain:+document.querySelector('[data-testid="param-foxGain"]').value,grassMax:+document.querySelector('[data-testid="param-grassMax"]').value};reset(seed,over);};document.querySelector('[data-testid="speed"]').oninput=()=>{playSpeed=+document.querySelector('[data-testid="speed"]').value;};document.querySelector('[data-testid="csv-export"]').onclick=()=>{let a=document.createElement('a');a.href='data:text/csv,'+encodeURIComponent(exportCSV());a.download='ecolab.csv';a.click();};document.querySelector('[data-testid="scenario-export"]').onclick=()=>{document.querySelector('[data-testid="scenario-json"]').value=exportScenario();};document.querySelector('[data-testid="scenario-load"]').onclick=()=>{loadScenario(document.querySelector('[data-testid="scenario-json"]').value);};document.querySelector('[data-testid="preset-save"]').onclick=()=>{let name=document.querySelector('[data-testid="preset-name"]').value;if(!name)return;let data=localStorage.getItem('ecolab.presets');let obj={};try{obj=JSON.parse(data||'{}');}catch(e){}obj[name]=exportScenario();localStorage.setItem('ecolab.presets',JSON.stringify(obj));updatePresets();};document.querySelector('[data-testid="ode-run"]').onclick=runODE;document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT','BUTTON'].includes(document.activeElement.tagName))return;switch(e.key){case ' ':e.preventDefault();playing?pause():play();break;case 's':step();updateCounters();updateChart();break;case 'r':document.querySelector('[data-testid="reset"]').click();break;}});window.lab={reset,step,counts:()=>({rabbits:rabbits.size,foxes:foxes.size,grass:sumGrass()}),tick:()=>tickCount,cell:(x,y)=>{let c=grid[y][x];return{grass:c.grass,rabbit:c.rabbit?{id:c.rabbit.id,energy:c.rabbit.energy}:null,fox:c.fox?{id:c.fox.id,energy:c.fox.energy}:null};},history:()=>history.slice(),ode,exportCSV,exportScenario,loadScenario};reset(42,{});announcer.textContent=`Tick ${tickCount}: ${rabbits.size} rabbits, ${foxes.size} foxes`;};init();})();
</script>
</body></html>
```