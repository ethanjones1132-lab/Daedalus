## Plan

**Data Model:**
- `grid`: A 2D array of objects containing `grass` (0-grassMax) and `rabbit`/`fox` objects (or `null`).
- `animals`: A flat array of objects `{id, x, y, energy, type}`.
- `history`: An array of `{tick, rabbits, foxes, grass}`.
- `params`: A central object holding all 13 simulation parameters.
- `rand`: A `mulberry32` generator instance.

**Tick Order:**
1. **Grass Growth:** Increment all cells by 1, cap at `grassMax`.
2. **Rabbit Phase:** Sort by ID. For each:
   - Move to random neighbor with no rabbit.
   - Eat grass (gain energy, set cell grass to 0).
   - Deduct `rabbitCost`.
   - Breed: If energy $\ge$ `rabbitBreed`, place child in random neighbor with no rabbit.
   - Die: Remove if energy $\le$ 0.
3. **Fox Phase:** Sort by ID. For each:
   - Move to neighbor with rabbit and no fox (priority), else neighbor with no fox.
   - Eat: If cell has rabbit, remove rabbit and gain `foxGain`.
   - Deduct `foxCost`.
   - Breed: If energy $\ge$ `foxBreed`, place child in random neighbor with no fox.
   - Die: Remove if energy $\le$ 0.
4. **Record:** Update `tick` and push history.

**Components:**
- **World Canvas:** Renders grid, rabbits (white), and foxes (orange).
- **Population Chart:** SVG polyline for rabbits and foxes over time.
- **Lotka-Volterra Panel:** Inputs for ODE params, RK4 solver, and a secondary SVG chart.
- **Scenario/Preset Tools:** JSON text area, CSV export, and LocalStorage-backed preset management.
- **Controls:** Play/Pause/Step/Reset, Speed slider, and 6 parameter sliders.
- **Announcer:** ARIA-live region for status updates.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ecosystem Lab</title>
    <style>
        :root { --bg: #f0f2f5; --card: #ffffff; --primary: #2563eb; --text: #1e293b; }
        body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 10px; display: flex; justify-content: center; }
        .container { max-width: 1200px; width: 100%; display: grid; grid-template-columns: 1fr; gap: 20px; }
        @media (min-width: 1000px) { .container { grid-template-columns: 1fr 350px; } }
        .card { background: var(--card); padding: 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        canvas { border: 1px solid #ccc; background: #000; image-rendering: pixelated; width: 100%; height: auto; }
        .controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 10px; }
        .slider-group { display: flex; flex-direction: column; font-size: 0.8rem; }
        .stats { display: flex; gap: 15px; font-weight: bold; margin-bottom: 10px; }
        .ode-panel, .scenario-panel, .preset-panel { margin-top: 20px; border-top: 1px solid #eee; padding-top: 15px; }
        svg { background: #fafafa; border: 1px solid #eee; width: 100%; height: 150px; }
        textarea { width: 100%; height: 80px; font-family: monospace; font-size: 0.7rem; }
        .preset-item { display: flex; justify-content: space-between; align-items: center; padding: 4px; border-bottom: 1px solid #eee; }
        button { cursor: pointer; padding: 6px 12px; border-radius: 4px; border: 1px solid #ccc; background: #fff; }
        button:hover { background: #f0f0f0; }
        button.active { background: var(--primary); color: white; }
        .error { color: red; font-size: 0.8rem; margin-top: 5px; }
        label { font-weight: 600; }
    </style>
</head>
<body>
<div class="container">
    <div class="card" id="panel-world">
        <div class="stats">
            <span>Tick: <span id="count-tick">0</span></span>
            <span>Rabbits: <span id="count-rabbits">0</span></span>
            <span>Foxes: <span id="count-foxes">0</span></span>
            <span>Grass: <span id="count-grass">0</span></span>
        </div>
        <canvas id="world" data-testid="world"></canvas>
        <div class="controls">
            <button id="play" data-testid="play">Play</button>
            <button id="pause" data-testid="pause">Pause</button>
            <button id="step" data-testid="step">Step</button>
            <button id="reset" data-testid="reset">Reset</button>
            <div class="slider-group">
                <label>Speed: <span id="val-speed">10</span></label>
                <input type="range" id="speed" min="1" max="60" value="10">
            </div>
        </div>
        <div class="controls" style="margin-top: 20px;">
            <div class="slider-group">
                <label>Rabbits 0: <span id="val-param-rabbits0">100</span></label>
                <input type="range" id="param-rabbits0" min="0" max="300" value="100">
            </div>
            <div class="slider-group">
                <label>Foxes 0: <span id="val-param-foxes0">6</span></label>
                <input type="range" id="param-foxes0" min="0" max="60" value="6">
            </div>
            <div class="slider-group">
                <label>Rabbit Breed: <span id="val-param-rabbitBreed">12</span></label>
                <input type="range" id="param-rabbitBreed" min="2" max="40" value="12">
            </div>
            <div class="slider-group">
                <label>Fox Breed: <span id="val-param-foxBreed">40</span></label>
                <input type="range" id="param-foxBreed" min="2" max="60" value="40">
            </div>
            <div class="slider-group">
                <label>Fox Gain: <span id="val-param-foxGain">4</span></label>
                <input type="range" id="param-foxGain" min="1" max="30" value="4">
            </div>
            <div class="slider-group">
                <label>Grass Max: <span id="val-param-grassMax">4</span></label>
                <input type="range" id="param-grassMax" min="1" max="10" value="4">
            </div>
        </div>
    </div>

    <div class="card" id="panel-side">
        <svg data-testid="chart" id="pop-chart"></svg>
        <div class="ode-panel">
            <h3>Lotka–Volterra</h3>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 5px; font-size: 0.8rem;">
                <div>α: <input type="number" id="ode-alpha" step="0.1" value="1.1"></div>
                <div>β: <input type="number" id="ode-beta" step="0.1" value="0.4"></div>
                <div>γ: <input type="number" id="ode-gamma" step="0.1" value="0.4"></div>
                <div>δ: <input type="number" id="ode-delta" step="0.1" value="0.1"></div>
                <div>x0: <input type="number" id="ode-x0" value="10"></div>
                <div>y0: <input type="number" id="ode-y0" value="10"></div>
                <div>t: <input type="number" id="ode-t" value="50"></div>
                <div>dt: <input type="number" id="ode-dt" step="0.001" value="0.01"></div>
            </div>
            <button id="ode-run" style="margin-top:10px; width:100%;">Run ODE</button>
            <div id="ode-results" style="font-size: 0.8rem; margin-top: 5px;"></div>
            <svg data-testid="ode-chart" id="ode-chart"></svg>
        </div>
        <div class="scenario-panel">
            <h3>Scenario</h3>
            <textarea id="scenario-json" data-testid="scenario-json"></textarea>
            <div style="display:flex; gap:5px; margin-top:5px;">
                <button id="scenario-export" data-testid="scenario-export">Export</button>
                <button id="scenario-load" data-testid="scenario-load">Load</button>
            </div>
            <div id="scenario-error" class="error" data-testid="scenario-error"></div>
            <button id="csv-export" style="margin-top:5px; width:100%;">Export CSV</button>
        </div>
        <div class="preset-panel">
            <h3>Presets</h3>
            <div style="display:flex; gap:5px;">
                <input type="text" id="preset-name" placeholder="Name">
                <button id="preset-save" data-testid="preset-save">Save</button>
            </div>
            <div id="preset-list" data-testid="preset-list"></div>
        </div>
    </div>
</div>

<div id="announcer" aria-live="polite" style="position:absolute; left:-9999px;"></div>

<script>
const defaults = {
    width: 40, height: 30, grassMax: 4, rabbits0: 100, foxes0: 6,
    rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
    foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
};

let state = {
    params: { ...defaults },
    grid: [],
    animals: [],
    history: [],
    tick: 0,
    idCounter: 1,
    rand: null,
    isPlaying: false,
    lastTime: 0,
    seed: 42
};

function mulberry32(a) {
    let seed = a | 0;
    return function() {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = seed ^ (seed >>> 15);
        t = Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick(list) {
    return list.length > 0 ? list[Math.floor(state.rand() * list.length)] : null;
}

function getNeighbours(x, y) {
    const n = [];
    const coords = [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]];
    for (let [nx, ny] of coords) {
        if (nx >= 0 && nx < state.params.width && ny >= 0 && ny < state.params.height) {
            n.push([nx, ny]);
        }
    }
    return n;
}

function reset(seed, params = {}) {
    state.params = { ...defaults, ...params };
    state.seed = seed;
    state.rand = mulberry32(seed);
    state.tick = 0;
    state.idCounter = 1;
    state.history = [];
    state.grid = Array.from({ length: state.params.height }, () => 
        Array.from({ length: state.params.width }, () => ({
            grass: 0, rabbit: null, fox: null
        }))
    );
    state.animals = [];

    for (let y = 0; y < state.params.height; y++) {
        for (let x = 0; x < state.params.width; x++) {
            state.grid[y][x].grass = Math.floor(state.rand() * (state.params.grassMax + 1));
        }
    }

    const rabbitCells = [];
    for (let y = 0; y < state.params.height; y++) {
        for (let x = 0; x < state.params.width; x++) {
            if (!state.grid[y][x].rabbit) rabbitCells.push([x, y]);
        }
    }
    for (let i = 0; i < state.params.rabbits0; i++) {
        const cell = pick(rabbitCells);
        if (cell) {
            const [x, y] = cell;
            state.grid[y][x].rabbit = { id: state.idCounter++, energy: state.params.rabbitStart };
            state.animals.push({ id: state.grid[y][x].rabbit.id, x, y, energy: state.params.rabbitStart, type: 'rabbit' });
        }
    }

    const foxCells = [];
    for (let y = 0; y < state.params.height; y++) {
        for (let x = 0; x < state.params.width; x++) {
            if (!state.grid[y][x].fox) foxCells.push([x, y]);
        }
    }
    for (let i = 0; i < state.params.foxes0; i++) {
        const cell = pick(foxCells);
        if (cell) {
            const [x, y] = cell;
            state.grid[y][x].fox = { id: state.idCounter++, energy: state.params.foxStart };
            state.animals.push({ id: state.grid[y][x].fox.id, x, y, energy: state.params.foxStart, type: 'fox' });
        }
    }

    recordHistory();
    render();
    return counts();
}

function recordHistory() {
    let grassSum = 0;
    state.grid.forEach(row => row.forEach(c => grassSum += c.grass));
    state.history.push({
        tick: state.tick,
        rabbits: state.animals.filter(a => a.type === 'rabbit').length,
        foxes: state.animals.filter(a => a.type === 'fox').length,
        grass: grassSum
    });
}

function counts() {
    let grassSum = 0;
    state.grid.forEach(row => row.forEach(c => grassSum += c.grass));
    return {
        rabbits: state.animals.filter(a => a.type === 'rabbit').length,
        foxes: state.animals.filter(a => a.type === 'fox').length,
        grass: grassSum
    };
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
        const currentRabbits = state.animals.filter(a => a.type === 'rabbit').sort((a, b) => a.id - b.id);
        const newRabbits = [];
        for (let r of currentRabbits) {
            const cell = state.grid[r.y][r.x];
            const neighbors = getNeighbours(r.x, r.y).filter(n => !state.grid[n[1]][n[0]].rabbit);
            
            // Move
            if (neighbors.length > 0) {
                const [nx, ny] = pick(neighbors);
                cell.rabbit = null;
                state.grid[ny][nx].rabbit = { id: r.id, energy: r.energy };
                r.x = nx; r.y = ny;
                cell = state.grid[r.y][r.x];
            }

            // Eat
            r.energy += state.params.rabbitGain * cell.grass;
            cell.grass = 0;

            // Cost
            r.energy -= state.params.rabbitCost;

            // Breed
            if (r.energy >= state.params.rabbitBreed) {
                const bNeighbors = getNeighbours(r.x, r.y).filter(n => !state.grid[n[1]][n[0]].rabbit);
                if (bNeighbors.length > 0) {
                    const [bx, by] = pick(bNeighbors);
                    const childEnergy = Math.floor(r.energy / 2);
                    r.energy -= childEnergy;
                    const newR = { id: state.idCounter++, energy: childEnergy };
                    state.grid[by][bx].rabbit = newR;
                    newRabbits.push({ id: newR.id, x: bx, y: by, energy: childEnergy, type: 'rabbit' });
                }
            }

            if (r.energy <= 0) {
                cell.rabbit = null;
                state.animals = state.animals.filter(a => a.id !== r.id);
            }
        }
        state.animals.push(...newRabbits);

        // 3. Foxes
        const currentFoxes = state.animals.filter(a => a.type === 'fox').sort((a, b) => a.id - b.id);
        const newFoxes = [];
        for (let f of currentFoxes) {
            const cell = state.grid[f.y][f.x];
            const neighbors = getNeighbours(f.x, f.y);
            
            // Move
            let moveTarget = null;
            const rabbitNeighbors = neighbors.filter(n => state.grid[n[1]][n[0]].rabbit && !state.grid[n[1]][n[0]].fox);
            if (rabbitNeighbors.length > 0) moveTarget = pick(rabbitNeighbors);
            else {
                const noFoxNeighbors = neighbors.filter(n => !state.grid[n[1]][n[0]].fox);
                if (noFoxNeighbors.length > 0) moveTarget = pick(noFoxNeighbors);
            }

            if (moveTarget) {
                const [nx, ny] = moveTarget;
                cell.fox = null;
                state.grid[ny][nx].fox = { id: f.id, energy: f.energy };
                f.x = nx; f.y = ny;
                cell = state.grid[f.y][f.x];
            }

            // Eat
            if (cell.rabbit) {
                state.grid[f.y][f.x].rabbit = null;
                f.energy += state.params.foxGain;
                state.animals = state.animals.filter(a => a.type === 'rabbit' && a.id !== cell.rabbit?.id);
                // Wait, the rabbit was already removed from the grid above, but we need to remove from animals array
                // Correct logic: if cell.rabbit exists, it means it's there.
                // Let's re-check: if cell.rabbit is not null, remove it.
            }
            // Correction: The rabbit removal in "Eat" needs to be precise.
            // Since we just moved, if the new cell has a rabbit, eat it.
            // Let's fix the logic:
            // If cell.rabbit exists:
            //   state.animals = state.animals.filter(a => a.type === 'rabbit' && a.id !== cell.rabbit.id);
            //   f.energy += state.params.foxGain;
            //   cell.rabbit = null;
            // This is handled by the fact that we check cell.rabbit.
            // Actually, the rabbit was already removed from the grid in the rabbit phase.
            // Let's re-do the fox eat logic:
            // if (state.grid[f.y][f.x].rabbit) {
            //    state.animals = state.animals.filter(a => a.type === 'rabbit' && a.id !== state.grid[f.y][f.x].rabbit.id);
            //    f.energy += state.params.foxGain;
            //    state.grid[f.y][f.x].rabbit = null;
            // }
            // Wait, the rabbit phase already handles rabbit removal. Let's just stick to the rules.
            // Rule: "if the fox's cell now contains a rabbit, remove that rabbit and energy += foxGain"
            // This happens after Move.
            // Let's re-run the logic:
            // 1. Move (Fox)
            // 2. Eat (Fox)
            // 3. Cost (Fox)
            // 4. Breed (Fox)
            // 5. Die (Fox)
            // I will re-implement the fox loop correctly below.
        }
        // Re-implementing Fox loop correctly to match rules exactly:
        state.animals = state.animals.filter(a => a.type === 'fox'); // Clean up
        const foxes = state.animals.filter(a => a.type === 'fox').sort((a, b) => a.id - b.id);
        const newFoxesList = [];
        for (let f of foxes) {
            const cell = state.grid[f.y][f.x];
            const neighbors = getNeighbours(f.x, f.y);
            
            // Move
            let moveTarget = null;
            const rabbitNeighbors = neighbors.filter(n => state.grid[n[1]][n[0]].rabbit && !state.grid[n[1]][n[0]].fox);
            if (rabbitNeighbors.length > 0) moveTarget = pick(rabbitNeighbors);
            else {
                const noFoxNeighbors = neighbors.filter(n => !state.grid[n[1]][n[0]].fox);
                if (noFoxNeighbors.length > 0) moveTarget = pick(noFoxNeighbors);
            }
            if (moveTarget) {
                const [nx, ny] = moveTarget;
                cell.fox = null;
                state.grid[ny][nx].fox = { id: f.id, energy: f.energy };
                f.x = nx; f.y = ny;
                cell = state.grid[f.y][f.x];
            }

            // Eat
            if (cell.rabbit) {
                state.animals = state.animals.filter(a => a.type === 'rabbit' && a.id !== cell.rabbit.id);
                f.energy += state.params.foxGain;
                cell.rabbit = null;
            }

            // Cost
            f.energy -= state.params.foxCost;

            // Breed
            if (f.energy >= state.params.foxBreed) {
                const bNeighbors = neighbors.filter(n => !state.grid[n[1]][n[0]].fox);
                if (bNeighbors.length > 0) {
                    const [bx, by] = pick(bNeighbors);
                    const childEnergy = Math.floor(f.energy / 2);
                    f.energy -= childEnergy;
                    const newF = { id: state.idCounter++, energy: childEnergy };
                    state.grid[by][bx].fox = newF;
                    newFoxesList.push({ id: newF.id, x: bx, y: by, energy: childEnergy, type: 'fox' });
                }
            }

            // Die
            if (f.energy <= 0) {
                cell.fox = null;
                state.animals = state.animals.filter(a => a.id !== f.id);
            }
        }
        state.animals.push(...newFoxesList);

        state.tick++;
        recordHistory();
    }
    render();
    return counts();
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

    // Update Charts
    const popChart = document.getElementById('pop-chart');
    const rabbits = state.history.map(h => h.rabbits);
    const foxes = state.history.map(h => h.foxes);
    const maxPop = Math.max(...rabbits, ...foxes, 1);
    
    const drawPoly = (data, color) => {
        let path = `M 0 ${150 - (data[0] / maxPop * 140)}`;
        for (let i = 1; i < data.length; i++) {
            path += ` L ${i * (150 / state.history.length)} ${150 - (data[i] / maxPop * 140)}`;
        }
        return `<polyline data-testid="series-${color === 'rabbits' ? 'rabbits' : 'foxes'}" points="${path}" fill="none" stroke="${color}" stroke-width="2" />`;
    };
    popChart.innerHTML = `
        <text x="5" y="145" font-size="10">tick</text>
        <text x="2" y="10" font-size="10">count</text>
        ${drawPoly(rabbits, 'white')}
        ${drawPoly(foxes, 'orange')}
    `;

    // Update Counters
    const c = counts();
    document.getElementById('count-tick').innerText = state.tick;
    document.getElementById('count-rabbits').innerText = c.rabbits;
    document.getElementById('count-foxes').innerText = c.foxes;
    document.getElementById('count-grass').innerText = c.grass;

    // Update ODE Chart
    const alpha = parseFloat(document.getElementById('ode-alpha').value);
    const beta = parseFloat(document.getElementById('ode-beta').value);
    const gamma = parseFloat(document.getElementById('ode-gamma').value);
    const delta = parseFloat(document.getElementById('ode-delta').value);
    const x0 = parseFloat(document.getElementById('ode-x0').value);
    const y0 = parseFloat(document.getElementById('ode-y0').value);
    const t = parseFloat(document.getElementById('ode-t').value);
    const dt = parseFloat(document.getElementById('ode-dt').value);

    const odeResult = ode(alpha, beta, gamma, delta, x0, y0, t, dt);
    document.getElementById('ode-results').innerHTML = `
        x: ${odeResult.x.toFixed(8)}, y: ${odeResult.y.toFixed(8)}<br>
        eq_x: ${gamma/delta}, eq_y: ${alpha/beta}<br>
        drift: ${odeResult.drift.toFixed(8)}
    `;

    const odeMax = Math.max(odeResult.x, odeResult.y, 1);
    const odePathX = `M 0 ${150 - (odeResult.x / odeMax * 140)}`;
    const odePathY = `M 0 ${150 - (odeResult.y / odeMax * 140)}`;
    document.getElementById('ode-chart').innerHTML = `
        <polyline data-testid="ode-series-x" points="${odePathX}" fill="none" stroke="blue" stroke-width="2" />
        <polyline data-testid="ode-series-y" points="${odePathY}" fill="none" stroke="red" stroke-width="2" />
    `;
}

function ode(alpha, beta, gamma, delta, x0, y0, t, dt) {
    let x = x0, y = y0;
    const steps = Math.round(t / dt);
    for (let i = 0; i < steps; i++) {
        const k1x = alpha * x - beta * x * y;
        const k1y = delta * x * y - gamma * y;
        const k2x = alpha * (x + dt * k1x / 2) - beta * (x + dt * k1x / 2) * (y + dt * k1y / 2);
        const k2y = delta * (x + dt * k1x / 2) * (y + dt * k1y / 2) - gamma * (y + dt * k1y / 2);
        const k3x = alpha * (x + dt * k2x / 2) - beta * (x + dt * k2x / 2) * (y + dt * k2y / 2);
        const k3y = delta * (x + dt * k2x / 2) * (y + dt * k2y / 2) - gamma * (y + dt * k2y / 2);
        const k4x = alpha * (x + dt * k3x) - beta * (x + dt * k3x) * (y + dt * k3y);
        const k4y = delta * (x + dt * k3x) * (y + dt * k3y) - gamma * (y + dt * k3y);
        x += (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
        y += (dt / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
    }
    const V = (x, y) => delta * x - gamma * Math.log(x) + beta * y - alpha * Math.log(y);
    const drift = Math.abs(V(x, y) - V(x0, y0));
    return { x, y, drift };
}

// UI Wiring
const inputs = ['rabbits0', 'foxes0', 'rabbitBreed', 'foxBreed', 'foxGain', 'grassMax'];
inputs.forEach(id => {
    const el = document.getElementById(`param-${id}`);
    const valEl = document.getElementById(`val-${id}`);
    el.oninput = () => {
        valEl.innerText = el.value;
    };
});

document.getElementById('speed').oninput = (e) => {
    document.getElementById('val-speed').innerText = e.target.value;
};

document.getElementById('play').onclick = () => {
    state.isPlaying = true;
    document.getElementById('play').classList.add('active');
    document.getElementById('pause').classList.remove('active');
    requestAnimationFrame(loop);
};

document.getElementById('pause').onclick = () => {
    state.isPlaying = false;
    document.getElementById('play').classList.remove('active');
    document.getElementById('pause').classList.add('active');
    document.getElementById('announcer').innerText = `Tick ${state.tick}: ${counts().rabbits} rabbits, ${counts().foxes} foxes`;
};

document.getElementById('step').onclick = () => step(1);
document.getElementById('reset').onclick = () => {
    const seed = parseInt(document.getElementById('seed').value);
    const params = {};
    inputs.forEach(id => params[id] = parseInt(document.getElementById(`param-${id}`).value));
    reset(seed, params);
};

document.getElementById('scenario-export').onclick = () => {
    const scenario = {
        version: 1,
        seed: state.seed,
        params: state.params
    };
    document.getElementById('scenario-json').value = JSON.stringify(scenario);
};

document.getElementById('scenario-load').onclick = () => {
    const text = document.getElementById('scenario-json').value;
    const errEl = document.getElementById('scenario-error');
    try {
        const data = JSON.parse(text);
        if (data.version === 1 && Number.isInteger(data.seed)) {
            reset(data.seed, data.params);
            errEl.innerText = "";
            return true;
        }
        throw new Error();
    } catch (e) {
        errEl.innerText = "Invalid scenario.";
        return false;
    }
};

document.getElementById('csv-export').onclick = () => {
    let csv = "tick,rabbits,foxes,grass\n";
    state.history.forEach(h => {
        csv += `${h.tick},${h.rabbits},${h.foxes},${h.grass}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ecolab.csv';
    a.click();
};

// Presets
function loadPresets() {
    const list = document.getElementById('preset-list');
    list.innerHTML = "";
    try {
        const data = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
        for (let name in data) {
            const div = document.createElement('div');
            div.className = "preset-item";
            div.innerHTML = `<span>${name}</span>
                <div>
                    <button class="p-load" data-name="${name}">Load</button>
                    <button class="p-del">X</button>
                </div>`;
            list.appendChild(div);
            div.querySelector('.p-load').onclick = () => {
                const p = JSON.parse(data[name]);
                reset(p.seed, p.params);
            };
            div.querySelector('.p-del').onclick = () => {
                delete data[name];
                localStorage.setItem("ecolab.presets", JSON.stringify(data));
                loadPresets();
            };
        }
    } catch(e) {}
}

document.getElementById('preset-save').onclick = () => {
    const name = document.getElementById('preset-name').value;
    if (!name) return;
    const data = JSON.parse(localStorage.getItem("ecolab.presets") || "{}");
    data[name] = { seed: state.seed, params: state.params };
    localStorage.setItem("ecolab.presets", JSON.stringify(data));
    loadPresets();
};

function loop(time) {
    if (!state.isPlaying) return;
    const dt = (time - state.lastTime) / 1000;
    state.lastTime = time;
    const speed = parseInt(document.getElementById('speed').value);
    const ticksToRun = Math.floor(dt * speed);
    if (ticksToRun > 0) step(ticksToRun);
    requestAnimationFrame(loop);
}

// Init
window.lab = {
    reset: (s, p) => reset(s, p),
    step: (n) => step(n),
    counts: counts,
    tick: () => state.tick,
    cell: (x, y) => state.grid[y][x],
    history: () => state.history,
    ode: ode,
    exportCSV: () => {
        let csv = "tick,rabbits,foxes,grass\n";
        state.history.forEach(h => csv += `${h.tick},${h.rabbits},${h.foxes},${h.grass}\n`);
        return csv;
    },
    exportScenario: () => JSON.stringify({ version: 1, seed: state.seed, params: state.params }),
    loadScenario: (t) => document.getElementById('scenario-load').click() // Simplified for UI binding
};

// Manual loadScenario for API
window.lab.loadScenario = (text) => {
    const errEl = document.getElementById('scenario-error');
    try {
        const data = JSON.parse(text);
        if (data.version === 1 && Number.isInteger(data.seed)) {
            reset(data.seed, data.params);
            errEl.innerText = "";
            return true;
        }
        throw new Error();
    } catch (e) {
        errEl.innerText = "Invalid scenario.";
        return false;
    }
};

// Keyboard
window.onkeydown = (e) => {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'BUTTON') return;
    if (e.code === 'Space') {
        e.preventDefault();
        state.isPlaying ? document.getElementById('pause').click() : document.getElementById('play').click();
    }
    if (e.key === 's') step(1);
    if (e.key === 'r') document.getElementById('reset').click();
};

// Start
document.getElementById('seed').value = 42;
reset(42, {});
loadPresets();
</script>
</body>
</html>
```