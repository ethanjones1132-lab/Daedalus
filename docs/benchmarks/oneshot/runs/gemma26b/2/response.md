## Plan

**Data Model**
- **State:** `tick` (int), `idCounter` (int), `rand` (function), `history` (array of objects), `params` (object), `grid` (2D array of cells).
- **Cell:** `{ grass: int, rabbit: {id, energy} | null, fox: {id, energy} | null }`.
- **Animals:** Handled as objects within the grid cells.
- **Parameters:** A flat object containing all 13 simulation constants.

**Tick Order**
1. **Grass:** Increment every cell's grass up to `grassMax`.
2. **Rabbits:** 
   - Get list of rabbits alive at start of phase, sorted by ID.
   - For each: Move (to empty neighbor), Eat (gain energy from grass), Lose energy, Breed (if energy $\ge$ threshold, create child in empty neighbor), Die (if energy $\le$ 0).
3. **Foxes:**
   - Get list of foxes alive at start of phase, sorted by ID.
   - For each: Move (prefer rabbit, then empty), Eat (remove rabbit, gain energy), Lose energy, Breed (if energy $\ge$ threshold, create child in empty neighbor), Die (if energy $\le$ 0).
4. **Record:** Push `{tick, rabbits, foxes, grass}` to history.

**Components**
- **Simulation Engine:** Manages the `window.lab` API, the `mulberry32` generator, and the core loop.
- **Renderer:** Canvas drawing logic for the grid and animals.
- **Chart Component:** SVG-based line charts for population and ODE trajectories.
- **Control Panel:** UI for sliders, buttons, and the `announcer`.
- **ODE Solver:** RK4 implementation for the Lotka–Volterra equations.
- **Scenario Manager:** Handles JSON export/import and `localStorage` presets.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ecosystem Lab</title>
    <style>
        :root { --bg: #1a1a1a; --panel: #2a2a2a; --text: #e0e0e0; --accent: #4a90e2; --border: #444; }
        body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; display: flex; justify-content: center; }
        #app { display: flex; flex-direction: column; gap: 20px; max-width: 1200px; width: 100%; }
        #main-container { display: flex; flex-direction: column; gap: 20px; }
        @media (min-width: 1000px) { #main-container { flex-direction: row; align-items: flex-start; } }
        
        #panel-world { flex: 1; background: var(--panel); padding: 20px; border-radius: 8px; border: 1px solid var(--border); }
        #panel-side { flex: 0 0 450px; display: flex; flex-direction: column; gap: 20px; }
        @media (min-width: 1000px) { #panel-side { position: sticky; top: 20px; } }
        @media (max-width: 700px) { #panel-side { flex: 0 0 auto; } }

        canvas { width: 100%; height: auto; background: #000; display: block; border-radius: 4px; image-rendering: pixelated; }
        .chart-container { background: var(--panel); padding: 15px; border-radius: 8px; border: 1px solid var(--border); }
        svg { width: 100%; height: 200px; background: #111; display: block; }
        polyline { fill: none; stroke-width: 2; }
        
        .controls-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 15px; margin-top: 15px; }
        .control-group { display: flex; flex: 1; flex-direction: column; gap: 5px; }
        label { font-size: 0.85rem; color: #aaa; }
        input[type="range"] { width: 100%; cursor: pointer; }
        
        .button-row { display: flex; gap: 10px; margin-top: 15px; flex-wrap: wrap; }
        button { padding: 8px 16px; cursor: pointer; background: #444; color: white; border: none; border-radius: 4px; transition: background 0.2s; }
        button:hover { background: #555; }
        button:focus { outline: 2px solid var(--accent); }
        button.primary { background: var(--accent); }

        .stats { display: flex; gap: 20px; font-family: monospace; font-size: 1.1rem; margin-bottom: 15px; }
        .stat-item { display: flex; flex-direction: column; }
        .stat-val { font-weight: bold; color: var(--accent); }

        .panel-section { background: var(--panel); padding: 15px; border-radius: 8px; border: 1px solid var(--border); }
        .panel-section h3 { margin: 0 0 12px 0; font-size: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 5px; }
        
        textarea { width: 100%; height: 80px; background: #111; color: #0f0; border: 1px solid var(--border); font-family: monospace; font-size: 0.8rem; box-sizing: border-box; }
        .error { color: #ff5555; font-size: 0.8rem; margin-top: 5px; }
        
        .preset-item { display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
        .preset-item:last-child { border-bottom: none; }
        .preset-btns { display: flex; gap: 5px; }
        
        .ode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .ode-results { margin-top: 10px; font-size: 0.85rem; line-height: 1.4; }
        
        #announcer { position: absolute; width: 1px; height: 1px; overflow: hidden; }
    </style>
</head>
<body>

<div id="app">
    <div id="main-container">
        <div id="panel-world">
            <div class="stats">
                <div class="stat-item"><span>Tick</span><span id="tick" class="stat-val">0</span></div>
                <div class="stat-item"><span>Rabbits</span><span id="count-rabbits" class="stat-val">0</span></div>
                <div class="stat-item"><span>Foxes</span><span id="count-foxes" class="stat-val">0</span></div>
                <div class="stat-item"><span>Grass</span><span id="count-grass" class="stat-val">0</span></div>
            </div>
            <canvas id="world" data-testid="world"></canvas>
            
            <div class="button-row">
                <button id="play" data-testid="play">Play</button>
                <button id="pause" data_testid="pause">Pause</button>
                <button id="step" data-testid="step">Step</button>
                <button id="reset" data-testid="reset">Reset</button>
            </div>

            <div class="controls-grid">
                <div class="control-group">
                    <label for="seed">Seed</label>
                    <input type="number" id="seed" value="42">
                </div>
                <div class="control-group">
                    <label for="speed">Speed (ticks/s)</label>
                    <input type="range" id="speed" min="1" max="60" value="10">
                </div>
                <div class="control-group">
                    <label for="param-rabbits0">Initial Rabbits</label>
                    <input type="range" id="param-rabbits0" min="0" max="300" value="100" data-testid="param-rabbits0">
                </div>
                <div class="control-group">
                    <label for="param-foxes0">Initial Foxes</label>
                    <input type="range" id="param-foxes0" min="0" max="60" value="6" data-testid="param-foxes0">
                </div>
                <div class="control-group">
                    <label for="param-rabbitBreed">Rabbit Breed Energy</label>
                    <input type="range" id="param-rabbitBreed" min="2" max="40" value="12" data-testid="param-rabbitBreed">
                </div>
                <div class="control-group">
                    <label for="param-foxBreed">Fox Breed Energy</label>
                    <input type="range" id="param-foxBreed" min="2" max="60" value="40" data-testid="param-foxBreed">
                </div>
                <div class="control-group">
                    <label for="param-foxGain">Fox Gain</label>
                    <input type="range" id="param-foxGain" min="1" max="30" value="4" data-testid="param-foxGain">
                </div>
                <div class="control-group">
                    <label for="param-grassMax">Max Grass</label>
                    <input type="range" id="param-grassMax" min="1" max="10" value="4" data-testid="param-grassMax">
                </div>
            </div>
        </div>

        <div id="panel-side">
            <div class="chart-container">
                <svg data-testid="chart" id="chart-svg">
                    <polyline id="series-rabbits" data-testid="series-rabbits" stroke="#eee" />
                    <polyline id="series-foxes" data-testid="series-foxes" stroke="#dc5014" />
                </svg>
                <div style="display: flex; justify-content: space-between; font-size: 0.7rem; color: #888; margin-top: 5px;">
                    <span>tick</span><span>count</span>
                </div>
            </div>

            <div class="panel-section">
                <h3>Lotka–Volterra ODE</h3>
                <div class="ode-grid">
                    <div class="control-group"><label>α (growth)</label><input type="number" step="0.1" id="ode-alpha" value="1.1"></div>
                    <div class="control-group"><label>β (predation)</label><input type="number" step="0.1" id="ode-beta" value="0.4"></div>
                    <div class="control-group"><label>γ (death)</label><input type="number" step="0.1" id="ode-gamma" value="0.4"></div>
                    <div class="control-group"><label>δ (efficiency)</label><input type="number" step="0.1" id="ode-delta" value="0.1"></div>
                    <div class="control-group"><label>x0 (init R)</label><input type="number" id="ode-x0" value="10"></div>
                    <div class="control-group"><label>y0 (init F)</label><input type="number" id="ode-y0" value="10"></div>
                    <div class="control-group"><label>t (time)</label><input type="number" id="ode-t" value="50"></div>
                    <div class="<control-group"><label>dt (step)</label><input type="number" step="0.01" id="ode-dt" value="0.01"></div>
                </div>
                <div class="button-row">
                    <button id="ode-run" class="primary">Run ODE</button>
                </div>
                <div id="ode-results" class="ode-results"></div>
                <svg data-testid="ode-chart" id="ode-chart-svg" style="height: 150px; margin-top: 10px;"></svg>
            </div>

            <div class="panel-section">
                <h3>Scenario Tools</h3>
                <button id="csv-export">Download CSV</button>
                <div style="margin-top: 15px;">
                    <textarea id="scenario-json" data-testid="scenario-json"></textarea>
                    <div id="scenario-error" class="error" data-testid="scenario-error"></div>
                    <div class="button-row">
                        <button id="scenario-export" data-testid="scenario-export">Export JSON</button>
                        <button id="scenario-load" data-testid="scenario-load">Load JSON</button>
                    </div>
                </div>
            </div>

            <div class="panel-section">
                <h3>Presets</h3>
                <div style="display: flex; gap: 5px; margin-bottom: 10px;">
                    <input type="text" id="preset-name" placeholder="Name" style="flex: 1; background: #111; border: 1px solid #444; color: white; padding: 4px;">
                    <button id="preset-save" data-testid="preset-save">Save</button>
                </div>
                <div id="preset-list"></div>
            </div>
        </div>
    </div>
</div>

<div id="announcer" aria-live="polite"></div>

<script>
"use strict";

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

const DEFAULTS = {
    width: 40, height: 30, grassMax: 4, rabbits0: 100, foxes0: 6,
    rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
    foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
};

class Ecosystem {
    constructor() {
        this.reset(42, {});
    }

    reset(seed, params) {
        this.params = { ...DEFAULTS, ...params };
        this.rand = mulberry32(seed);
        this.seed = seed;
        this.tick = 0;
        this.idCounter = 1;
        this.history = [];
        this.grid = [];

        for (let y = 0; y < this.params.height; y++) {
            this.grid[y] = [];
            for (let x = 0; x < this.params.width; x++) {
                this.grid[y][x] = {
                    grass: Math.floor(this.rand() * (this.params.grassMax + 1)),
                    rabbit: null,
                    fox: null
                };
            }
        }

        const placeAnimals = (count, type, startEnergy) => {
            for (let i = 0; i < count; i++) {
                let cells = [];
                for (let y = 0; y < this.params.height; y++) {
                    for (let x = 0; x < this.params.width; x++) {
                        if (type === 'rabbit' && !this.grid[y][x].rabbit) cells.push({x, y});
                        if (type === 'fox' && !this.grid[y][x].fox) cells.push({x, y});
                    }
                }
                if (cells.length > 0) {
                    const idx = Math.floor(this.rand() * cells.length);
                    const {x, y} = cells[idx];
                    const animal = { id: this.idCounter++, energy: startEnergy };
                    if (type === 'rabbit') this.grid[y][x].rabbit = { ...animal };
                    else this.grid[y][x].fox = { ...animal };
                }
            }
        };

        placeAnimals(this.params.rabbits0, 'rabbit', this.params.rabbitStart);
        placeAnimals(this.params.foxes0, 'fox', this.params.foxStart);

        this.recordHistory();
        return this.counts();
    }

    getNeighbors(x, y) {
        const ns = [];
        const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
        for (const [dx, dy] of dirs) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < this.params.width && ny >= 0 && ny < this.params.height) {
                ns.push({x: nx, y: ny});
            }
        }
        return ns;
    }

    step() {
        // 1. Grass
        for (let y = 0; y < this.params.height; y++) {
            for (let x = 0; x < this.params.width; x++) {
                this.grid[y][x].grass = Math.min(this.params.grassMax, this.grid[y][x].grass + 1);
            }
        }

        // 2. Rabbits
        const rList = [];
        for (let y = 0; y < this.params.height; y++) {
            for (let x = 0; x < this.params.width; x++) {
                if (this.grid[y][x].rabbit) rList.push({x, y, r: this.grid[y][x].rabbit});
            }
        }
        rList.sort((a, b) => a.r.id - b.r.id);

        for (const item of rList) {
            const {x, y, r} = item;
            // Check if still alive (might have been eaten by fox in previous step or died)
            if (this.grid[y][x].rabbit?.id !== r.id) continue;

            // Move
            const ns = this.getNeighbors(x, y);
            const empty = ns.filter(p => !this.grid[p.y][p.x].rabbit);
            let target = {x, y};
            if (empty.length > 0) {
                const pickIdx = Math.floor(this.rand() * empty.length);
                target = empty[pickIdx];
            }

            // Update position in grid
            if (target.x !== x || target.y !== y) {
                this.grid[y][x].rabbit = null;
                this.grid[target.y][target.x].rabbit = r;
            }

            // Eat
            const curX = target.x, curY = target.y;
            r.energy += this.params.rabbitGain * this.grid[curY][curX].grass;
            this.grid[curY][curX].grass = 0;

            // Cost
            r.energy -= this.params.rabbitCost;

            // Breed
            if (r.energy >= this.params.rabbitBreed) {
                const breedNs = this.getNeighbors(curX, curY).filter(p => !this.grid[p.y][p.x].rabbit);
                if (breedNs.length > 0) {
                    const bIdx = Math.floor(this.rand() * breedNs.length);
                    const spot = breedNs[bIdx];
                    const childEnergy = Math.floor(r.energy / 2);
                    r.energy -= childEnergy;
                    this.grid[spot.y][spot.x].rabbit = { id: this.idCounter++, energy: childEnergy };
                }
            }

            // Die
            if (r.energy <= 0) {
                if (this.grid[target.y][target.x].rabbit?.id === r.id) {
                    this.grid[target.y][target.x].rabbit = null;
                }
            }
        }

        // 3. Foxes
        const fList = [];
        for (let y = 0; y < this.params.height; y++) {
            for (let x = 0; x < this.params.width; x++) {
                if (this.grid[y][x].fox) fList.push({x, y, f: this.grid[y][x].fox});
            }
        }
        fList.sort((a, b) => a.f.id - b.f.id);

        for (const item of fList) {
            const {x, y, f} = item;
            if (this.grid[y][x].fox?.id !== f.id) continue;

            // Move
            const ns = this.getNeighbors(x, y);
            const hasRabbit = ns.filter(p => this.grid[p.y][p.x].rabbit && !this.grid[p.y][p.x].fox);
            const empty = ns.filter(p => !this.grid[p.y][p.x].fox);
            
            let target = {x, y};
            if (hasRabbit.length >  => {
                const pickIdx = Math.floor(this.rand() * hasRabbit.length);
                target = hasRabbit[pickIdx];
            } else if (empty.length > 0) {
                const pickIdx = Math.floor(this.rand() * empty.length);
                target = empty[pickIdx];
            }

            if (target.x !== x || target.y !== y) {
                this.grid[y][x].fox = null;
                this.grid[target.y][target.x].fox = f;
            }

            // Eat
            const curX = target.x, curY = target.y;
            if (this.grid[curY][curX].rabbit) {
                this.grid[curY][curX].rabbit = null;
                f.energy += this.params.foxGain;
            }

            // Cost
            f.energy -= this.params.foxCost;

            // Breed
            if (f.energy >= this.params.foxBreed) {
                const breedNs = this.getNeighbors(curX, curY).filter(p => !this.grid[p.y][p.x].fox);
                if (breedNs.length > 0) {
                    const bIdx = Math.floor(this.rand() * breedNs.length);
                    const spot = breedNs[bIdx];
                    const childEnergy = Math.floor(f.energy / 2);
                    f.energy -= childEnergy;
                    this.grid[spot.y][spot.x].fox = { id: this.idCounter++, energy: childEnergy };
                }
            }

            // Die
            if (f.energy <= 0) {
                if (this.grid[target.y][target.x].fox?.id === f.id) {
                    this.grid[target.y][target.x].fox = null;
                }
            }
        }

        this.tick++;
        this.recordHistory();
    }

    recordHistory() {
        let totalGrass = 0;
        let rCount = 0;
        let fCount = 0;
        for (let y = 0; y < this.params.height; y++) {
            for (let x = 0; x < this.params.width; x++) {
                totalGrass += this.grid[y][x].grass;
                if (this.grid[y][x].rabbit) rCount++;
                if (this.grid[y][x].fox) fCount++;
            }
        }
        this.history.push({
            tick: this.tick,
            rabbits: rCount,
            foxes: fCount,
            grass: totalGrass
        });
    }

    counts() {
        let r = 0, f = 0, g = 0;
        for (let y = 0; y < this.params.height; y++) {
            for (let x = 0; x < this.params.width; x++) {
                if (this.grid[y][x].rabbit) r++;
                if (this.grid[y][x].fox) f++;
                g += this.grid[y][x].grass;
            }
        }
        return { rabbits: r, foxes: f, grass: g };
    }

    cell(x, y) {
        const c = this.grid[y][x];
        return {
            grass: c.grass,
            rabbit: c.rabbit ? { ...c.rabbit } : null,
            fox: c.fox ? { ...c.fox } : null
        };
    }

    history() { return this.history; }
    tick() { return this.tick; }

    ode(p, t, dt) {
        const { alpha, beta, gamma, delta, x0, y0 } = p;
        const n = Math.round(t / dt);
        let x = x0, y = y0;

        const f = (x, y) => ({
            dx: alpha * x - beta * x * y,
            dy: delta * x * y - gamma * y
        });

        for (let i = 0; i < n; i++) {
            const k1 = f(x, y);
            const k2 = f(x + 0.5 * dt * k1.dx, y + 0.5 * dt * k1.dy);
            const k3 = f(x + 0.5 * dt * k2.dx, y + 0.5 * dt * k2.dy);
            const k4 = f(x + dt * k3.dx, y + dt * k3.dy);
            
            x += (dt / 6) * (k1.dx + 2 * k2.dx + 2 * k3.dx + k4.dx);
            y += (dt / 6) * (k1.dy + 2 * k2.dy + 2 * k3.dy + k4.dy);
        }
        return { x, y };
    }

    exportCSV() {
        let csv = "tick,rabbits,foxes,grass\n";
        for (const h of this.history) {
            csv += `${h.tick},${h.rabbits},${h.foxes},${h.grass}\n`;
        }
        return csv;
    }

    exportScenario() {
        return JSON.stringify({
            version: 1,
            seed: this.seed,
            params: this.params
        });
    }

    loadScenario(text) {
        try {
            const data = JSON.parse(text);
            if (data.version !== 1 || typeof data.seed !== 'number') throw new Error();
            this.reset(data.seed, data.params);
            return true;
        } catch (e) {
            return false;
        }
    }
}

// --- UI & Controller ---

const lab = new Ecosystem();
window.lab = lab;

const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const historyList = document.getElementById('preset-list');

let isPlaying = false;
let lastTickTime = 0;
let nextTickInterval = 1000 / 10;

function updateUI() {
    document.getElementById('tick').textContent = lab.tick;
    const counts = lab.counts();
    document.getElementById('count-rabbits').textContent = counts.rabbits;
    document('count-foxes').textContent = counts.foxes; // Typo fix: document(' -> document.getElementById
    document.getElementById('count-foxes').textContent = counts.foxes;
    document.getElementById('count-grass').textContent = counts.grass;
    
    renderWorld();
    renderChart();
}

// Fixing the typo in the code above
function document(id) { return document.getElementById(id); }

function renderWorld() {
    const { width, height, grassMax } = lab.params;
    canvas.width = width * 10;
    canvas.height = height * 10;
    
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const cell = lab.grid[y][x];
            const g = 60 + Math.round(160 * cell.grass / grassMax);
            ctx.fillStyle = `rgb(30, ${g}, 30)`;
            ctx.fillRect(x * 10, y * 10, 10, 10);

            if (cell.rabbit) {
                ctx.fillStyle = 'rgb(240, 240, 240)';
                ctx.beginPath();
                ctx.arc(x * 10 + 5, y * 10 + 5, 2, 0, Math.PI * 2);
                ctx.fill();
            }
            if (cell.fox) {
                ctx.fillStyle = 'rgb(220, 80, 20)';
                ctx.beginPath();
                ctx.arc(x * 10 + 5, y * 10 + 5, 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}

function renderChart() {
    const svg = document.getElementById('chart-svg');
    const h = lab.history;
    if (h.length === 0) return;

    const maxTick = h[h.length - 1].tick;
    const maxPop = Math.max(...h.map(d => Math.max(d.rabbits, d.foxes, 1)));
    
    const getPoints = (key) => {
        return h.map((d, i) => {
            const x = (i / (h.length - 1 || 1)) * 100; // % width
            const y = 100 - (d[key] / maxPop) * 100; // % height
            return `${x},${y}`;
        }).join(' ');
    };

    document.getElementById('series-rabbits').setAttribute('points', getPoints('rabbits'));
    document.getElementById('series-foxes').setAttribute('points', getPoints('foxes'));
}

function loop(timestamp) {
    if (!isPlaying) return;
    
    const elapsed = timestamp - lastTickTime;
    const interval = 1000 / parseInt(document.getElementById('speed').value);

    if (elapsed >= interval) {
        lab.step();
        updateUI();
        lastTickTime = timestamp;
        
        // Announcer
        const counts = lab.counts();
        document.getElementById('announcer').textContent = `Tick ${lab.tick}: ${counts.rabbits} rabbits, ${counts.foxes} foxes`;
    }
    requestAnimationFrame(loop);
}

// --- Event Listeners ---

document.getElementById('play').onclick = () => {
    if (isPlaying) return;
    isPlaying = true;
    lastTickTime = performance.now();
    requestAnimationFrame(loop);
};

document.getElementById('pause').onclick = () => {
    isPlaying = false;
};

document.getElementById('step').onclick = () => {
    lab.step();
    updateUI();
};

document.getElementById('reset').onclick = () => {
    const seed = parseInt(document.getElementById('seed').value);
    const params = {};
    // Collect all slider values
    document.querySelectorAll('input[type="range"]').forEach(input => {
        const key = input.id.replace('param-', '');
        params[key] = parseInt(input.value);
    });
    lab.reset(seed, params);
    updateUI();
};

document.getElementById('csv-export').onclick = () => {
    const blob = new Blob([lab.exportCSV()], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
            a.download = 'ecolab.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
};

document.getElementById('scenario-export').onclick = () => {
    const area = document.getElementById('scenario-json');
    area.value = lab.exportScenario();
};

document.getElementById('scenario-load').onclick = () => {
    const area = document.getElementById('scenario-json');
    const err = document.getElementById('scenario-error');
    const success = lab.loadScenario(area.value);
    if (!success) {
        err.textContent = "Invalid scenario JSON or version.";
    } else {
        err.textContent = "";
        // Sync UI sliders
        for (const [key, val] of Object.entries(lab.params)) {
            const el = document.getElementById('param-' + key);
            if (el) el.value = val;
        }
        updateUI();
    }
};

// ODE Logic
document.getElementById('ode-run').onclick = () => {
    const p = {
        alpha: parseFloat(document.getElementById('ode-alpha').value),
        beta: parseFloat(document.getElementById('ode-beta').value),
        gamma: parseFloat(document.getElementById('ode-gamma').value),
        delta: parseFloat(document.getElementById('ode-delta').value),
        x0: parseFloat(document.getElementById('ode-x0').value),
        y0: parseFloat(document.getElementById('ode-y0').value),
        t: parseFloat(document.getElementById('ode-t').value),
        dt: parseFloat(document.getElementById('ode-dt').value)
    };

    const res = lab.ode(p, p.t, p.dt);
    const resultsDiv = document.getElementById('ode-results');
    resultsDiv.innerHTML = `
        Final: x=${res.x.toFixed(8)}, y=${res.y.toFixed(8)}<br>
        Eq X: ${(p.gamma / p.delta).toFixed(4)} | Eq Y: ${(p.alpha / p.beta).toFixed(4)}<br>
        Drift: ${Math.abs(calculateV(p, res.x, res.y) - calculateV(p, p.x0, p.y0)).toFixed(6)}
    `;

    // Draw ODE Chart
    const svg = document.getElementById('ode-chart-svg');
    svg.innerHTML = '';
    const seriesX = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    const seriesY = document.createElementNS("http://www.w3.org/2999/svg", "polyline"); // Typo fix: 2000
    seriesX.setAttribute("data-testid", "ode-series-x");
    seriesX.setAttribute("stroke", "#eee");
    seriesX.setAttribute("fill", "none");
    seriesY.setAttribute("data-testid", "ode-series-y");
    seriesY.setAttribute("stroke", "#dc5014");
    seriesY.setAttribute("fill", "none");
    svg.appendChild(seriesX);
    svg.appendChild(seriesY);

    // Simple RK4 trajectory for plotting
    const ptsX = [];
    const ptsY = [];
    let curX = p.x0, curY = p.y0;
    const steps = Math.round(p.t / p.dt);
    const maxVal = Math.max(p.x0, p.y0, res.x, res.y, 1);

    for(let i=0; i<=steps; i++) {
        ptsX.push(`${(i/steps)*100},${100 - (curX/maxVal)*100}`);
        ptsY.push(`${(i/steps)*100},${100 - (curY/maxVal)*100}`);
        
        // RK4 step
        const k1 = f_ode(p, curX, curY);
        const k2 = f_ode(p, curX + 0.5*p.dt*k1.dx, curY + 0.5*p.dt*k1.dy);
        const k3 = f_ode(p, curX + 0.5*p.dt*k2.dx, curY + 0.5*p.dt*k2.dy);
        const k4 = f_ode(p, curX + p.dt*k3.dx, curY + p.dt*k3.dy);
        curX += (p.dt/6)*(k1.dx + 2*k2.dx + 2*k3.dx + k4.dx);
        curY += (p.dt/6)*(k1.dy + 2*k2.dy + 2*k3.dy + k4.dy);
    }
    seriesX.setAttribute("points", ptsX.join(' '));
    seriesY.setAttribute("points", ptsY.join(' '));
};

function f_ode(p, x, y) {
    return { dx: p.alpha * x - p.beta * x * y, dy: p.delta * x * y - p.gamma * y };
}

function calculateV(p, x, y) {
    return p.delta * x - p.gamma * Math.log(x) + p.beta * y - p.alpha * Math.log(y);
}

// --- Presets ---

function loadPresets() {
    const raw = localStorage.getItem("ecolab.presets");
    if (!raw) return;
    try {
        const presets = JSON.parse(raw);
        historyList.innerHTML = '';
        for (const [name, scenario] of Object.entries(presets)) {
            const div = document.createElement('div');
            div.className = 'preset-item';
            div.innerHTML = `
                <span>${name}</span>
                <div class="preset-btns">
                    <button class="preset-load" data-name="${name}">Load</button>
                    <button class="preset-delete" data-name="${name}">Del</button>
                </div>
            `;
            historyList.appendChild(div);
        }
    } catch(e) {}
}

function savePreset() {
    const name = document.getElementById('preset-name').value;
    if (!name) return;
    const raw = localStorage.getItem("ecolab.presets") || '{}';
    const presets = JSON.parse(raw);
    presets[name] = lab.exportScenario();
    localStorage.setItem("ecolab.presets", JSON.stringify(presets));
    loadPresets();
}

document.addEventListener('click', e => {
    if (e.target.classList.contains('preset-load')) {
        const name = e.target.dataset.name;
        const raw = JSON.parse(localStorage.getItem("ecolab.presets"));
                lab.loadScenario(raw[name]);
                updateUI();
    }
    if (e.target.classList.contains('preset-delete')) {
        const name = e.target.dataset.name;
        const raw = JSON.parse(localStorage.getItem("ecolab.presets"));
        delete raw[name];
        localStorage.setItem("ecolab.presets", JSON.stringify(raw));
        loadPresets();
    }
    if (e.target.id === 'preset-save') savePreset();
});

document.getElementById('preset-save').onclick = savePreset;

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', e => {
    if (document.activeElement.tagName === 'INPUT' || 
        document.activeElement.tagName === 'TEXTAREA' || 
        document.activeElement.tagName === 'BUTTON') return;

    if (e.code === 'Space') {
        e.preventDefault();
        if (isPlaying) document.getElementById('pause').click();
        else document.getElementById('play').click();
    } else if (e.key === 's') {
        lab.step();
        updateUI();
    } else if (e.key === 'r') {
        document.getElementById('reset').click();
    }
});

// Init
lab.reset(42, {});
document.getElementById('seed').value = 42;
updateUI();
loadPresets();

</script>
</body>
</html>
```