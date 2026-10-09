## Plan

**Data Model:**
The app maintains a single global state object. The world is a 2D grid (`width` x `height`) where each cell holds an integer `grass` level (0 to `grassMax`). Animals are objects with `{id, x, y, energy, type}`. A single counter tracks IDs. The simulation state includes a `tick` counter, a `history` array of snapshots, and a `running` boolean.

**Tick Order:**
1.  **Grass:** Every cell grows grass by 1 (capped at `grassMax`).
2.  **Rabbits:** Iterate rabbits by ascending ID. For each: Move (pick random empty neighbor), Eat (gain energy, set grass to 0), Lose energy, Breed (if energy >= threshold, pick random empty neighbor, spawn child), Die (if energy <= 0).
3.  **Foxes:** Iterate foxes by ascending ID. For each: Move (prefer neighbor with rabbit, then empty neighbor), Eat (if rabbit present, remove it, gain energy), Lose energy, Breed (if energy >= threshold, pick random empty neighbor, spawn child), Die (if energy <= 0).
4.  **Advance:** Increment tick, record history point.

**Components:**
-   **Canvas:** Renders the grid, grass levels, rabbits (white), and foxes (red).
-   **Controls:** Seed input, speed slider, parameter sliders (rabbits0, foxes0, rabbitBreed, foxBreed, foxGain, grassMax), Play/Pause/Step/Reset buttons.
-   **Counters:** Display current tick, rabbit count, fox count, total grass.
-   **Chart:** SVG polyline chart showing population history.
-   **Lotka-Volterra Panel:** Inputs for ODE parameters, Run button, and SVG chart of the trajectory.
-   **Scenario Tools:** Textarea for JSON, Export/Load buttons, Error message.
-   **Presets:** List of saved scenarios with Load/Delete buttons.

The app is a single HTML file with embedded CSS and JS. It uses `mulberry32` for randomness and implements RK4 for the ODE solver.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ecosystem Lab</title>
    <style>
        :root {
            --bg: #f4f4f9;
            --panel-bg: #ffffff;
            --text: #333;
            --border: #ccc;
            --accent: #4a90d9;
            --grass-low: #226622;
            --grass-high: #44cc44;
            --rabbit: #f0f0f0;
            --fox: #dc5014;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: var(--bg);
            color: var(--text);
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        header {
            background: #222;
            color: #fff;
            padding: 8px 16px;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        header h1 { margin: 0; font-size: 16px; }
        header .seed-display { font-family: monospace; background: #333; padding: 2px 6px; border-radius: 4px; }

        #app {
            flex: 1;
            display: flex;
            overflow: hidden;
            position: relative;
        }

        .panel {
            background: var(--panel-bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 12px;
            display: flex;
            flex-direction: column;
            overflow: auto;
        }

        /* Layout */
        #panel-world {
            flex: 1;
            min-width: 360px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        #panel-side {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 10px;
            min-width: 300px;
        }

        @media (max-width: 700px) {
            #app { flex-direction: column; }
            #panel-world { min-width: auto; flex: 1; }
            #panel-side { min-width: auto; flex: 1; }
        }

        /* Canvas */
        #world-canvas {
            border: 1px solid #ddd;
            background: #fff;
            image-rendering: pixelated;
            margin: 0 auto;
            display: block;
        }

        /* Controls */
        .control-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 6px;
            font-size: 13px;
        }
        .control-row label { flex: 1; }
        .control-row input[type="range"] { flex: 2; }
        .control-row input[type="number"] { width: 60px; }
        .control-row input[type="text"] { flex: 1; }

        .btn-group {
            display: flex;
            gap: 6px;
            margin-top: 4px;
        }
        button {
            padding: 4px 10px;
            border: 1px solid var(--border);
            background: #fff;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
        }
        button:hover { background: #eee; }
        button:active { background: #ddd; }
        button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
        button.primary:hover { background: #357abd; }

        .counters {
            display: flex;
            gap: 12px;
            font-size: 13px;
            font-family: monospace;
            background: #f9f9f9;
            padding: 6px;
            border-radius: 4px;
            border: 1px solid #eee;
        }
        .counter-item span { font-weight: bold; }

        /* Chart */
        #chart-container {
            flex: 1;
            min-height: 150px;
            border: 1px solid #eee;
            border-radius: 4px;
            position: relative;
            background: #fff;
        }
        svg { width: 100%; height: 100%; display: block; }
        .chart-axis { stroke: #ccc; stroke-width: 1; }
        .chart-label { font-size: 10px; fill: #666; }
        .chart-line { fill: none; stroke-width: 2; }
        .chart-line-rabbits { stroke: #4a90d9; }
        .chart-line-foxes { stroke: #dc5014; }

        /* ODE Panel */
        #ode-panel {
            border-top: 1px solid #eee;
            padding-top: 10px;
        }
        .ode-inputs {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4px;
            margin-bottom: 8px;
        }
        .ode-inputs input { width: 100%; box-sizing: border-box; }

        /* Scenario */
        #scenario-area {
            border-top: 1px solid #eee;
            padding-top: 10px;
            font-size: 12px;
        }
        textarea {
            width: 100%;
            height: 60px;
            font-family: monospace;
            font-size: 11px;
            resize: none;
            box-sizing: border-box;
            border: 1px solid #ccc;
            border-radius: 4px;
            padding: 4px;
        }

        /* Presets */
        #presets-area {
            border-top: 1px solid #eee;
            padding-top: 10px;
            font-size: 12px;
        }
        #preset-list {
            display: flex;
            flex-direction: column;
            gap: 4px;
            max-height: 150px;
            overflow-y: auto;
        }
        .preset-item {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px;
            background: #f9f9f9;
            border-radius: 4px;
            font-size: 11px;
        }

        /* Announcer */
        #announcer {
            position: absolute;
            top: 10px;
            right: 10px;
            background: rgba(0,0,0,0.8);
            color: #fff;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            opacity: 0;
            transition: opacity 0.3s;
            pointer-events: none;
            z-index: 100;
        }
        #announcer.visible { opacity: 1; }

        /* Error */
        .error-msg {
            color: #d9534f;
            font-size: 11px;
            margin-top: 4px;
            min-height: 14px;
        }
    </style>
</head>
<body>

<header>
    <h1>Ecosystem Lab</h1>
    <span>Seed: <span id="seed-display" class="seed-display">42</span></span>
</header>

<div id="app">
    <div id="panel-world" class="panel">
        <canvas id="world-canvas" width="400" height="300"></canvas>
        
        <div class="counters">
            <div class="counter-item">Tick: <span id="count-tick">0</span></div>
            <div class="counter-item">Rabbits: <span id="count-rabbits">0</span></div>
            <div class="counter-item">Foxes: <span id="count-foxes">0</span></div>
            <div class="counter-item">Grass: <span id="count-grass">0</span></div>
        </div>

        <div class="control-row">
            <label for="seed">Seed:</label>
            <input type="number" id="seed" value="42" min="0" max="2147483647">
            <button id="btn-reset" data-testid="reset">Reset</button>
        </div>

        <div class="control-row">
            <label for="speed">Speed:</label>
            <input type="range" id="speed" min="1" max="60" value="10">
            <span id="speed-val">10</span> tps
        </div>

        <div class="btn-group">
            <button id="play" data-testid="play">Play</button>
            <button id="pause" data-testid="pause">Pause</button>
            <button id="step" data-testid="step">Step</button>
        </div>

        <div style="margin-top: 8px; font-size: 12px; font-weight: bold;">Parameters</div>
        
        <div class="control-row">
            <label for="param-rabbits0">Rabbits Start:</label>
            <input type="range" id="param-rabbits0" min="0" max="300" value="100">
            <span id="val-rabbits0">100</span>
        </div>
        <div class="control-row">
            <label for="param-foxes0">Foxes Start:</label>
            <input type="range" id="param-foxes0" min="0" max="60" value="6">
            <span id="val-foxes0">6</span>
        </div>
        <div class="control-row">
            <label for="param-rabbitBreed">Rabbit Breed:</label>
            <input type="range" id="param-rabbitBreed" min="2" max="40" value="12">
            <span id="val-rabbitBreed">12</span>
        </div>
        <div class="control-row">
            <label for="param-foxBreed">Fox Breed:</label>
            <input type="range" id="param-foxBreed" min="2" max="60" value="40">
            <span id="val-foxBreed">40</span>
        </div>
        <div class="control-row">
            <label for="param-foxGain">Fox Gain:</label>
            <input type="range" id="param-foxGain" min="1" max="30" value="4">
            <span id="val-foxGain">4</span>
        </div>
        <div class="control-row">
            <label for="param-grassMax">Grass Max:</label>
            <input type="range" id="param-grassMax" min="1" max="10" value="4">
            <span id="val-grassMax">4</span>
        </div>
    </div>

    <div id="panel-side" class="panel">
        <div id="chart-container">
            <svg id="chart" width="100%" height="100%">
                <!-- Polyline series will be injected here -->
            </svg>
        </div>

        <div id="ode-panel" class="panel">
            <div style="font-size:12px; font-weight:bold; margin-bottom:4px;">Lotka–Volterra</div>
            <div class="ode-inputs">
                <div><label for="ode-alpha">α</label><input type="number" id="ode-alpha" step="0.01" value="1.1"></div>
                <div><label for="ode-beta">β</label><input type="number" id="ode-beta" step="0.01" value="0.4"></div>
                <div><label for="ode-gamma">γ</label><input type="number" id="ode-gamma" step="0.01" value="0.4"></div>
                <div><label for="ode-delta">δ</label><input type="number" id="ode-delta" step="0.01" value="0.1"></div>
                <div><label for="ode-x0">x₀</label><input type="number" id="ode-x0" step="1" value="10"></div>
                <div><label for="ode-y0">y₀</label><input type="number" id="ode-y0" step="1" value="10"></div>
                <div><label for="ode-t">t</label><input type="number" id="ode-t" step="1" value="50"></div>
                <div><label for="ode-dt">dt</label><input type="number" id="ode-dt" step="0.01" value="0.01"></div>
            </div>
            <div class="btn-group">
                <button id="ode-run" data-testid="ode-run">Run ODE</button>
            </div>
            <div style="font-size:11px; margin-top:4px; display:flex; flex-wrap:wrap; gap:4px;">
                <span id="ode-result-x"></span>
                <span id="ode-result-y"></span>
                <span id="ode-result-eq"></span>
                <span id="ode-result-drift"></span>
            </div>
            <div id="ode-chart-container" style="height:120px; border:1px solid #eee; margin-top:4px; border-radius:4px; position:relative;">
                <svg id="ode-chart" width="100%" height="100%">
                    <!-- ODE Polyline series -->
                </svg>
            </div>
        </div>

        <div id="scenario-area" class="panel">
            <div style="font-size:12px; font-weight:bold; margin-bottom:4px;">Scenario</div>
            <textarea id="scenario-json" data-testid="scenario-json"></textarea>
            <div class="btn-group">
                <button id="scenario-export" data-testid="scenario-export">Export JSON</button>
                <button id="scenario-load" data-testid="scenario-load">Load JSON</button>
            </div>
            <div id="scenario-error" class="error-msg"></div>
        </div>

        <div id="presets-area" class="panel">
            <div style="font-size:12px; font-weight:bold; margin-bottom:4px;">Presets</div>
            <div id="preset-list" data-testid="preset-list"></div>
            <div style="margin-top:4px; display:flex; gap:4px;">
                <input type="text" id="preset-name" placeholder="Preset Name" style="flex:1;">
                <button id="preset-save" data-testid="preset-save">Save</button>
            </div>
        </div>
    </div>
</div>

<div id="announcer" aria-live="polite"></div>

<script>
/**
 * Ecosystem Lab
 * A single-file simulation of grass, rabbits, and foxes.
 */

// --- Constants & Defaults ---
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

// --- State ---
let state = {
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
    foxBreed: 40,
    seed: 42,
    rand: null,
    tick: 0,
    history: [],
    animals: [], // {id, type, x, y, energy}
    running: false,
    lastFrameTime: 0,
    accumulator: 0,
    speed: 10,
    canvas: null,
    ctx: null
};

// --- RNG ---
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

// --- Core Logic ---

function reset(seed, params) {
    // Merge params over defaults
    const p = { ...DEFAULTS, ...params };
    
    // Update state with merged params
    state.width = p.width;
    state.height = p.height;
    state.grassMax = p.grassMax;
    state.rabbits0 = p.rabbits0;
    state.foxes0 = p.foxes0;
    state.rabbitStart = p.rabbitStart;
    state.rabbitGain = p.rabbitGain;
    state.rabbitCost = p.rabbitCost;
    state.rabbitBreed = p.rabbitBreed;
    state.foxStart = p.foxStart;
    state.foxGain = p.foxGain;
    state.foxCost = p.foxCost;
    state.foxBreed = p.foxBreed;
    state.seed = seed;
    state.rand = mulberry32(seed);
    state.tick = 0;
    state.history = [];
    state.animals = [];
    state.running = false;
    state.accumulator = 0;
    state.lastFrameTime = 0;

    // Build grid
    const grid = new Array(state.width * state.height).fill(0);

    // 1. Grass
    for (let y = 0; y < state.height; y++) {
        for (let x = 0; x < state.width; x++) {
            grid[y * state.width + x] = Math.floor(state.rand() * (state.grassMax + 1));
        }
    }

    // 2. Rabbits
    const rabbitCells = [];
    for (let y = 0; y < state.height; y++) {
        for (let x = 0; x < state.width; x++) {
            if (!state.animals.find(a => a.type === 'rabbit' && a.x === x && a.y === y)) {
                rabbitCells.push({x, y});
            }
        }
    }
    for (let i = 0; i < state.rabbits0; i++) {
        if (rabbitCells.length === 0) break;
        const idx = Math.floor(state.rand() * rabbitCells.length);
        const cell = rabbitCells.splice(idx, 1)[0];
        state.animals.push({
            id: state.idCounter++,
            type: 'rabbit',
            x: cell.x,
            y: cell.y,
            energy: state.rabbitStart
        });
    }

    // 3. Foxes
    const foxCells = [];
    for (let y = 0; y < state.height; y++) {
        for (let x = 0; x < state.width; x++) {
            if (!state.animals.find(a => a.type === 'fox' && a.x === x && a.y === y)) {
                foxCells.push({x, y});
            }
        }
    }
    for (let i = 0; i < state.foxes0; i++) {
        if (foxCells.length === 0) break;
        const idx = Math.floor(state.rand() * foxCells.length);
        const cell = foxCells.splice(idx, 1)[0];
        state.animals.push({
            id: state.idCounter++,
            type: 'fox',
            x: cell.x,
            y: cell.y,
            energy: state.foxStart
        });
    }

    // 4. Record history
    state.history.push({
        tick: 0,
        rabbits: state.animals.filter(a => a.type === 'rabbit').length,
        foxes: state.animals.filter(a => a.type === 'fox').length,
        grass: grid.reduce((a, b) => a + b, 0)
    });

    // 5. Redraw
    draw();
    updateCounters();
    updateChart();
    updatePresets();
    announce(`Tick 0: ${state.history[0].rabbits} rabbits, ${state.history[0].foxes} foxes`);
}

function step() {
    if (!state.running) return;

    // Run one tick
    runTick();
    
    // Update UI
    draw();
    updateCounters();
    updateChart();
    updateOdeChart();
    updatePresets();
    
    // Check if finished (optional, but good for loop)
    // For now, we just let the loop run.
}

function runTick() {
    state.tick++;

    // 1. Grass
    for (let y = 0; y < state.height; y++) {
        for (let x = 0; x < state.width; x++) {
            const idx = y * state.width + x;
            state.grid[idx] = Math.min(state.grassMax, state.grid[idx] + 1);
        }
    }

    // 2. Rabbits
    // Sort by ascending ID
    const rabbits = state.animals.filter(a => a.type === 'rabbit').sort((a, b) => a.id - b.id);
    
    for (const rabbit of rabbits) {
        // Move
        const neighbors = getNeighbors(rabbit.x, rabbit.y);
        const emptyNeighbors = neighbors.filter(n => {
            const idx = n.y * state.width + n.x;
            return !state.animals.find(a => a.type === 'rabbit' && a.x === n.x && a.y === n.y);
        });
        if (emptyNeighbors.length > 0) {
            const idx = Math.floor(state.rand() * emptyNeighbors.length);
            rabbit.x = emptyNeighbors[idx].x;
            rabbit.y = emptyNeighbors[idx].y;
        }

        // Eat
        const idx = rabbit.y * state.width + rabbit.x;
        const gain = state.rabbitGain * state.grid[idx];
        rabbit.energy += gain;
        state.grid[idx] = 0;

        // Cost
        rabbit.energy -= state.rabbitCost;

        // Breed
        if (rabbit.energy >= state.rabbitBreed) {
            const neighbors = getNeighbors(rabbit.x, rabbit.y);
            const emptyNeighbors = neighbors.filter(n => {
                return !state.animals.find(a => a.type === 'rabbit' && a.x === n.x && a.y === n.y);
            });
            if (emptyNeighbors.length > 0) {
                const idx = Math.floor(state.rand() * emptyNeighbors.length);
                const spot = emptyNeighbors[idx];
                const childEnergy = Math.floor(rabbit.energy / 2);
                rabbit.energy -= childEnergy;
                state.animals.push({
                    id: state.idCounter++,
                    type: 'rabbit',
                    x: spot.x,
                    y: spot.y,
                    energy: childEnergy
                });
            }
        }

        // Die
        if (rabbit.energy <= 0) {
            state.animals = state.animals.filter(a => a.id !== rabbit.id);
        }
    }

    // 3. Foxes
    const foxes = state.animals.filter(a => a.type === 'fox').sort((a, b) => a.id - b.id);

    for (const fox of foxes) {
        // Move
        // Prefer neighbor with rabbit and no fox
        const neighbors = getNeighbors(fox.x, fox.y);
        const rabbitNeighbors = neighbors.filter(n => {
            const idx = n.y * state.width + n.x;
            const hasRabbit = state.animals.find(a => a.type === 'rabbit' && a.x === n.x && a.y === n.y);
            const hasFox = state.animals.find(a => a.type === 'fox' && a.x === n.x && a.y === n.y);
            return hasRabbit && !hasFox;
        });

        if (rabbitNeighbors.length > 0) {
            const idx = Math.floor(state.rand() * rabbitNeighbors.length);
            fox.x = rabbitNeighbors[idx].x;
            fox.y = rabbitNeighbors[idx].y;
        } else {
            // Otherwise empty neighbor
            const emptyNeighbors = neighbors.filter(n => {
                return !state.animals.find(a => a.type === 'fox' && a.x === n.x && a.y === n.y);
            });
            if (emptyNeighbors.length > 0) {
                const idx = Math.floor(state.rand() * emptyNeighbors.length);
                fox.x = emptyNeighbors[idx].x;
                fox.y = emptyNeighbors[idx].y;
            }
        }

        // Eat
        const idx = fox.y * state.width + fox.x;
        const hasRabbit = state.animals.find(a => a.type === 'rabbit' && a.x === fox.x && a.y === fox.y);
        if (hasRabbit) {
            state.animals = state.animals.filter(a => a.id !== hasRabbit.id);
            fox.energy += state.foxGain;
        }

        // Cost
        fox.energy -= state.foxCost;

        // Breed
        if (fox.energy >= state.foxBreed) {
            const neighbors = getNeighbors(fox.x, fox.y);
            const emptyNeighbors = neighbors.filter(n => {
                return !state.animals.find(a => a.type === 'fox' && a.x === n.x && a.y === n.y);
            });
            if (emptyNeighbors.length > 0) {
                const idx = Math.floor(state.rand() * emptyNeighbors.length);
                const spot = emptyNeighbors[idx];
                const childEnergy = Math.floor(fox.energy / 2);
                fox.energy -= childEnergy;
                state.animals.push({
                    id: state.idCounter++,
                    type: 'fox',
                    x: spot.x,
                    y: spot.y,
                    energy: childEnergy
                });
            }
        }

        // Die
        if (fox.energy <= 0) {
            state.animals = state.animals.filter(a => a.id !== fox.id);
        }
    }

    // 4. Record
    state.history.push({
        tick: state.tick,
        rabbits: state.animals.filter(a => a.type === 'rabbit').length,
        foxes: state.animals.filter(a => a.type === 'fox').length,
        grass: state.grid.reduce((a, b) => a + b, 0)
    });
}

function getNeighbors(x, y) {
    const neighbors = [];
    // Up, Right, Down, Left
    if (y > 0) neighbors.push({x, y: y - 1});
    if (x < state.width - 1) neighbors.push({x: x + 1, y});
    if (y < state.height - 1) neighbors.push({x, y: y + 1});
    if (x > 0) neighbors.push({x: x - 1, y});
    return neighbors;
}

// --- Rendering ---

function draw() {
    const cvs = document.getElementById('world-canvas');
    const ctx = cvs.getContext('2d');
    const cellW = 10;
    const cellH = 10;
    const w = state.width * cellW;
    const h = state.height * cellH;
    
    // Set backing size
    cvs.width = w;
    cvs.height = h;

    // Clear
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);

    // Draw Grass
    for (let y = 0; y < state.height; y++) {
        for (let x = 0; x < state.width; x++) {
            const idx = y * state.width + x;
            const g = state.grid[idx];
            const G = 60 + Math.round(160 * g / state.grassMax);
            ctx.fillStyle = `rgb(30, ${G}, 30)`;
            ctx.fillRect(x * cellW, y * cellH, cellW, cellH);
        }
    }

    // Draw Animals
    // Sort by y then x for simple painter's algo (though order doesn't strictly matter for non-overlapping, 
    // but foxes are drawn over rabbits in same cell, so draw rabbits first)
    const sorted = [...state.animals].sort((a, b) => {
        if (a.y !== b.y) return a.y - b.y;
        if (a.x !== b.x) return a.x - b.x;
        return a.type === 'rabbit' ? -1 : 1; // rabbits first
    });

    for (const a of sorted) {
        const cx = a.x * cellW + 5;
        const cy = a.y * cellH + 5;
        ctx.fillStyle = a.type === 'rabbit' ? 'rgb(240, 240, 240)' : 'rgb(220, 80, 20)';
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();
    }
}

function updateCounters() {
    document.getElementById('count-tick').textContent = state.tick;
    document.getElementById('count-rabbits').textContent = state.history[state.history.length-1].rabbits;
    document.getElementById('count-foxes').textContent = state.history[state.history.length-1].foxes;
    document.getElementById('count-grass').textContent = state.history[state.history.length-1].grass;
}

function updateChart() {
    const svg = document.getElementById('chart');
    const h = svg.querySelector('svg').clientHeight;
    const w = svg.querySelector('svg').clientWidth;
    
    // Remove old lines
    const old = svg.querySelectorAll('polyline');
    old.forEach(el => el.remove());

    if (state.history.length === 0) return;

    // Scale Y
    const maxRabbits = Math.max(...state.history.map(h => h.rabbits), 1);
    const maxFoxes = Math.max(...state.history.map(h => h.foxes), 1);
    const maxGrass = Math.max(...state.history.map(h => h.grass), 1);

    const scaleR = (val) => h - (val / maxRabbits) * (h - 20);
    const scaleF = (val) => h - (val / maxFoxes) * (h - 20);
    const scaleG = (val) => h - (val / maxGrass) * (h - 20);

    // Rabbits
    let d = "";
    state.history.forEach((h, i) => {
        const x = i * (w / (state.history.length - 1 || 1));
        const y = scaleR(h.rabbits);
        d += `${i === 0 ? 'M' : 'L'} ${x} ${y} `;
    });
    const pR = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pR.setAttribute("data-testid", "series-rabbits");
    pR.setAttribute("points", d);
    pR.setAttribute("class", "chart-line chart-line-rabbits");
    svg.querySelector('svg').appendChild(pR);

    // Foxes
    d = "";
    state.history.forEach((h, i) => {
        const x = i * (w / (state.history.length - 1 || 1));
        const y = scaleF(h.foxes);
        d += `${i === 0 ? 'M' : 'L'} ${x} ${y} `;
    });
    const pF = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pF.setAttribute("data-testid", "series-foxes");
    pF.setAttribute("points", d);
    pF.setAttribute("class", "chart-line chart-line-foxes");
    svg.querySelector('svg').appendChild(pF);

    // Labels
    const textX = document.createElementNS("http://www.w3.org/2000/svg", "text");
    textX.setAttribute("x", "5");
    textX.setAttribute("y", h - 5);
    textX.textContent = "tick";
    textX.setAttribute("class", "chart-label");
    svg.querySelector('svg').appendChild(textX);

    const textY = document.createElementNS("http://www.w3.org/2000/svg", "text");
    textY.setAttribute("x", w - 5);
    textY.setAttribute("y", "5");
    textY.textContent = "count";
    textY.setAttribute("class", "chart-label");
    svg.querySelector('svg').appendChild(textY);
}

// --- ODE ---

function odeRun() {
    const alpha = parseFloat(document.getElementById('ode-alpha').value);
    const beta = parseFloat(document.getElementById('ode-beta').value);
    const gamma = parseFloat(document.getElementById('ode-gamma').value);
    const delta = parseFloat(document.getElementById('ode-delta').value);
    const x0 = parseFloat(document.getElementById('ode-x0').value);
    const y0 = parseFloat(document.getElementById('ode-y0').value);
    const t = parseFloat(document.getElementById('ode-t').value);
    const dt = parseFloat(document.getElementById('ode-dt').value);

    let x = x0;
    let y = y0;

    const steps = Math.round(t / dt);
    const h = dt;

    for (let i = 0; i < steps; i++) {
        const k1x = alpha * x - beta * x * y;
        const k1y = delta * x * y - gamma * y;

        const k2x = alpha * (x + 0.5 * h * k1x) - beta * (x + 0.5 * h * k1x) * (y + 0.5 * h * k1y);
        const k2y = delta * (x + 0.5 * h * k1x) * (y + 0.5 * h * k1y) - gamma * (y + 0.5 * h * k1y);

        const k3x = alpha * (x + 0.5 * h * k2x) - beta * (x + 0.5 * h * k2x) * (y + 0.5 * h * k2y);
        const k3y = delta * (x + 0.5 * h * k2x) * (y + 0.5 * h * k2y) - gamma * (y + 0.5 * h * k2y);

        const k4x = alpha * (x + h * k3x) - beta * (x + h * k3x) * (y + h * k3y);
        const k4y = delta * (x + h * k3x) * (y + h * k3y) - gamma * (y + h * k3y);

        x += h / 6.0 * (k1x + 2 * k2x + 2 * k3x + k4x);
        y += h / 6.0 * (k1y + 2 * k2y + 2 * k3y + k4y);
    }

    const eqX = gamma / delta;
    const eqY = alpha / beta;
    const VStart = delta * x0 - gamma * Math.log(x0) + beta * y0 - alpha * Math.log(y0);
    const VEnd = delta * x - gamma * Math.log(x) + beta * y - alpha * Math.log(y);
    const drift = Math.abs(VEnd - VStart);

    document.getElementById('ode-result-x').textContent = `x = ${x.toFixed(8)}`;
    document.getElementById('ode-result-y').textContent = `y = ${y.toFixed(8)}`;
    document.getElementById('ode-result-eq').textContent = `Eq: (${eqX.toFixed(4)}, ${eqY.toFixed(4)})`;
    document.getElementById('ode-result-drift').textContent = `Drift: ${drift.toFixed(6)}`;

    drawOdeChart(x, y, steps, dt);
}

function drawOdeChart(xEnd, yEnd, steps, dt) {
    const svg = document.getElementById('ode-chart');
    const container = document.getElementById('ode-chart-container');
    const w = container.clientWidth;
    const h = container.clientHeight;

    // Clear
    svg.innerHTML = '';

    // Points
    let x = parseFloat(document.getElementById('ode-x0').value);
    let y = parseFloat(document.getElementById('ode-y0').value);
    const alpha = parseFloat(document.getElementById('ode-alpha').value);
    const beta = parseFloat(document.getElementById('ode-beta').value);
    const gamma = parseFloat(document.getElementById('ode-gamma').value);
    const delta = parseFloat(document.getElementById('ode-delta').value);
    const tEnd = parseFloat(document.getElementById('ode-t').value);
    const dt = parseFloat(document.getElementById('ode-dt').value);

    const points = [];
    for (let i = 0; i <= Math.round(tEnd / dt); i++) {
        const t = i * dt;
        const k1x = alpha * x - beta * x * y;
        const k1y = delta * x * y - gamma * y;
        const k2x = alpha * (x + 0.5 * dt * k1x) - beta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y);
        const k2y = delta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y) - gamma * (y + 0.5 * dt * k1y);
        const k3x = alpha * (x + 0.5 * dt * k2x) - beta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y);
        const k3y = delta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y) - gamma * (y + 0.5 * dt * k2y);
        const k4x = alpha * (x + dt * k3x) - beta * (x + dt * k3x) * (y + dt * k3y);
        const k4y = delta * (x + dt * k3x) * (y + dt * k3y) - gamma * (y + dt * k3y);
        x += dt / 6.0 * (k1x + 2 * k2x + 2 * k3x + k4x);
        y += dt / 6.0 * (k1y + 2 * k2y + 2 * k3y + k4y);
        points.push({x, y});
    }

    const maxX = Math.max(...points.map(p => p.x), 1);
    const maxY = Math.max(...points.map(p => p.y), 1);
    const minX = Math.min(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y));

    const scaleX = (x) => 20 + (x - minX) / (maxX - minX) * (w - 40);
    const scaleY = (y) => h - 20 - (y - minY) / (maxY - minY) * (h - 40);

    let d = "";
    points.forEach((p, i) => {
        const px = scaleX(p.x);
        const py = scaleY(p.y);
        d += `${i === 0 ? 'M' : 'L'} ${px} ${py} `;
    });

    const pX = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pX.setAttribute("data-testid", "ode-series-x");
    pX.setAttribute("points", d);
    pX.setAttribute("stroke", "blue");
    pX.setAttribute("fill", "none");
    svg.appendChild(pX);

    d = "";
    points.forEach((p, i) => {
        const px = scaleX(p.x);
        const py = scaleY(p.y);
        d += `${i === 0 ? 'M' : 'L'} ${px} ${py} `;
    });

    const pY = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pY.setAttribute("data-testid", "ode-series-y");
    pY.setAttribute("points", d);
    pY.setAttribute("stroke", "red");
    pY.setAttribute("fill", "none");
    svg.appendChild(pY);
}

// --- UI Events ---

document.getElementById('seed').addEventListener('input', (e) => {
    document.getElementById('seed-display').textContent = e.target.value;
});

document.getElementById('btn-reset').addEventListener('click', () => {
    const seed = parseInt(document.getElementById('seed').value) || 42;
    reset(seed, {});
});

document.getElementById('speed').addEventListener('input', (e) => {
    state.speed = parseInt(e.target.value);
    document.getElementById('speed-val').textContent = state.speed;
});

const playBtn = document.getElementById('play');
const pauseBtn = document.getElementById('pause');

playBtn.addEventListener('click', () => {
    state.running = true;
    state.lastFrameTime = performance.now();
    state.accumulator = 0;
    playBtn.disabled = true;
    pauseBtn.disabled = false;
});

pauseBtn.addEventListener('click', () => {
    state.running = false;
    playBtn.disabled = false;
    pauseBtn.disabled = true;
    announce(`Tick ${state.tick}: ${state.history[state.history.length-1].rabbits} rabbits, ${state.history[state.history.length-1].foxes} foxes`);
});

document.getElementById('step').addEventListener('click', () => {
    runTick();
    draw();
    updateCounters();
    updateChart();
});

// Parameter Sliders
const paramInputs = ['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax'];
paramInputs.forEach(id => {
    const el = document.getElementById(`param-${id}`);
    const valEl = document.getElementById(`val-${id}`);
    el.addEventListener('input', (e) => {
        valEl.textContent = e.target.value;
    });
});

// --- Loop ---
function loop() {
    if (state.running) {
        const now = performance.now();
        const dt = now - state.lastFrameTime;
        state.lastFrameTime = now;
        state.accumulator += dt;

        while (state.accumulator >= 1000 / state.speed) {
            step();
            state.accumulator -= 1000 / state.speed;
        }
    }
    requestAnimationFrame(loop);
}

// --- Scenario ---
document.getElementById('scenario-export').addEventListener('click', () => {
    const obj = {
        version: 1,
        seed: state.seed,
        params: {
            width: state.width,
            height: state.height,
            grassMax: state.grassMax,
            rabbits0: state.rabbits0,
            foxes0: state.foxes0,
            rabbitStart: state.rabbitStart,
            rabbitGain: state.rabbitGain,
            rabbitCost: state.rabbitCost,
            rabbitBreed: state.rabbitBreed,
            foxStart: state.foxStart,
            foxGain: state.foxGain,
            foxCost: state.foxCost,
            foxBreed: state.foxBreed
        }
    };
    document.getElementById('scenario-json').value = JSON.stringify(obj, null, 2);
});

document.getElementById('scenario-load').addEventListener('click', () => {
    const text = document.getElementById('scenario-json').value;
    const errorEl = document.getElementById('scenario-error');
    try {
        const obj = JSON.parse(text);
        if (obj.version !== 1) throw new Error("Invalid version");
        if (typeof obj.seed !== 'number' || !Number.isInteger(obj.seed)) throw new Error("Seed must be integer");
        reset(obj.seed, obj.params);
        errorEl.textContent = "";
    } catch (e) {
        errorEl.textContent = e.message;
    }
});

// --- Presets ---
function updatePresets() {
    const list = document.getElementById('preset-list');
    list.innerHTML = '';
    const stored = localStorage.getItem("ecolab.presets");
    if (!stored) return;
    try {
        const presets = JSON.parse(stored);
        for (const [name, data] of Object.entries(presets)) {
            const item = document.createElement('div');
            item.className = 'preset-item';
            item.innerHTML = `
                <span>${name}</span>
                <button class="btn-load" data-name="${name}">Load</button>
                <button class="btn-del" data-name="${name}">Del</button>
            `;
            item.querySelector('.btn-load').addEventListener('click', () => {
                reset(data.seed, data.params);
            });
            item.querySelector('.btn-del').addEventListener('click', () => {
                const newPresets = {};
                for (const k of Object.keys(presets)) {
                    if (k !== name) newPresets[k] = presets[k];
                }
                localStorage.setItem("ecolab.presets", JSON.stringify(newPresets));
                updatePresets();
            });
            list.appendChild(item);
        }
    } catch (e) {
        // ignore
    }
}

document.getElementById('preset-save').addEventListener('click', () => {
    const name = document.getElementById('preset-name').value.trim();
    if (!name) return;
    const stored = localStorage.getItem("ecolab.presets") || {};
    stored[name] = {
        seed: state.seed,
        params: {
            width: state.width,
            height: state.height,
            grassMax: state.grassMax,
            rabbits0: state.rabbits0,
            foxes0: state.foxes0,
            rabbitStart: state.rabbitStart,
            rabbitGain: state.rabbitGain,
            rabbitCost: state.rabbitCost,
            rabbitBreed: state.rabbitBreed,
            foxStart: state.foxStart,
            foxGain: state.foxGain,
            foxCost: state.foxCost,
            foxBreed: state.foxBreed
        }
    };
    localStorage.setItem("ecolab.presets", JSON.stringify(stored));
    updatePresets();
});

// --- Keyboard ---
document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const isInput = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA';
    const isButton = active.tagName === 'BUTTON';
    
    if (isInput || isButton) return;

    if (e.code === 'Space') {
        if (state.running) {
            state.running = false;
            playBtn.disabled = false;
            pauseBtn.disabled = true;
            announce(`Tick ${state.tick}: ${state.history[state.history.length-1].rabbits} rabbits, ${state.history[state.history.length-1].foxes} foxes`);
        } else {
            state.running = true;
            playBtn.disabled = true;
            pauseBtn.disabled = false;
        }
    } else if (e.key.toLowerCase() === 's') {
        step();
    } else if (e.key.toLowerCase() === 'r') {
        reset(state.seed, {});
    }
});

// --- Init ---
reset(42, {});
requestAnimationFrame(loop);

</script>
</body>
</html>
```