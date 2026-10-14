## Plan

The application is a single HTML file containing CSS and JavaScript. It implements a discrete grid-based ecosystem simulation (grass, rabbits, foxes) with a custom random number generator, a Lotka-Volterra ODE integrator, and a full API exposed via `window.lab`.

**Data Model:**
- **State:** A 2D grid of cells (grass level 0–4), a list of Rabbit objects, and a list of Fox objects.
- **Tick:** A discrete time step.
- **History:** An array of snapshots `{tick, rabbits, foxes, grass}`.
- **Ode:** A separate state object for the Lotka-Volterra integrator.

**Tick Order:**
1. **Grass:** Grows.
2. **Rabbits:** Move, Eat, Lose Energy, Breed, Die.
3. **Foxes:** Move, Eat, Lose Energy, Breed, Die.
4. **Tick Increment:** Increment tick counter, record history.

**Components:**
- **Canvas:** Renders the grid, grass, rabbits, and foxes.
- **Chart:** An SVG overlay showing population history.
- **Controls:** Buttons for Play/Pause/Step/Reset, inputs for Seed/Speed, sliders for parameters.
- **Ode Panel:** Inputs for the Lotka-Volterra parameters and a button to run the RK4 integration.
- **Presets:** LocalStorage management for saving/loading scenarios.

**Rendering:**
- The canvas is rendered at a fixed internal resolution (width * 10, height * 10) and scaled via CSS.
- Grass is colored by height. Rabbits are white shapes; foxes are red shapes drawn over rabbits.

**API:**
- `window.lab` exposes `reset`, `step`, `counts`, `tick`, `cell`, `history`, `ode`, `exportCSV`, `exportScenario`, `loadScenario`.

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
            --accent-hover: #357abd;
            --danger: #e74c3c;
            --success: #27ae60;
            --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }

        body {
            margin: 0;
            padding: 0;
            font-family: var(--font);
            background: var(--bg);
            color: var(--text);
            height: 100vh;
            display: flex;
            flex-direction: column;
            box-sizing: border-box;
            overflow: hidden;
        }

        header {
            background: #2c3e50;
            color: #fff;
            padding: 0.5rem 1rem;
            font-size: 1.1rem;
            font-weight: bold;
            display: flex;
            align-items: center;
            gap: 1rem;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            z-index: 10;
        }

        .main-container {
            flex: 1;
            display: flex;
            flex-direction: row;
            overflow: hidden;
        }

        .panel-world {
            flex: 1;
            display: flex;
            flex-direction: column;
            padding: 1rem;
            gap: 1rem;
            overflow-y: auto;
            min-width: 360px;
        }

        .panel-side {
            flex: 1;
            display: flex;
            flex-direction: column;
            padding: 1rem;
            gap: 1rem;
            overflow-y: auto;
            min-width: 300px;
            border-left: 1px solid var(--border);
        }

        @media (max-width: 700px) {
            .main-container {
                flex-direction: column;
            }
            .panel-side {
                border-left: none;
                border-top: 1px solid var(--border);
                min-width: 0;
            }
        }

        .canvas-container {
            background: #fff;
            border: 1px solid var(--border);
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            position: relative;
        }

        canvas {
            display: block;
            width: 100%;
            height: auto;
            border-radius: 4px;
        }

        .controls-row {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
            align-items: center;
        }

        .counter-row {
            display: flex;
            gap: 1rem;
            font-size: 0.9rem;
            font-variant-numeric: tabular-nums;
        }

        .counter-item {
            background: #eef;
            padding: 0.2rem 0.6rem;
            border-radius: 4px;
            border: 1px solid #ccd;
            font-size: 0.85rem;
        }

        .control-group {
            background: var(--panel-bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 0.8rem;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }

        .control-group h3 {
            margin: 0 0 0.5rem 0;
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #555;
            border-bottom: 1px solid #eee;
            padding-bottom: 0.3rem;
        }

        .input-row {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-bottom: 0.5rem;
        }

        .input-row label {
            font-size: 0.85rem;
            flex: 1;
        }

        input[type="number"], input[type="text"], textarea {
            width: 100%;
            padding: 0.4rem;
            border: 1px solid #ccc;
            border-radius: 4px;
            font-family: inherit;
            font-size: 0.9rem;
            box-sizing: border-box;
        }

        input[type="range"] {
            width: 100%;
            margin-top: 0.2rem;
        }

        button {
            padding: 0.4rem 0.8rem;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9rem;
            font-weight: 500;
            transition: background 0.1s, transform 0.05s;
            background: #eee;
            color: #333;
            border: 1px solid #ccc;
        }

        button:hover {
            background: #ddd;
        }

        button:active {
            transform: translateY(1px);
        }

        button.primary {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
        }

        button.primary:hover {
            background: var(--accent-hover);
        }

        button.danger {
            background: var(--danger);
            color: white;
            border-color: var(--danger);
        }

        button.danger:hover {
            background: #c0392b;
        }

        .slider-label {
            display: flex;
            justify-content: space-between;
            font-size: 0.8rem;
            margin-bottom: 0.2rem;
        }

        .slider-value {
            font-weight: bold;
            color: var(--accent);
        }

        .chart-container {
            background: #fff;
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 0.5rem;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }

        .chart-title {
            font-size: 0.8rem;
            font-weight: bold;
            margin-bottom: 0.3rem;
            color: #555;
        }

        .error-msg {
            color: var(--danger);
            font-size: 0.85rem;
            margin-top: 0.2rem;
            min-height: 1.2em;
        }

        .preset-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.4rem;
            background: #f9f9f9;
            border: 1px solid #eee;
            border-radius: 4px;
            margin-bottom: 0.3rem;
            font-size: 0.85rem;
        }

        .preset-name {
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-right: 0.5rem;
        }

        .preset-actions {
            display: flex;
            gap: 0.2rem;
        }

        .preset-actions button {
            padding: 0.2rem 0.4rem;
            font-size: 0.75rem;
        }

        .announcer {
            position: absolute;
            left: -9999px;
            width: 1px;
            height: 1px;
            overflow: hidden;
        }

        .legend {
            display: flex;
            gap: 1rem;
            font-size: 0.75rem;
            margin-top: 0.2rem;
        }
        .legend-item {
            display: flex;
            align-items: center;
            gap: 0.3rem;
        }
        .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
        }
    </style>
</head>
<body>

<header>
    <span>Ecosystem Lab</span>
    <span style="font-size: 0.8rem; opacity: 0.8;">v1.0</span>
</header>

<div class="main-container">
    <div class="panel-world">
        <div class="canvas-container">
            <canvas data-testid="world" width="400" height="300"></canvas>
        </div>

        <div class="controls-row">
            <button data-testid="play" class="primary">Play</button>
            <button data-testid="pause">Pause</button>
            <button data-testid="step">Step</button>
            <button data-testid="reset">Reset</button>
            <input type="number" id="seed-input" data-testid="seed" value="42" style="width: 60px;">
            <label for="speed-slider" style="font-size: 0.8rem;">Speed</label>
            <input type="range" id="speed-slider" data-testid="speed" min="1" max="60" value="10">
            <span id="speed-val" style="font-size: 0.8rem;">10</span>
        </div>

        <div class="counter-row">
            <div class="counter-item">Tick: <span data-testid="tick">0</span></div>
            <div class="counter-item">Rabbits: <span data-testid="count-rabbits">0</span></div>
            <div class="counter-item">Foxes: <span data-testid="count-foxes">0</span></div>
            <div class="counter-item">Grass: <span data-testid="count-grass">0</span></div>
        </div>

        <div class="control-group">
            <h3>Parameters</h3>
            
            <div class="input-row">
                <label for="param-rabbits0">Rabbits Start</label>
                <input type="number" id="param-rabbits0" data-testid="param-rabbits0" min="0" max="300" value="100">
            </div>
            <div class="input-row">
                <label for="param-foxes0">Foxes Start</label>
                <input type="number" id="param-foxes0" data-testid="param-foxes0" min="0" max="60" value="6">
            </div>
            <div class="input-row">
                <label for="param-rabbitBreed">Rabbit Breed</label>
                <input type="number" id="param-rabbitBreed" data-testid="param-rabbitBreed" min="2" max="40" value="12">
            </div>
            <div class="input-row">
                <label for="param-foxBreed">Fox Breed</label>
                <input type="number" id="param-foxBreed" data-testid="param-foxBreed" min="2" max="60" value="40">
            </div>
            <div class="input-row">
                <label for="param-foxGain">Fox Gain</label>
                <input type="number" id="param-foxGain" data-testid="param-foxGain" min="1" max="30" value="4">
            </div>
            <div class="input-row">
                <label for="param-grassMax">Grass Max</label>
                <input type="number" id="param-grassMax" data-testid="param-grassMax" min="1" max="10" value="4">
            </div>
        </div>
    </div>

    <div class="panel-side">
        <div class="chart-container">
            <div class="chart-title">Population History</div>
            <svg data-testid="chart" width="100%" height="200" viewBox="0 0 300 200" preserveAspectRatio="none">
                <!-- Axes -->
                <line x1="0" y1="200" x2="300" y2="200" stroke="#ccc" stroke-width="1"/>
                <line x1="0" y1="0" x2="0" y2="200" stroke="#ccc" stroke-width="1"/>
                <text x="290" y="195" font-size="10" fill="#999">tick</text>
                <text x="5" y="10" font-size="10" fill="#999" transform="rotate(-90 5,10)">count</text>
                <!-- Series -->
                <polyline data-testid="series-rabbits" fill="none" stroke="#27ae60" stroke-width="2" />
                <polyline data-testid="series-foxes" fill="none" stroke="#e74c3c" stroke-width="2" />
            </svg>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#27ae60"></div>Rabbits</div>
                <div class="legend-item"><div class="dot" style="background:#e74c3c"></div>Foxes</div>
            </div>
        </div>

        <div class="control-group">
            <h3>Lotka-Volterra</h3>
            <div class="input-row">
                <label for="ode-alpha">α</label>
                <input type="number" id="ode-alpha" data-testid="ode-alpha" value="1.1" step="0.1">
            </div>
            <div class="input-row">
                <label for="ode-beta">β</label>
                <input type="number" id="ode-beta" data-testid="ode-beta" value="0.4" step="0.1">
            </div>
            <div class="input-row">
                <label for="ode-gamma">γ</label>
                <input type="number" id="ode-gamma" data-testid="ode-gamma" value="0.4" step="0.1">
            </div>
            <div class="input-row">
                <label for="ode-delta">δ</label>
                <input type="number" id="ode-delta" data-testid="ode-delta" value="0.1" step="0.1">
            </div>
            <div class="input-row">
                <label for="ode-x0">x₀</label>
                <input type="number" id="ode-x0" data-testid="ode-x0" value="10">
            </div>
            <div class="input-row">
                <label for="ode-y0">y₀</label>
                <input type="number" id="ode-y0" data-testid="ode-y0" value="10">
            </div>
            <div class="input-row">
                <label for="ode-t">T</label>
                <input type="number" id="ode-t" data-testid="ode-t" value="50" step="1">
            </div>
            <div class="input-row">
                <label for="ode-dt">dt</label>
                <input type="number" id="ode-dt" data-testid="ode-dt" value="0.01" step="0.01">
            </div>
            <button data-testid="ode-run" class="primary">Run ODE</button>
            <div style="font-size: 0.8rem; margin-top: 0.5rem;">
                Final: x=<span id="ode-x"></span> y=<span id="ode-y"></span><br>
                Eq: x=γ/δ=<span id="ode-eq-x"></span> y=α/β=<span id="ode-eq-y"></span><br>
                Drift: <span id="ode-drift"></span>
            </div>
            <svg data-testid="ode-chart" width="100%" height="120" viewBox="0 0 300 120" preserveAspectRatio="none" style="margin-top:0.5rem;">
                <line x1="0" y1="120" x2="300" y2="120" stroke="#ccc" stroke-width="1"/>
                <line x1="0" y1="0" x2="0" y2="120" stroke="#ccc" stroke-width="1"/>
                <polyline data-testid="ode-series-x" fill="none" stroke="#27ae60" stroke-width="2" />
                <polyline data-testid="ode-series-y" fill="none" stroke="#e74c3c" stroke-width="2" />
            </svg>
        </div>

        <div class="control-group">
            <h3>Scenario</h3>
            <textarea id="scenario-json" data-testid="scenario-json" rows="4" style="font-family: monospace; font-size: 0.8rem; margin-bottom: 0.5rem;"></textarea>
            <div style="display:flex; gap:0.5rem;">
                <button data-testid="scenario-export">Export JSON</button>
                <button data-testid="scenario-load">Load JSON</button>
            </div>
            <div id="scenario-error" class="error-msg"></div>
        </div>

        <div class="control-group">
            <h3>Presets</h3>
            <div class="input-row">
                <input type="text" id="preset-name" placeholder="Preset Name">
                <button data-testid="preset-save" class="primary">Save</button>
            </div>
            <div id="preset-list" style="max-height: 150px; overflow-y: auto;">
                <!-- Presets injected here -->
            </div>
        </div>
    </div>
</div>

<div id="announcer" class="announcer" aria-live="polite"></div>

<script>
(function() {
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
        tick: 0,
        isPlaying: false,
        speed: 10,
        seed: 42,
        params: { ...DEFAULTS },
        grid: [],
        rabbits: [],
        foxes: [],
        history: [],
        nextId: 1,
        rand: null,
        lastFrameTime: 0,
        presets: {}
    };

    // --- DOM Elements ---
    const canvas = document.querySelector('canvas[data-testid="world"]');
    const ctx = canvas.getContext('2d');
    const announcer = document.getElementById('announcer');
    const seedInput = document.getElementById('seed-input');
    const speedSlider = document.getElementById('speed-slider');
    const speedVal = document.getElementById('speed-val');
    const tickDisplay = document.querySelector('[data-testid="tick"]');
    const rabbitCountDisplay = document.querySelector('[data-testid="count-rabbits"]');
    const foxCountDisplay = document.querySelector('[data-testid="count-foxes"]');
    const grassCountDisplay = document.querySelector('[data-testid="count-grass"]');
    const chartSvg = document.querySelector('svg[data-testid="chart"]');
    const odeChartSvg = document.querySelector('svg[data-testid="ode-chart"]');
    const scenarioJson = document.getElementById('scenario-json');
    const scenarioError = document.getElementById('scenario-error');
    const presetList = document.getElementById('preset-list');

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
        state.tick = 0;
        state.isPlaying = false;
        state.seed = seed;
        state.params = { ...DEFAULTS, ...params };
        state.history = [];
        state.nextId = 1;
        state.rand = mulberry32(seed);
        
        // Build grid
        state.grid = [];
        for (let y = 0; y < state.params.height; y++) {
            let row = [];
            for (let x = 0; x < state.params.width; x++) {
                row.push({
                    x, y,
                    grass: Math.floor(state.rand() * (state.params.grassMax + 1)),
                    rabbit: null,
                    fox: null
                });
            }
            state.grid.push(row);
        }

        // Place Rabbits
        let rabbitList = [];
        for (let y = 0; y < state.params.height; y++) {
            for (let x = 0; x < state.params.width; x++) {
                if (!state.grid[y][x].rabbit) rabbitList.push(state.grid[y][x]);
            }
        }
        for (let i = 0; i < state.params.rabbits0; i++) {
            if (rabbitList.length === 0) break;
            let spot = rabbitList[Math.floor(state.rand() * rabbitList.length)];
            spot.rabbit = { id: state.nextId++, energy: state.params.rabbitStart };
            rabbitList.splice(rabbitList.indexOf(spot), 1);
        }

        // Place Foxes
        let foxList = [];
        for (let y = 0; y < state.params.height; y++) {
            for (let x = 0; x < state.params.width; x++) {
                if (!state.grid[y][x].fox) foxList.push(state.grid[y][x]);
            }
        }
        for (let i = 0; i < state.params.foxes0; i++) {
            if (foxList.length === 0) break;
            let spot = foxList[Math.floor(state.rand() * foxList.length)];
            spot.fox = { id: state.nextId++, energy: state.params.foxStart };
            foxList.splice(foxList.indexOf(spot), 1);
        }

        // Record history
        state.history.push({
            tick: 0,
            rabbits: state.rabbits.length,
            foxes: state.foxes.length,
            grass: state.grid.reduce((sum, row) => sum + row.reduce((s, c) => s + c.grass, 0), 0)
        });

        updateUI();
    }

    function step() {
        if (!state.isPlaying) return;

        // 1. Grass
        for (let y = 0; y < state.params.height; y++) {
            for (let x = 0; x < state.params.width; x++) {
                state.grid[y][x].grass = Math.min(state.params.grassMax, state.grid[y][x].grass + 1);
            }
        }

        // 2. Rabbits
        let rabbitList = [];
        for (let y = 0; y < state.params.height; y++) {
            for (let x = 0; x < state.params.width; x++) {
                if (state.grid[y][x].rabbit) rabbitList.push(state.grid[y][x].rabbit);
            }
        }
        rabbitList.sort((a, b) => a.id - b.id);

        for (let rabbit of rabbitList) {
            // Move
            let neighbors = getNeighbors(state.grid, rabbit.x, rabbit.y);
            let freeNeighbors = neighbors.filter(n => !n.rabbit);
            if (freeNeighbors.length > 0) {
                let spot = freeNeighbors[Math.floor(state.rand() * freeNeighbors.length)];
                state.grid[rabbit.y][rabbit.x].rabbit = null;
                state.grid[spot.y][spot.x].rabbit = rabbit;
                rabbit.x = spot.x;
                rabbit.y = spot.y;
            }

            // Eat
            let cell = state.grid[rabbit.y][rabbit.x];
            rabbit.energy += state.params.rabbitGain * cell.grass;
            cell.grass = 0;

            // Cost
            rabbit.energy -= state.params.rabbitCost;

            // Breed
            if (rabbit.energy >= state.params.rabbitBreed) {
                let neighbors = getNeighbors(state.grid, rabbit.x, rabbit.y);
                let freeNeighbors = neighbors.filter(n => !n.rabbit);
                if (freeNeighbors.length > 0) {
                    let spot = freeNeighbors[Math.floor(state.rand() * freeNeighbors.length)];
                    let childEnergy = Math.floor(rabbit.energy / 2);
                    rabbit.energy -= childEnergy;
                    state.grid[spot.y][spot.x].rabbit = { id: state.nextId++, energy: childEnergy };
                }
            }

            // Die
            if (rabbit.energy <= 0) {
                state.grid[rabbit.y][rabbit.x].rabbit = null;
            }
        }

        // 3. Foxes
        let foxList = [];
        for (let y = 0; y < state.params.height; y++) {
            for (let x = 0; x < state.params.width; x++) {
                if (state.grid[y][x].fox) foxList.push(state.grid[y][x].fox);
            }
        }
        foxList.sort((a, b) => a.id - b.id);

        for (let fox of foxList) {
            // Move
            let neighbors = getNeighbors(state.grid, fox.x, fox.y);
            let rabbitNeighbors = neighbors.filter(n => n.rabbit && !n.fox);
            if (rabbitNeighbors.length > 0) {
                let spot = rabbitNeighbors[Math.floor(state.rand() * rabbitNeighbors.length)];
                state.grid[fox.y][fox.x].fox = null;
                state.grid[spot.y][spot.x].fox = fox;
                fox.x = spot.x;
                fox.y = spot.y;
            } else {
                let freeNeighbors = neighbors.filter(n => !n.fox);
                if (freeNeighbors.length > 0) {
                    let spot = freeNeighbors[Math.floor(state.rand() * freeNeighbors.length)];
                    state.grid[fox.y][fox.x].fox = null;
                    state.grid[spot.y][spot.x].fox = fox;
                    fox.x = spot.x;
                    fox.y = spot.y;
                }
            }

            // Eat
            let cell = state.grid[fox.y][fox.x];
            if (cell.rabbit) {
                state.grid[fox.y][fox.x].rabbit = null;
                fox.energy += state.params.foxGain;
            }

            // Cost
            fox.energy -= state.params.foxCost;

            // Breed
            if (fox.energy >= state.params.foxBreed) {
                let neighbors = getNeighbors(state.grid, fox.x, fox.y);
                let freeNeighbors = neighbors.filter(n => !n.fox);
                if (freeNeighbors.length > 0) {
                    let spot = freeNeighbors[Math.floor(state.rand() * freeNeighbors.length)];
                    let childEnergy = Math.floor(fox.energy / 2);
                    fox.energy -= childEnergy;
                    state.grid[spot.y][spot.x].fox = { id: state.nextId++, energy: childEnergy };
                }
            }

            // Die
            if (fox.energy <= 0) {
                state.grid[fox.y][fox.x].fox = null;
            }
        }

        state.tick++;
        state.history.push({
            tick: state.tick,
            rabbits: state.rabbits.length,
            foxes: state.foxes.length,
            grass: state.grid.reduce((sum, row) => sum + row.reduce((s, c) => s + c.grass, 0), 0)
        });

        updateUI();
    }

    function getNeighbors(grid, x, y) {
        let neighbors = [];
        if (y > 0) neighbors.push(grid[y - 1][x]);
        if (x < state.params.width - 1) neighbors.push(grid[y][x + 1]);
        if (y < state.params.height - 1) neighbors.push(grid[y + 1][x]);
        if (x > 0) neighbors.push(grid[y][x - 1]);
        return neighbors;
    }

    function counts() {
        let grassSum = 0;
        for (let y = 0; y < state.params.height; y++) {
            for (let x = 0; x < state.params.width; x++) {
                grassSum += state.grid[y][x].grass;
            }
        }
        return {
            rabbits: state.rabbits.length,
            foxes: state.foxes.length,
            grass: grassSum
        };
    }

    function cell(x, y) {
        if (x < 0 || x >= state.params.width || y < 0 || y >= state.params.height) return null;
        let c = state.grid[y][x];
        return {
            grass: c.grass,
            rabbit: c.rabbit ? { id: c.rabbit.id, energy: c.rabbit.energy } : null,
            fox: c.fox ? { id: c.fox.id, energy: c.fox.energy } : null
        };
    }

    function history() {
        return state.history;
    }

    // --- ODE ---
    function ode(p, t, dt) {
        let alpha = p.alpha, beta = p.beta, gamma = p.gamma, delta = p.delta;
        let x = p.x0, y = p.y0;
        let n = Math.round(t / dt);
        
        for (let i = 0; i < n; i++) {
            let k1x = alpha * x - beta * x * y;
            let k1y = delta * x * y - gamma * y;
            
            let k2x = alpha * (x + 0.5 * dt * k1x) - beta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y);
            let k2y = delta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y) - gamma * (y + 0.5 * dt * k1y);
            
            let k3x = alpha * (x + 0.5 * dt * k2x) - beta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y);
            let k3y = delta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y) - gamma * (y + 0.5 * dt * k2y);
            
            let k4x = alpha * (x + dt * k3x) - beta * (x + dt * k3x) * (y + dt * k3y);
            let k4y = delta * (x + dt * k3x) * (y + dt * k3y) - gamma * (y + dt * k3y);
            
            x += dt / 6.0 * (k1x + 2 * k2x + 2 * k3x + k4x);
            y += dt / 6.0 * (k1y + 2 * k2y + 2 * k3y + k4y);
        }
        return { x, y };
    }

    // --- Rendering ---
    function draw() {
        let w = state.params.width * 10;
        let h = state.params.height * 10;
        ctx.clearRect(0, 0, w, h);

        // Grass
        for (let y = 0; y < state.params.height; y++) {
            for (let x = 0; x < state.params.width; x++) {
                let cell = state.grid[y][x];
                let G = 60 + Math.round(160 * cell.grass / state.params.grassMax);
                ctx.fillStyle = `rgb(30, ${G}, 30)`;
                ctx.fillRect(x * 10, y * 10, 10, 10);
            }
        }

        // Rabbits
        for (let y = 0; y < state.params.height; y++) {
            for (let x = 0; x < state.params.width; x++) {
                let c = state.grid[y][x];
                if (c.rabbit) {
                    ctx.fillStyle = "rgb(240, 240, 240)";
                    ctx.beginPath();
                    ctx.arc(x * 10 + 5, y * 10 + 5, 3, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        // Foxes
        for (let y = 0; y < state.params.height; y++) {
            for (let x = 0; x < state.params.width; x++) {
                let c = state.grid[y][x];
                if (c.fox) {
                    ctx.fillStyle = "rgb(220, 80, 20)";
                    ctx.beginPath();
                    ctx.arc(x * 10 + 5, y * 10 + 5, 3, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
    }

    function updateChart() {
        let svg = chartSvg;
        let w = svg.clientWidth || 300;
        let h = svg.clientHeight || 200;
        let padding = 20;
        let chartW = w - padding * 2;
        let chartH = h - padding * 2;
        let maxRabbits = Math.max(1, ...state.history.map(h => h.rabbits));
        let maxFoxes = Math.max(1, ...state.history.map(h => h.foxes));
        let maxGrass = Math.max(1, ...state.history.map(h => h.grass));

        let scaleX = chartW / Math.max(1, state.history.length);
        let scaleYR = chartH / maxRabbits;
        let scaleYF = chartH / maxFoxes;
        let scaleYG = chartH / maxGrass;

        let pointsR = [];
        let pointsF = [];
        let pointsG = [];

        state.history.forEach(h => {
            let x = padding + Math.min(h.tick * scaleX, chartW);
            let yR = padding + chartH - Math.min(h.rabbits * scaleYR, chartH);
            let yF = padding + chartH - Math.min(h.foxes * scaleYF, chartH);
            let yG = padding + chartH - Math.min(h.grass * scaleYG, chartH);
            pointsR.push(x + "," + yR);
            pointsF.push(x + "," + yF);
            pointsG.push(x + "," + yG);
        });

        let dR = pointsR.join(" ");
        let dF = pointsF.join(" ");
        let dG = pointsG.join(" ");

        svg.innerHTML = `
            <line x1="${padding}" y1="${padding + chartH}" x2="${padding + chartW}" y2="${padding + chartH}" stroke="#ccc" stroke-width="1"/>
            <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${padding + chartH}" stroke="#ccc" stroke-width="1"/>
            <polyline data-testid="series-rabbits" fill="none" stroke="#27ae60" stroke-width="2" points="${dR}"/>
            <polyline data-testid="series-foxes" fill="none" stroke="#e74c3c" stroke-width="2" points="${dF}"/>
            <polyline fill="none" stroke="#2ecc71" stroke-width="2" stroke-dasharray="2,2" points="${dG}"/>
            <text x="${padding + chartW - 5}" y="${padding + chartH - 5}" font-size="10" fill="#999">tick</text>
            <text x="5" y="${padding - 5}" font-size="10" fill="#999" transform="rotate(-90 5,${padding})">count</text>
        `;
    }

    function updateOdeChart() {
        let svg = odeChartSvg;
        let w = svg.clientWidth || 300;
        let h = svg.clientHeight || 120;
        let padding = 20;
        let chartW = w - padding * 2;
        let chartH = h - padding * 2;

        let pointsX = [];
        let pointsY = [];

        let x = state.ode.x0, y = state.ode.y0;
        let alpha = state.ode.alpha, beta = state.ode.beta, gamma = state.ode.gamma, delta = state.ode.delta;
        let dt = state.ode.dt;
        let n = Math.round(state.ode.t / dt);

        for (let i = 0; i <= n; i++) {
            let t = i * dt;
            let k1x = alpha * x - beta * x * y;
            let k1y = delta * x * y - gamma * y;
            let k2x = alpha * (x + 0.5 * dt * k1x) - beta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y);
            let k2y = delta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y) - gamma * (y + 0.5 * dt * k1y);
            let k3x = alpha * (x + 0.5 * dt * k2x) - beta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y);
            let k3y = delta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y) - gamma * (y + 0.5 * dt * k2y);
            let k4x = alpha * (x + dt * k3x) - beta * (x + dt * k3x) * (y + dt * k3y);
            let k4y = delta * (x + dt * k3x) * (y + dt * k3y) - gamma * (y + dt * k3y);
            x += dt / 6.0 * (k1x + 2 * k2x + 2 * k3x + k4x);
            y += dt / 6.0 * (k1y + 2 * k2y + 2 * k3y + k4y);
            pointsX.push(x);
            pointsY.push(y);
        }

        let maxX = Math.max(...pointsX);
        let maxY = Math.max(...pointsY);
        let minX = Math.min(...pointsX);
        let minY = Math.min(...pointsY);
        let rangeX = maxX - minX || 1;
        let rangeY = maxY - minY || 1;

        let scaleX = chartW / rangeX;
        let scaleY = chartH / rangeY;

        let dX = pointsX.map((v, i) => padding + (v - minX) * scaleX).join(" ");
        let dY = pointsY.map((v, i) => padding + chartH - (v - minY) * scaleY).join(" ");

        svg.innerHTML = `
            <line x1="${padding}" y1="${padding + chartH}" x2="${padding + chartW}" y2="${padding + chartH}" stroke="#ccc" stroke-width="1"/>
            <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${padding + chartH}" stroke="#ccc" stroke-width="1"/>
            <polyline data-testid="ode-series-x" fill="none" stroke="#27ae60" stroke-width="2" points="${dX}"/>
            <polyline data-testid="ode-series-y" fill="none" stroke="#e74c3c" stroke-width="2" points="${dY}"/>
        `;
    }

    function updateUI() {
        let counts = counts();
        tickDisplay.textContent = state.tick;
        rabbitCountDisplay.textContent = counts.rabbits;
        foxCountDisplay.textContent = counts.foxes;
        grassCountDisplay.textContent = counts.grass;
        announcer.textContent = `Tick ${state.tick}: ${counts.rabbits} rabbits, ${counts.foxes} foxes`;
        draw();
        updateChart();
    }

    // --- Event Listeners ---
    document.querySelector('[data-testid="play"]').addEventListener('click', () => {
        state.isPlaying = true;
        state.lastFrameTime = performance.now();
        requestAnimationFrame(loop);
    });

    document.querySelector('[data-testid="pause"]').addEventListener('click', () => {
        state.isPlaying = false;
        state.lastFrameTime = 0;
        announcer.textContent = "Paused";
    });

    document.querySelector('[data-testid="step"]').addEventListener('click', () => {
        step();
        updateUI();
    });

    document.querySelector('[data-testid="reset"]').addEventListener('click', () => {
        let seed = parseInt(seedInput.value) || 42;
        reset(seed, {});
    });

    seedInput.addEventListener('input', (e) => {
        seedInput.value = e.target.value;
    });

    speedSlider.addEventListener('input', (e) => {
        state.speed = parseInt(e.target.value);
        speedVal.textContent = state.speed;
    });

    // Parameter sliders
    ['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax'].forEach(id => {
        let el = document.getElementById(`param-${id}`);
        el.addEventListener('input', (e) => {
            let val = parseInt(e.target.value);
            e.target.value = val;
            state.params[id] = val;
        });
    });

    // ODE
    document.querySelector('[data-testid="ode-run"]').addEventListener('click', () => {
        let p = {
            alpha: parseFloat(document.getElementById('ode-alpha').value),
            beta: parseFloat(document.getElementById('ode-beta').value),
            gamma: parseFloat(document.getElementById('ode-gamma').value),
            delta: parseFloat(document.getElementById('ode-delta').value),
            x0: parseFloat(document.getElementById('ode-x0').value),
            y0: parseFloat(document.getElementById('ode-y0').value),
            t: parseFloat(document.getElementById('ode-t').value),
            dt: parseFloat(document.getElementById('ode-dt').value)
        };
        let res = ode(p, p.t, p.dt);
        document.getElementById('ode-x').textContent = res.x.toFixed(8);
        document.getElementById('ode-y').textContent = res.y.toFixed(8);
        document.getElementById('ode-eq-x').textContent = (p.gamma / p.delta).toFixed(8);
        document.getElementById('ode-eq-y').textContent = (p.alpha / p.beta).toFixed(8);
        let V = (x, y) => p.delta * x - p.gamma * Math.log(x) + p.beta * y - p.alpha * Math.log(y);
        let drift = Math.abs(V(res.x, res.y) - V(p.x0, p.y0));
        document.getElementById('ode-drift').textContent = parseFloat(drift).toFixed(8);
        updateOdeChart();
    });

    // Scenario
    document.querySelector('[data-testid="scenario-export"]').addEventListener('click', () => {
        scenarioJson.value = JSON.stringify({
            version: 1,
            seed: state.seed,
            params: state.params
        }, null, 2);
    });

    document.querySelector('[data-testid="scenario-load"]').addEventListener('click', () => {
        let text = scenarioJson.value;
        try {
            let obj = JSON.parse(text);
            if (obj.version !== 1) throw new Error("Invalid version");
            if (typeof obj.seed !== 'number' || !Number.isInteger(obj.seed)) throw new Error("Seed must be integer");
            reset(obj.seed, obj.params);
            scenarioError.textContent = "";
        } catch (e) {
            scenarioError.textContent = e.message;
        }
    });

    // Presets
    document.querySelector('[data-testid="preset-save"]').addEventListener('click', () => {
        let name = document.getElementById('preset-name').value.trim();
        if (!name) return;
        state.presets[name] = { ...state.params, seed: state.seed };
        savePresets();
        renderPresets();
    });

    function savePresets() {
        try {
            localStorage.setItem("ecolab.presets", JSON.stringify(state.presets));
        } catch (e) {}
    }

    function loadPresets() {
        try {
            let raw = localStorage.getItem("ecolab.presets");
            if (raw) {
                state.presets = JSON.parse(raw);
            }
        } catch (e) {}
    }

    function renderPresets() {
        presetList.innerHTML = "";
        Object.keys(state.presets).forEach(name => {
            let div = document.createElement('div');
            div.className = 'preset-item';
            div.innerHTML = `
                <span class="preset-name">${name}</span>
                <div class="preset-actions">
                    <button class="primary" data-preset-load="${name}">Load</button>
                    <button class="danger" data-preset-delete="${name}">Del</button>
                </div>
            `;
            div.querySelector('[data-preset-load]').addEventListener('click', () => {
                reset(state.presets[name].seed, state.presets[name].params);
            });
            div.querySelector('[data-preset-delete]').addEventListener('click', () => {
                delete state.presets[name];
                savePresets();
                renderPresets();
            });
            presetList.appendChild(div);
        });
    }

    // --- Loop ---
    function loop(timestamp) {
        if (!state.isPlaying) return;
        let dt = timestamp - state.lastFrameTime;
        state.lastFrameTime = timestamp;
        let steps = Math.floor(dt / 1000 * state.speed);
        for (let i = 0; i < steps; i++) step();
        updateUI();
        requestAnimationFrame(loop);
    }

    // --- Init ---
    loadPresets();
    renderPresets();
    reset(42, {});

})();
</script>
</body>
</html>
```