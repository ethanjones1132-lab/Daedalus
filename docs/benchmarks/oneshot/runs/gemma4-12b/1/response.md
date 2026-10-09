## Plan

### Data Model
- **World State**: A 2D grid of `Cell` objects. Each `Cell` contains `grass` (0-grassMax), a `rabbit` object `{id, energy}`, and a `fox` object `{id, energy}`.
- **Entities**: Rabbits and Foxes are objects with unique IDs (global counter).
- **History**: An array of objects `{tick, rabbits, foxes, grass}`.
- **Parameters**: A central object containing all 13 simulation and ODE variables.

### Tick Order
1. **Grass Growth**: All cells increment grass by 1 (capped at `grassMax`).
2. **Rabbit Phase**:
   - Sort alive rabbits by ID.
   - For each: Move (to empty neighbor), Eat (grass in current cell), Subtract cost, Breed (if energy $\ge$ threshold, place child in empty neighbor), Die (if energy $\le$ 0).
3. **Fox Phase**:
   - Sort alive foxes by ID.
   - For each: Move (prefer rabbit-occupied empty fox-free cells, else empty fox-free cells), Eat (if rabbit in current cell, remove it), Subtract cost, Breed (if energy $\ge$ threshold, place child in empty fox-free neighbor), Die (if energy $\le$ 0).
4. **Record**: Increment tick, calculate totals, push to history.

### Components
- **Simulation Engine**: Handles the logic, `mulberry32` RNG, and `lab` API.
- **Renderer**: Handles Canvas drawing (grass, rabbits, foxes) and SVG path generation for both population and ODE charts.
- **UI Controller**: Manages buttons, sliders, inputs, presets (localStorage), and the `announcer`.
- **ODE Solver**: Implements RK4 integration for the Lotka–Volterra equations.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ecosystem Lab</title>
    <style>
        :root {
            --bg: #f0f2f5;
            --card: #ffffff;
            --primary: #2563eb;
            --text: #1e293b;
            --border: #e2e8f0;
        }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: var(--bg);
            color: var(--text);
            margin: 0;
            padding: 10px;
            display: flex;
            justify-content: center;
        }
        .container {
            max-width: 1200px;
            width: 100%;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        @media (min-width: 1000px) {
            .container { flex-direction: row; align-items: flex-start; }
            .panel-world { flex: 2; }
            .panel-side { flex: 1; }
        }
        @media (max-width: 700px) {
            .panel-side { order: -1; }
        }
        .panel {
            background: var(--card);
            padding: 20px;
            border-radius: 8px;
            border: 1px solid var(--border);
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        canvas {
            border: 1px solid #ccc;
            image-rendering: pixelated;
            max-width: 100%;
            height: auto;
            background: #000;
        }
        .controls {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 10px;
            margin-top: 15px;
        }
        .slider-group {
            display: flex;
            flex-direction: column;
            font-size: 0.85rem;
        }
        .slider-group label { margin-bottom: 4px; }
        .stats {
            display: flex;
            gap: 20px;
            margin-bottom: 15px;
            font-weight: bold;
            font-size: 1.1rem;
        }
        .chart-container {
            margin-top: 20px;
            border: 1px solid var(--border);
            padding: 10px;
        }
        svg { width: 100%; height: 200px; background: #fafafa; }
        textarea { width: 100%; height: 80px; font-family: monospace; font-size: 10px; }
        .preset-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 5px;
            border-bottom: 1px solid var(--border);
        }
        .ode-panel {
            margin-top: 20px;
            padding-top: 20px;
            border-top: 2px dashed var(--border);
        }
        .error { color: red; font-size: 0.8rem; margin-top: 5px; }
        button {
            cursor: pointer;
            padding: 8px 12px;
            border-radius: 4px;
            border: 1px solid #ccc;
            background: #fff;
        }
        button:hover { background: #f0f0f0; }
        button:focus { outline: 3px solid var(--primary); }
        .hidden { display: none; }
    </style>
</head>
<body>
<div class="container">
    <div class="panel-world">
        <div class="stats">
            <div>Tick: <span id="count-tick">0</span></div>
            <div>Rabbits: <span id="count-rabbits">0</span></div>
            <div>Foxes: <span id="count-foxes">0</span></div>
            <div>Grass: <span id="count-grass">0</span></div>
        </div>
        <canvas id="world" data-testid="world"></canvas>
        <div class="controls">
            <div class="slider-group">
                <label>Seed: <input type="number" id="seed" data-testid="seed"></label>
            </div>
            <div class="slider-group">
                <label>Speed: <input type="range" id="speed" min="1" max="60" value="10"></label>
            </div>
            <button id="play" data-testid="play">Play</button>
            <button id="pause" data-testid="pause">Pause</button>
            <button id="step" data-testid="step">Step</button>
            <button id="reset" data-testid="reset">Reset</button>
        </div>
        <div class="controls" style="margin-top: 20px;">
            <div class="slider-group"><label>Rabbits0: <input type="range" id="param-rabbits0" min="0" max="300"></label></div>
            <div class="slider-group"><label>Foxes0: <input type="range" id="param-foxes0" min="0" max="60"></label></div>
            <div class="slider-group"><label>RabbitBreed: <input type="range" id="param-rabbitBreed" min="2" max="40"></label></div>
            <div class="slider-group"><label>FoxBreed: <input type="range" id="param-foxBreed" min="2" max="60"></label></div>
            <div class="slider-group"><label>FoxGain: <input type="range" id="param-foxGain" min="1" max="30"></label></div>
            <div class="slider-group"><label>GrassMax: <input type="range" id="param-grassMax" min="1" max="10"></label></div>
        </div>
    </div>

    <div class="panel-side">
        <div class="chart-container">
            <svg data-testid="chart" viewBox="0 0 400 200">
                <polyline data-testid="series-rabbits" fill="none" stroke="blue" stroke-width="2" />
                <polyline data-testid="series-foxes" fill="none" stroke="orange" stroke-width="2" />
                <text x="5" y="195" font-size="10">Tick</text>
                <text x="5" y="10" font-size="10">Count</text>
            </svg>
        </div>

        <div class="ode-panel">
            <h3>Lotka–Volterra</h3>
            <div class="controls" style="grid-template-columns: 1fr 1fr;">
                <div class="slider-group"><label>α: <input type="number" id="ode-alpha" step="0.1" value="1.1"></label></div>
                <div class="slider-group"><label>β: <input type="number" id="ode-beta" step="0.1" value="0.4"></label></div>
                <div class="slider-group"><label>γ: <input type="number" id="ode-gamma" step="0.1" value="0.4"></label></div>
                <div class="slider-group"><label>δ: <input type="number" id="ode-delta" step="0.1" value="0.1"></label></div>
                <div class="slider-group"><label>x0: <input type="number" id="ode-x0" value="10"></label></div>
                <div class="slider-group"><label>y0: <input type="number" id="ode-y0" value="10"></label></div>
                <div class="slider-group"><label>t: <input type="number" id="ode-t" value="50"></label></div>
                <div class="slider-group"><label>dt: <input type="number" id="ode-dt" step="0.01" value="0.01"></label></div>
            </div>
            <button id="ode-run" data-testid="ode-run">Run ODE</button>
            <div id="ode-results" style="font-size: 0.8rem; margin-top: 10px;"></div>
            <svg data-testid="ode-chart" viewBox="0 0 400 200">
                <polyline data-testid="ode-series-x" fill="none" stroke="green" stroke-width="2" />
                <polyline data-testid="ode-series-y" fill="none" stroke="red" stroke-width="2" />
            </svg>
        </div>

        <div class="chart-container">
            <h3>Scenario</h3>
            <textarea id="scenario-json" data-testid="scenario-json"></textarea>
            <div style="display:flex; gap:5px; margin-top:5px;">
                <button id="scenario-export" data-testid="scenario-export">Export</button>
                <button id="scenario-load" data-testid="scenario-load">Load</button>
            </div>
            <div id="scenario-error" class="error" data-testid="scenario-error"></div>
        </div>

        <div class="chart-container">
            <h3>Presets</h3>
            <div style="display:flex; gap:5px; margin-bottom:10px;">
                <input type="text" id="preset-name" placeholder="Name">
                <button id="preset-save" data-testid="preset-save">Save</button>
            </div>
            <div id="preset-list"></div>
        </div>
    </div>
</div>
<div id="announcer" aria-live="polite" class="hidden"></div>

<script>
(function() {
    const DEFAULTS = {
        width: 40, height: 30, grassMax: 4,
        rabbits0: 100, foxes0: 6,
        rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
        foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
    };

    let state = {
        params: { ...DEFAULTS },
        seed: 42,
        rand: null,
        tick: 0,
        idCounter: 1,
        grid: [],
        history: [],
        isPlaying: false,
        lastTime: 0,
        animationFrame: null
    };

    function mulberry32(s) {
        let a = s | 0;
        return function() {
            a = (a + 0x6D2B79F5) | 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function getNeighbors(x, y) {
        const n = [];
        const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
        for (let d of dirs) {
            const nx = x + d[0], ny = y + d[1];
            if (nx >= 0 && nx < state.params.width && ny >= 0 && ny < state.params.height) {
                n.push([nx, ny]);
            }
        }
        return n;
    }

    function reset(seed, params = {}) {
        state.params = { ...DEFAULTS, ...params };
        state.seed = seed;
        state.rand = mulberry32(seed);
        state.tick = 0;
        state.idCounter = 1;
        state.history = [];
        state.grid = [];

        for (let y = 0; y < state.params.height; y++) {
            state.grid[y] = [];
            for (let x = 0; x < state.params.width; x++) {
                state.grid[y][x] = {
                    grass: Math.floor(state.rand() * (state.params.grassMax + 1)),
                    rabbit: null,
                    fox: null
                };
            }
        }

        const placeEntities = (count, type, startEnergy) => {
            for (let i = 0; i < count; i++) {
                let cells = [];
                for (let y = 0; y < state.params.height; y++) {
                    for (let x = 0; x < state.params.width; x++) {
                        if (!state.grid[y][x][type]) cells.push([x, y]);
                    }
                }
                if (cells.length > 0) {
                    const [cx, cy] = cells[Math.floor(state.rand() * cells.length)];
                    state.grid[cy][cx][type] = { id: state.idCounter++, energy: startEnergy };
                }
            }
        };

        placeEntities(state.params.rabbits0, 'rabbit', state.params.rabbitStart);
        placeEntities(state.params.foxes0, 'fox', state.params.foxStart);

        recordHistory();
        render();
        return counts();
    }

    function recordHistory() {
        let grassSum = 0;
        state.grid.forEach(row => row.forEach(c => grassSum += c.grass));
        state.history.push({
            tick: state.tick,
            rabbits: state.grid.flat().filter(c => c.rabbit).length,
            foxes: state.grid.flat().filter(c => c.fox).length,
            grass: grassSum
        });
    }

    function counts() {
        let grassSum = 0;
        let r = 0, f = 0;
        state.grid.forEach(row => row.forEach(c => {
            grassSum += c.grass;
            if (c.rabbit) r++;
            if (c.fox) f++;
        }));
        return { rabbits: r, foxes: f, grass: grassSum };
    }

    function step(n = 1) {
        for (let i = 0; i < n; i++) {
            // 1. Grass
            for (let y = 0; y < state.params.height; y++) {
                for (let x = 0; x < state.params.width; x++) {
                    state.grid[y][x].grass = Math.min(state.params.grassMax, state.grid[y][x].grass + 1);
                }
            }

            // 2. Rabbits
            let activeRabbits = [];
            state.grid.forEach(row => row.forEach(c => { if (c.rabbit) activeRabbits.push(c.rabbit); }));
            activeRabbits.sort((a, b) => a.id - b.id);
            
            let newRabbits = [];
            activeRabbits.forEach(r => {
                const cell = state.grid[r.y][r.x]; // This is slightly wrong, need to find cell by rabbit coords
                // Actually, let's find the cell object for the rabbit
                // To be efficient, we should store coords in the rabbit object.
            });
            // Correction: Let's store coords in rabbit/fox objects
        }
    }

    // Re-writing logic to be cleaner
    function resetFixed(seed, params = {}) {
        state.params = { ...DEFAULTS, ...params };
        state.seed = seed;
        state.rand = mulberry32(seed);
        state.tick = 0;
        state.idCounter = 1;
        state.history = [];
        state.grid = [];

        for (let y = 0; y < state.params.height; y++) {
            state.grid[y] = [];
            for (let x = 0; x < state.params.width; x++) {
                state.grid[y][x] = {
                    grass: Math.floor(state.rand() * (state.params.grassMax + 1)),
                    rabbit: null,
                    fox: null
                };
            }
        }

        const place = (count, type, startEnergy) => {
            for (let i = 0; i < count; i++) {
                let cells = [];
                for (let y = 0; y < state.params.height; y++) {
                    for (let x = 0; x < state.params.width; x++) {
                        if (!state.grid[y][x][type]) cells.push([x, y]);
                    }
                }
                if (cells.length > 0) {
                    const [cx, cy] = cells[Math.floor(state.rand() * cells.length)];
                    state.grid[cy][cx][type] = { id: state.idCounter++, energy: startEnergy, x: cx, y: cy };
                }
            }
        };

        place(state.params.rabbits0, 'rabbit', state.params.rabbitStart);
        place(state.params.foxes0, 'fox', state.params.foxStart);
        recordHistory();
        render();
        return counts();
    }

    // Re-implementing the core logic correctly
    function runTick() {
        // 1. Grass
        for (let y = 0; y < state.params.height; y++) {
            for (let x = 0; x < state.params.width; x++) {
                state.grid[y][x].grass = Math.min(state.params.grassMax, state.grid[y][x].grass + 1);
            }
        }

        // 2. Rabbits
        let rabbits = [];
        state.grid.forEach(row => row.forEach(c => { if (c.rabbit) rabbits.push(c.rabbit); }));
        rabbits.sort((a, b) => a.id - b.id);
        let bornRabbits = [];
        rabbits.forEach(r => {
            const cell = state.grid[r.y][r.x];
            // Move
            let neighbors = getNeighbors(r.x, r.y).filter(n => !state.grid[n[1]][n[0]].rabbit);
            if (neighbors.length > 0) {
                const [nx, ny] = neighbors[Math.floor(state.rand() * neighbors.length)];
                const oldCell = state.grid[r.y][r.x];
                const newCell = state.grid[ny][nx];
                newCell.rabbit = r;
                r.x = nx; r.y = ny;
                oldCell.rabbit = null;
            }
            // Eat
            const currentCell = state.grid[r.y][r.x];
            r.energy += state.params.rabbitGain * currentCell.grass;
            currentCell.grass = 0;
            // Cost
            r.energy -= state.params.rabbitCost;
            // Breed
            if (r.energy >= state.params.rabbitBreed) {
                let nbs = getNeighbors(r.x, r.y).filter(n => !state.grid[n[1]][n[0]].rabbit);
                if (nbs.length > 0) {
                    const [sx, sy] = nbs[Math.floor(state.rand() * nbs.length)];
                    const childEnergy = Math.floor(r.energy / 2);
                    r.energy -= childEnergy;
                    bornRabbits.push({ id: state.idCounter++, energy: childEnergy, x: sx, y: sy });
                }
            }
            if (r.energy <= 0) {
                state.grid[r.y][r.x].rabbit = null;
            }
        });
        bornRabbits.forEach(br => {
            state.grid[br.y][br.x].rabbit = br;
        });

        // 3. Foxes
        let foxes = [];
        state.grid.forEach(row => row.forEach(c => { if (c.fox) foxes.push(c.fox); }));
        foxes.sort((a, b) => a.id - b.id);
        let bornFoxes = [];
        foxes.forEach(f => {
            // Move
            let nbs = getNeighbors(f.x, f.y);
            let moveTarget = null;
            let rabbitNbs = nbs.filter(n => state.grid[n[1]][n[0]].rabbit && !state.grid[n[1]][n[0]].fox);
            if (rabbitNbs.length > 0) moveTarget = rabbitNbs[Math.floor(state.rand() * rabbitNbs.length)];
            else {
                let emptyNbs = nbs.filter(n => !state.grid[n[1]][n[0]].fox);
                if (emptyNbs.length > 0) moveTarget = emptyNbs[Math.floor(state.rand() * emptyNbs.length)];
            }
            
            if (moveTarget) {
                const [nx, ny] = moveTarget;
                const oldCell = state.grid[f.y][f.x];
                const newCell = state.grid[ny][nx];
                newCell.fox = f;
                f.x = nx; f.y = ny;
                oldCell.fox = null;
            }

            // Eat
            const currentCell = state.grid[f.y][f.x];
            if (currentCell.rabbit) {
                currentCell.rabbit.energy = 0; // Mark for removal
                currentCell.rabbit = null;
                f.energy += state.params.foxGain;
            }
            // Cost
            f.energy -= state.params.foxCost;
            // Breed
            if (f.energy >= state.params.foxBreed) {
                let nbs = getNeighbors(f.x, f.y).filter(n => !state.grid[n[1]][n[0]].fox);
                if (nbs.length > 0) {
                    const [sx, sy] = nbs[Math.floor(state.rand() * nbs.length)];
                    const childEnergy = Math.floor(f.energy / 2);
                    f.energy -= childEnergy;
                    bornFoxes.push({ id: state.idCounter++, energy: childEnergy, x: sx, y: sy });
                }
            }
            if (f.energy <= 0) {
                state.grid[f.y][f.x].fox = null;
            }
        });
        bornFoxes.forEach(bf => {
            state.grid[bf.y][bf.x].fox = bf;
        });

        // Cleanup dead rabbits (energy <= 0)
        state.grid.forEach(row => row.forEach(c => {
            if (c.rabbit && c.rabbit.energy <= 0) c.rabbit = null;
        }));

        state.tick++;
        recordHistory();
    }

    function render() {
        const canvas = document.getElementById('world');
        const ctx = canvas.getContext('2d');
        const w = state.params.width;
        const h = state.params.height;
        canvas.width = w * 10;
        canvas.height = h * 10;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const cell = state.grid[y][x];
                const g = 60 + Math.round(160 * cell.grass / state.params.grassMax);
                ctx.fillStyle = `rgb(30, ${g}, 30)`;
                ctx.fillRect(x * 10, y * 10, 10, 10);

                if (cell.rabbit) {
                    ctx.fillStyle = 'rgb(240, 240, 240)';
                    ctx.fillRect(x * 10 + 3, y * 10 + 3, 4, 4);
                }
                if (cell.fox) {
                    ctx.fillStyle = 'rgb(220, 80, 20)';
                    ctx.fillRect(x * 10 + 3, y * 10 + 3, 4, 4);
                }
            }
        }

        const counts = counts();
        document.getElementById('count-tick').innerText = state.tick;
        document.getElementById('count-rabbits').innerText = counts.rabbits;
        document.getElementById('count-foxes').innerText = counts.foxes;
        document.getElementById('count-grass').innerText = counts.grass;

        // Update Charts
        const history = state.history;
        const rabbitPoly = document.getElementById('series-rabbits');
        const foxPoly = document.getElementById('series-foxes');
        if (history.length > 0) {
            const maxR = Math.max(...history.map(h => h.rabbits), 1);
            const maxF = Math.max(...history.map(h => h.foxes), 1);
            const maxVal = Math.max(maxR, maxF);
            
            let rPts = "", fPts = "";
            history.forEach((h, i) => {
                const x = (i / (history.length - 1 || 1)) * 400;
                rPts += `${x},${(h.rabbits / maxVal) * 200} `;
                fPts += `${x},${(h.foxes / maxVal) * 200} `;
            });
            rabbitPoly.setAttribute('points', rPts);
            foxPoly.setAttribute('points', fPts);
        }

        // ODE Chart
        const odeParams = {
            alpha: parseFloat(document.getElementById('ode-alpha').value),
            beta: parseFloat(document.getElementById('ode-beta').value),
            gamma: parseFloat(document.getElementById('ode-gamma').value),
            delta: parseFloat(document.getElementById('ode-delta').value),
            x0: parseFloat(document.getElementById('ode-x0').value),
            y0: parseFloat(document.getElementById('ode-y0').value),
            t: parseFloat(document.getElementById('ode-t').value),
            dt: parseFloat(document.getElementById('ode-dt').value)
        };
        const odeRes = lab.ode(odeParams, odeParams.t, odeParams.dt);
        document.getElementById('ode-results').innerHTML = `
            x: ${odeRes.x.toFixed(8)}, y: ${odeRes.y.toFixed(8)}<br>
            eq_x: ${odeParams.gamma / odeParams.delta}, eq_y: ${odeParams.alpha / odeParams.beta}<br>
            drift: ${Math.abs((odeParams.delta * odeRes.x - odeParams.gamma * Math.log(odeRes.x + 1e-9)) + (odeParams.beta * odeRes.y - odeParams.alpha * Math.log(odeRes.y + 1e-9))) - 
                   (odeParams.delta * odeParams.x0 - odeParams.gamma * Math.log(odeParams.x0 + 1e-9)) + (odeParams.beta * odeParams.y0 - odeParams.alpha * Math.log(odeParams.y0 + 1e-9))}}
        `;
        // Note: The drift calculation in prompt is V(end) - V(start).
        // V(x,y) = delta*x - gamma*ln(x) + beta*y - alpha*ln(y)
        const v = (x, y) => (odeParams.delta * x - odeParams.gamma * Math.log(x + 1e-9)) + (odeParams.beta * y - odeParams.alpha * Math.log(y + 1e-9));
        const drift = Math.abs(v(odeRes.x, odeRes.y) - v(odeParams.x0, odeParams.y0));
        document.getElementById('ode-results').innerHTML += `<br>drift: ${drift.toFixed(8)}`;

        // Draw ODE Chart
        let oxPts = "", oyPts = "";
        const steps = Math.round(odeParams.t / odeParams.dt);
        for (let i = 0; i <= steps; i++) {
            const cur = lab.ode(odeParams, i * odeParams.dt, odeParams.dt);
            oxPts += `${(i / steps) * 400},${(cur.x / (odeParams.x0 * 2 + 1)) * 200} `;
            oyPts += `${(i / steps) * 400},${(cur.y / (odeParams.y0 * 2 + 1)) * 200} `;
        }
        document.getElementById('ode-series-x').setAttribute('points', oxPts);
        document.getElementById('ode-series-y').setAttribute('points', oyPts);
    }

    // API
    const lab = {
        reset: (seed, params) => {
            const p = {};
            for (let k in DEFAULTS) if (params[k] !== undefined) p[k] = params[k];
            resetFixed(seed, p);
            return counts();
        },
        step: (n = 1) => {
            for (let i = 0; i < n; i++) runTick();
            render();
            return counts();
        },
        counts: () => counts(),
        tick: () => state.tick,
        cell: (x, y) => state.grid[y][x],
        history: () => state.history,
        ode: (p, t, dt) => {
            let x = p.x0, y = p.y0;
            const f = (x, y) => ({
                dx: p.alpha * x - p.beta * x * y,
                dy: p.delta * x * y - p.gamma * y
            });
            const steps = Math.round(t / dt);
            for (let i = 0; i < steps; i++) {
                const k1 = f(x, y);
                const k2 = f(x + k1.dx * dt / 2, y + k1.dy * dt / 2);
                const k3 = f(x + k2.dx * dt / 2, y + k2.dy * dt / 2);
                const k4 = f(x + k3.dx * dt, y + k3.dy * dt);
                x += (dt / 6) * (k1.dx + 2 * k2.dx + 2 * k3.dx + k4.dx);
                y += (dt / 6) * (k1.dy + 2 * k2.dy + 2 * k3.dy + k4.dy);
            }
            return { x, y };
        },
        exportCSV: () => {
            let csv = "tick,rabbits,foxes,grass\n";
            state.history.forEach(h => csv += `${h.tick},${h.rabbits},${h.foxes},${h.grass}\n`);
            return csv;
        },
        exportScenario: () => JSON.stringify({
            version: 1,
            seed: state.seed,
            params: state.params
        }),
        loadScenario: (text) => {
            try {
                const data = JSON.parse(text);
                if (data.version !== 1 || typeof data.seed !== 'number') throw new Error();
                document.getElementById('scenario-error').innerText = "";
                resetFixed(data.seed, data.params);
                return true;
            } catch (e) {
                document.getElementById('scenario-error').innerText = "Invalid scenario.";
                return false;
            }
        }
    };

    // UI Wiring
    const inputs = ['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax'];
    inputs.forEach(id => {
        const el = document.getElementById(`param-${id}`);
        el.oninput = () => { state.params[id] = parseInt(el.value); };
    });

    document.getElementById('seed').oninput = (e) => { state.seed = parseInt(e.target.value) || 0; };
    document.getElementById('speed').oninput = (e) => { state.speed = parseInt(e.target.value); };
    
    document.getElementById('reset').onclick = () => {
        const seed = parseInt(document.getElementById('seed').value);
        lab.reset(seed, state.params);
    };

    document.getElementById('step').onclick = () => lab.step(1);

    let playReq = null;
    function loop(time) {
        if (state.isPlaying) {
            const delta = time - state.lastTime;
            const ticksToRun = Math.floor(delta * state.speed / 1000);
            if (ticksToRun > 0) {
                lab.step(ticksToRun);
                state.lastTime = time - (delta % (1000 / state.speed));
            }
            render();
        }
        state.animationFrame = requestAnimationFrame(loop);
    }

    document.getElementById('play').onclick = () => {
        state.isPlaying = !state.isPlaying;
        document.getElementById('play').innerText = state.isPlaying ? "Pause" : "Play";
        document.getElementById('pause').innerText = state.isPlaying ? "Pause" : "Pause"; // Logic fix
        if (state.isPlaying) {
            state.lastTime = performance.now();
            loop(state.lastTime);
        } else {
            cancelAnimationFrame(state.animationFrame);
        }
        const counts = lab.counts();
        document.getElementById('announcer').innerText = `Tick ${state.tick}: ${counts.rabbits} rabbits, ${counts.foxes} foxes`;
    };

    document.getElementById('pause').onclick = () => {
        state.isPlaying = false;
        document.getElementById('play').innerText = "Play";
        cancelAnimationFrame(state.animationFrame);
    };

    document.getElementById('csv-export').onclick = () => {
        const blob = new Blob([lab.exportCSV()], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ecolab.csv';
        a.click();
    };

    document.getElementById('scenario-export').onclick = () => {
        document.getElementById('scenario-json').value = lab.exportScenario();
    };

    document.getElementById('scenario-load').onclick = () => {
        lab.loadScenario(document.getElementById('scenario-json').value);
    };

    // Presets
    function updatePresets() {
        const list = document.getElementById('preset-list');
        list.innerHTML = "";
        const data = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
        Object.keys(data).forEach(name => {
            const div = document.createElement('div');
            div.className = "preset-item";
            div.innerHTML = `<span>${name}</span>
                <div>
                    <button onclick="loadPreset('${name}')">Load</button>
                    <button onclick="deletePreset('${name}')">X</button>
                </div>`;
            list.appendChild(div);
        });
    }

    window.loadPreset = (name) => {
        const data = JSON.parse(localStorage.getItem("ecolab.presets"));
        lab.loadScenario(JSON.stringify(data[name]));
    };

    window.deletePreset = (name) => {
        const data = JSON.parse(localStorage.getItem("ecolab.presets"));
        delete data[name];
        localStorage.setItem("ecolab.presets", JSON.stringify(data));
        updatePresets();
    };

    document.getElementById('preset-save').onclick = () => {
        const name = document.getElementById('preset-name').value;
        if (!name) return;
        const data = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
        data[name] = lab.exportScenario();
        localStorage.setItem("ecolab.presets", JSON.stringify(data));
        updatePresets();
    };

    document.getElementById('ode-run').onclick = () => render();

    // Shortcuts
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
        if (e.code === 'Space') {
            e.preventDefault();
            document.getElementById('play').click();
        } else if (e.key === 's') {
            lab.step(1);
        } else if (e.key === 'r') {
            document.getElementById('reset').click();
        }
    });

    // Init
    lab.reset(42, {});
    updatePresets();
    state.speed = 10;
    document.getElementById('speed').value = 10;
    
    // Helper for the ODE drift calculation
    // The prompt asks for V(end) - V(start) where V(x,y) = delta*x - gamma*ln(x) + beta*y - alpha*ln(y)
    // This is handled inside the render() function's ODE section.
})();
```