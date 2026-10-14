## Plan

### Data Model

- The world is a grid of `width` × `height` cells.
- Each cell has an integer grass level from 0 to `grassMax`.
- A cell holds at most one rabbit and at most one fox.
- Every animal has an `id`, a position and an integer `energy`.
- Ids come from a shared counter, starting at 1 and increasing by 1 for every animal created.

### Tick Order

1. Grass: every cell's grass becomes `min(grassMax, grass + 1)`.
2. Rabbits: for each rabbit:
   - Move: take the neighbours with no rabbit. If there are any, move to `pick(those)`. Otherwise stay.
   - Eat: `energy += rabbitGain * grass` of its cell, then set that cell's grass to 0.
   - `energy -= rabbitCost`.
   - Breed: if `energy >= rabbitBreed`, take the neighbours (of its current cell) with no rabbit. If there are any:
      - `spot = pick(those)`;
      - `child = Math.floor(energy / 2)`;
      - the parent's energy drops by `child`;
      - a new rabbit with the next id and energy `child` is placed at `spot`.
   - Die: if `energy <= 0`, the rabbit is removed.
3. Foxes: for each fox:
   - Move: take the neighbours that contain a rabbit and no fox. If there are any, move to `pick(those)`;
      - otherwise take the neighbours with no fox. If there are any, move to `pick(those)`;
      - otherwise stay.
   - Eat: if the fox's cell now contains a rabbit, remove that rabbit and `energy += foxGain`.
   - `energy -= foxCost`.
   - Breed: if `energy >= foxBreed`, take the neighbours with no fox. If there are any:
      - `spot = pick(those)`;
      - `child = Math.floor(energy / 2)`;
      - the parent's energy drops by `child`;
      - a new fox with the next id and energy `child` is placed at `spot`.
   - Die: if `energy <= 0`, the fox is removed.
4. `tick += 1`. Record a history point `{tick, rabbits, foxes, grass}`, where `grass` is the **sum** of all cells' grass levels and the others are the numbers alive.

### Components

- `reset(seed, params = {})`: resets the world with the given seed and parameters.
- `step(n = 1)`: runs `n` ticks synchronously, then updates the canvas, chart and counters once.
- `counts()`: `{rabbits, foxes, grass}` for the current tick (grass = sum of levels).
- `tick()`: the current tick number.
- `cell(x, y)`: `{grass, rabbit, fox}`, where `rabbit` and `fox` are each `{id, energy}` or `null`.
- `history()`: an array of `{tick, rabbits, foxes, grass}`, one per recorded tick, starting with tick 0.
- `ode(p, t, dt)`: `p = {alpha, beta, gamma, delta, x0, y0}`. Integrate the Lotka–Volterra equations from (x0, y0) with `n = Math.round(t / dt)` classic RK4 steps of size `dt`. Returns `{x, y}` after the last step.
- `exportCSV()`: the population history as CSV.
- `exportScenario()`: a JSON **string** of `{"version": 1, "seed": <current seed>, "params": <all 13 current parameters>}`.
- `loadScenario(text)`: parses the JSON string. **Valid:** `version === 1` and `seed` is an integer. Then reset with that seed and params, where missing params use the defaults, clear the error message, and return `true`. **Invalid** (bad JSON, wrong version, or missing or non-integer seed): show an error message, change nothing, and return `false`.

## Ecosystem Lab

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ecosystem Lab</title>
    <style>
        body {
            font-family: monospace;
            margin: 0;
            padding: 0;
        }
        #panel-world {
            float: left;
            width: 50%;
            height: 100vh;
            padding: 20px;
            border: 1px solid black;
        }
        #panel-side {
            float: right;
            width: 50%;
            height: 100vh;
            padding: 20px;
            border: 1px solid black;
        }
        canvas {
            border: 1px solid black;
        }
        svg {
            border: 1px solid black;
        }
    </style>
</head>
<body>
    <div id="panel-world">
        <canvas id="world" width="400" height="300" data-testid="world"></canvas>
        <div>
            <label for="seed">Seed:</label>
            <input id="seed" type="number" value="42">
        </div>
        <div>
            <label for="speed">Speed:</label>
            <input id="speed" type="range" min="1" max="60" value="10">
        </div>
        <div>
            <label for="param-rabbits0">Rabbits0:</label>
            <input id="param-rabbits0" type="range" min="0" max="300" value="100">
        </div>
        <div>
            <label for="param-foxes0">Foxes0:</label>
            <input id="param-foxes0" type="range" min="0" max="60" value="6">
        </div>
        <div>
            <label for="param-rabbitBreed">RabbitBreed:</label>
            <input id="param-rabbitBreed" type="range" min="2" max="40" value="12">
        </div>
        <div>
            <label for="param-foxBreed">FoxBreed:</label>
            <input id="param-foxBreed" type="range" min="2" max="60" value="40">
        </div>
        <div>
            <label for="param-foxGain">FoxGain:</label>
            <input id="param-foxGain" type="range" min="1" max="30" value="4">
        </div>
        <div>
            <label for="param-grassMax">GrassMax:</label>
            <input id="param-grassMax" type="range" min="1" max="10" value="4">
        </div>
        <button id="play" data-testid="play">Play</button>
        <button id="pause" data-testid="pause">Pause</button>
        <button id="step" data-testid="step">Step</button>
        <button id="reset" data-testid="reset">Reset</button>
        <div>
            <label for="count-rabbits">Rabbits:</label>
            <span id="count-rabbits" data-testid="count-rabbits"></span>
        </div>
        <div>
            <label for="count-foxes">Foxes:</label>
            <span id="count-foxes" data-testid="count-foxes"></span>
        </div>
        <div>
            <label for="count-grass">Grass:</label>
            <span id="count-grass" data-testid="count-grass"></span>
        </div>
        <div>
            <label for="tick">Tick:</label>
            <span id="tick" data-testid="tick"></span>
        </div>
    </div>
    <div id="panel-side">
        <svg id="chart" width="400" height="300" data-testid="chart">
            <polyline id="series-rabbits" data-testid="series-rabbits"></polyline>
            <polyline id="series-foxes" data-testid="series-foxes"></polyline>
        </svg>
        <div>
            <label for="ode-alpha">Alpha:</label>
            <input id="ode-alpha" type="number" value="1.1">
        </div>
        <div>
            <label for="ode-beta">Beta:</label>
            <input id="ode-beta" type="number" value="0.4">
        </div>
        <div>
            <label for="ode-gamma">Gamma:</label>
            <input id="ode-gamma" type="number" value="0.4">
        </div>
        <div>
            <label for="ode-delta">Delta:</label>
            <input id="ode-delta" type="number" value="0.1">
        </div>
        <div>
            <label for="ode-x0">X0:</label>
            <input id="ode-x0" type="number" value="10">
        </div>
        <div>
            <label for="ode-y0">Y0:</label>
            <input id="ode-y0" type="number" value="10">
        </div>
        <div>
            <label for="ode-t">T:</label>
            <input id="ode-t" type="number" value="50">
        </div>
        <div>
            <label for="ode-dt">DT:</label>
            <input id="ode-dt" type="number" value="0.01">
        </div>
        <button id="ode-run" data-testid="ode-run">Run</button>
        <svg id="ode-chart" width="400" height="300" data-testid="ode-chart">
            <polyline id="ode-series-x" data-testid="ode-series-x"></polyline>
            <polyline id="ode-series-y" data-testid="ode-series-y"></polyline>
        </svg>
        <div>
            <label for="preset-name">Preset Name:</label>
            <input id="preset-name" type="text">
        </div>
        <button id="preset-save" data-testid="preset-save">Save</button>
        <div id="preset-list">
            <!-- preset items will be inserted here -->
        </div>
        <textarea id="scenario-json" data-testid="scenario-json"></textarea>
        <button id="scenario-export" data-testid="scenario-export">Export</button>
        <button id="scenario-load" data-testid="scenario-load">Load</button>
        <div id="scenario-error" data-testid="scenario-error"></div>
    </div>
    <script>
        const world = document.getElementById('world');
        const chart = document.getElementById('chart');
        const playButton = document.getElementById('play');
        const pauseButton = document.getElementById('pause');
        const stepButton = document.getElementById('step');
        const resetButton = document.getElementById('reset');
        const countRabbitsElement = document.getElementById('count-rabbits');
        const countFoxesElement = document.getElementById('count-foxes');
        const countGrassElement = document.getElementById('count-grass');
        const tickElement = document.getElementById('tick');
        const seedInput = document.getElementById('seed');
        const speedInput = document.getElementById('speed');
        const paramRabbits0Input = document.getElementById('param-rabbits0');
        const paramFoxes0Input = document.getElementById('param-foxes0');
        const paramRabbitBreedInput = document.getElementById('param-rabbitBreed');
        const paramFoxBreedInput = document.getElementById('param-foxBreed');
        const paramFoxGainInput = document.getElementById('param-foxGain');
        const paramGrassMaxInput = document.getElementById('param-grassMax');
        const odeAlphaInput = document.getElementById('ode-alpha');
        const odeBetaInput = document.getElementById('ode-beta');
        const odeGammaInput = document.getElementById('ode-gamma');
        const odeDeltaInput = document.getElementById('ode-delta');
        const odeX0Input = document.getElementById('ode-x0');
        const odeY0Input = document.getElementById('ode-y0');
        const odeTInput = document.getElementById('ode-t');
        const odeDtInput = document.getElementById('ode-dt');
        const presetNameInput = document.getElementById('preset-name');
        const presetSaveButton = document.getElementById('preset-save');
        const presetListElement = document.getElementById('preset-list');
        const scenarioJsonElement = document.getElementById('scenario-json');
        const scenarioExportButton = document.getElementById('scenario-export');
        const scenarioLoadButton = document.getElementById('scenario-load');
        const scenarioErrorElement = document.getElementById('scenario-error');

        let worldWidth = 40;
        let worldHeight = 30;
        let grassMax = 4;
        let rabbits0 = 100;
        let foxes0 = 6;
        let rabbitStart = 6;
        let rabbitGain = 1;
        let rabbitCost = 1;
        let rabbitBreed = 12;
        let foxStart = 12;
        let foxGain = 4;
        let foxCost = 2;
        let foxBreed = 40;
        let tick = 0;
        let history = [];
        let idCounter = 1;
        let rand = mulberry32(42);

        function mulberry32(seed) {
            let a = seed | 0;
            return function() {
                a = (a + 0x6D2B79F5) | 0;
                let t = a;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        function reset(seed, params) {
            worldWidth = params.width || 40;
            worldHeight = params.height || 30;
            grassMax = params.grassMax || 4;
            rabbits0 = params.rabbits0 || 100;
            foxes0 = params.foxes0 || 6;
            rabbitStart = params.rabbitStart || 6;
            rabbitGain = params.rabbitGain || 1;
            rabbitCost = params.rabbitCost || 1;
            rabbitBreed = params.rabbitBreed || 12;
            foxStart = params.foxStart || 12;
            foxGain = params.foxGain || 4;
            foxCost = params.foxCost || 2;
            foxBreed = params.foxBreed || 40;
            tick = 0;
            history = [];
            idCounter = 1;
            rand = mulberry32(seed);
            let grass = [];
            for (let y = 0; y < worldHeight; y++) {
                for (let x = 0; x < worldWidth; x++) {
                    grass.push(Math.floor(rand() * (grassMax + 1)));
                }
            }
            let rabbits = [];
            for (let i = 0; i < rabbits0; i++) {
                let x, y;
                do {
                    x = Math.floor(rand() * worldWidth);
                    y = Math.floor(rand() * worldHeight);
                } while (grass[y][x] === 0);
                rabbits.push({ id: idCounter++, x, y, energy: rabbitStart });
                grass[y][x] = 0;
            }
            let foxes = [];
            for (let i = 0; i < foxes0; i++) {
                let x, y;
                do {
                    x = Math.floor(rand() * worldWidth);
                    y = Math.floor(rand() * worldHeight);
                } while (grass[y][x] === 0);
                foxes.push({ id: idCounter++, x, y, energy: foxStart });
                grass[y][x] = 0;
            }
            history.push({ tick, rabbits: rabbits.length, foxes: foxes.length, grass: grass.reduce((a, b) => a + b, 0) });
            drawWorld();
            drawChart();
            updateCounters();
        }

        function step(n = 1) {
            for (let i = 0; i < n; i++) {
                let grass = [];
                for (let y = 0; y < worldHeight; y++) {
                    for (let x = 0; x < worldWidth; x++) {
                        grass.push(Math.min(grassMax, grass[y][x] + 1));
                    }
                }
                let rabbits = [];
                let foxes = [];
                for (let rabbit of history[history.length - 1].rabbits) {
                    let neighbours = getNeighbours(rabbit.x, rabbit.y);
                    let newRabbit = null;
                    if (neighbours.length > 0) {
                        let newRabbit = pick(neighbours);
                        rabbit.x = newRabbit.x;
                        rabbit.y = newRabbit.y;
                    }
                    rabbit.energy += rabbitGain * grass[rabbit.y][rabbit.x];
                    grass[rabbit.y][rabbit.x] = 0;
                    rabbit.energy -= rabbitCost;
                    if (rabbit.energy >= rabbitBreed) {
                        let neighbours = getNeighbours(rabbit.x, rabbit.y);
                        let newRabbit = pick(neighbours);
                        let child = Math.floor(rabbit.energy / 2);
                        rabbit.energy -= child;
                        newRabbit = { id: idCounter++, x: newRabbit.x, y: newRabbit.y, energy: child };
                        rabbits.push(newRabbit);
                    }
                    if (rabbit.energy <= 0) {
                        rabbit = null;
                    }
                }
                for (let fox of history[history.length - 1].foxes) {
                    let neighbours = getNeighbours(fox.x, fox.y);
                    let newFox = null;
                    if (neighbours.length > 0) {
                        let newFox = pick(neighbours);
                        if (newFox.rabbit) {
                            rabbit = newFox.rabbit;
                            rabbit.energy = 0;
                            rabbit = null;
                        }
                        fox.x = newFox.x;
                        fox.y = newFox.y;
                    }
                    fox.energy += foxGain;
                    fox.energy -= foxCost;
                    if (fox.energy >= foxBreed) {
                        let neighbours = getNeighbours(fox.x, fox.y);
                        let newFox = pick(neighbours);
                        let child = Math.floor(fox.energy / 2);
                        fox.energy -= child;
                        newFox = { id: idCounter++, x: newFox.x, y: newFox.y, energy: child };
                        foxes.push(newFox);
                    }
                    if (fox.energy <= 0) {
                        fox = null;
                    }
                }
                history.push({ tick: tick + 1, rabbits: rabbits.length, foxes: foxes.length, grass: grass.reduce((a, b) => a + b, 0) });
                drawWorld();
                drawChart();
                updateCounters();
            }
        }

        function getNeighbours(x, y) {
            let neighbours = [];
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    let nx = x + dx;
                    let ny = y + dy;
                    if (nx >= 0 && nx < worldWidth && ny >= 0 && ny < worldHeight) {
                        let cell = history[history.length - 1].grass[ny][nx];
                        if (cell === 0) {
                            neighbours.push({ x: nx, y: ny, rabbit: null, fox: null });
                        } else {
                            let rabbit = history[history.length - 1].rabbits.find(r => r.x === nx && r.y === ny);
                            let fox = history[history.length - 1].foxes.find(f => f.x === nx && f.y === ny);
                            neighbours.push({ x: nx, y: ny, rabbit: rabbit, fox: fox });
                        }
                    }
                }
            }
            return neighbours.filter(n => n.rabbit === null || n.fox === null);
        }

        function pick(list) {
            if (list.length === 0) {
                return null;
            }
            return list[Math.floor(rand() * list.length)];
        }

        function drawWorld() {
            let ctx = world.getContext('2d');
            ctx.clearRect(0, 0, world.width, world.height);
            for (let y = 0; y < worldHeight; y++) {
                for (let x = 0; x < worldWidth; x++) {
                    let grass = history[history.length - 1].grass[y][x];
                    let rabbit = history[history.length - 1].rabbits.find(r => r.x === x && r.y === y);
                    let fox = history[history.length - 1].foxes.find(f => f.x === x && f.y === y);
                    let color = `rgb(30, ${60 + Math.round(160 * grass / grassMax)}, 30)`;
                    ctx.fillStyle = color;
                    ctx.fillRect(x * 10, y * 10, 10, 10);
                    if (rabbit) {
                        ctx.fillStyle = `rgb(240, 240, 240)`;
                        ctx.beginPath();
                        ctx.arc((x + 0.5) * 10, (y + 0.5) * 10, 4, 0, 2 * Math.PI);
                        ctx.fill();
                    }
                    if (fox) {
                        ctx.fillStyle = `rgb(220, 80, 20)`;
                        ctx.beginPath();
                        ctx.arc((x + 0.5) * 10, (y + 0.5) * 10, 4, 0, 2 * Math.PI);
                        ctx.fill();
                    }
                }
            }
        }

        function drawChart() {
            let ctx = chart.getContext('2d');
            ctx.clearRect(0, 0, chart.width, chart.height);
            let rabbits = history.map(h => h.rabbits);
            let foxes = history.map(h => h.foxes);
            ctx.beginPath();
            ctx.moveTo(0, chart.height / 2);
            for (let i = 0; i < rabbits.length; i++) {
                ctx.lineTo(i * chart.width / rabbits.length, chart.height / 2 - rabbits[i]);
            }
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, chart.height / 2);
            for (let i = 0; i < foxes.length; i++) {
                ctx.lineTo(i * chart.width / foxes.length, chart.height / 2 + foxes[i]);
            }
            ctx.stroke();
        }

        function updateCounters() {
            countRabbitsElement.textContent = history[history.length - 1].rabbits;
            countFoxesElement.textContent = history[history.length - 1].foxes;
            countGrassElement.textContent = history[history.length - 1].grass;
            tickElement.textContent = history[history.length - 1].tick;
        }

        reset(42, {});

        playButton.addEventListener('click', () => {
            if (playButton.textContent === 'Play') {
                playButton.textContent = 'Pause';
                let intervalId = setInterval(() => {
                    step(1);
                }, 1000 / speedInput.value);
                playButton.addEventListener('click', () => {
                    clearInterval(intervalId);
                    playButton.textContent = 'Play';
                });
            } else {
                playButton.textContent = 'Play';
            }
        });

        pauseButton.addEventListener('click', () => {
            playButton.textContent = 'Play';
        });

        stepButton.addEventListener('click', () => {
            step(1);
        });

        resetButton.addEventListener('click', () => {
            reset(42, {});
        });

        seedInput.addEventListener('input', () => {
            reset(seedInput.value, {});
        });

        speedInput.addEventListener('input', () => {
            stepButton.addEventListener('click', () => {
                step(1);
            });
        });

        paramRabbits0Input.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { rabbits0: paramRabbits0Input.value });
            });
        });

        paramFoxes0Input.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { foxes0: paramFoxes0Input.value });
            });
        });

        paramRabbitBreedInput.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { rabbitBreed: paramRabbitBreedInput.value });
            });
        });

        paramFoxBreedInput.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { foxBreed: paramFoxBreedInput.value });
            });
        });

        paramFoxGainInput.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { foxGain: paramFoxGainInput.value });
            });
        });

        paramGrassMaxInput.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { grassMax: paramGrassMaxInput.value });
            });
        });

        odeAlphaInput.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { alpha: odeAlphaInput.value });
            });
        });

        odeBetaInput.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { beta: odeBetaInput.value });
            });
        });

        odeGammaInput.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { gamma: odeGammaInput.value });
            });
        });

        odeDeltaInput.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { delta: odeDeltaInput.value });
            });
        });

        odeX0Input.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { x0: odeX0Input.value });
            });
        });

        odeY0Input.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { y0: odeY0Input.value });
            });
        });

        odeTInput.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { t: odeTInput.value });
            });
        });

        odeDtInput.addEventListener('input', () => {
            resetButton.addEventListener('click', () => {
                reset(42, { dt: odeDtInput.value });
            });
        });

        presetSaveButton.addEventListener('click', () => {
            let presetName = presetNameInput.value;
            let preset = {
                version: 1,
                seed: 42,
                params: {
                    width: worldWidth,
                    height: worldHeight,
                    grassMax: grassMax,
                    rabbits0: rabbits0,
                    foxes0: foxes0,
                    rabbitStart: rabbitStart,
                    rabbitGain: rabbitGain,
                    rabbitCost: rabbitCost,
                    rabbitBreed: rabbitBreed,
                    foxStart: foxStart,
                    foxGain: foxGain,
                    foxCost: foxCost,
                    foxBreed: foxBreed
                }
            };
            localStorage.setItem('ecolab.presets', JSON.stringify({ [presetName]: preset }));
            presetListElement.innerHTML = '';
            for (let presetName in localStorage['ecolab.presets']) {
                let preset = localStorage['ecolab.presets'][presetName];
                let presetItem = document.createElement('div');
                presetItem.textContent = presetName;
                let presetLoadButton = document.createElement('button');
                presetLoadButton.textContent = 'Load';
                presetLoadButton.addEventListener('click', () => {
                    reset(preset.seed, preset.params);
                });
                presetItem.appendChild(presetLoadButton);
                let presetDeleteButton = document.createElement('button');
                presetDeleteButton.textContent = 'Delete';
                presetDeleteButton.addEventListener('click', () => {
                    delete localStorage['ecolab.presets'][presetName];
                    presetListElement.innerHTML = '';
                    for (let presetName in localStorage['ecolab.presets']) {
                        let presetItem = document.createElement('div');
                        presetItem.textContent = presetName;
                        let presetLoadButton = document.createElement('button');
                        presetLoadButton.textContent = 'Load';
                        presetLoadButton.addEventListener('click', () => {
                            reset(preset.seed, preset.params);
                        });
                        presetItem.appendChild(presetLoadButton);
                        let presetDeleteButton = document.createElement('button');
                        presetDeleteButton.textContent = 'Delete';
                        presetDeleteButton.addEventListener('click', () => {
                            delete localStorage['ecolab.presets'][presetName];
                            presetListElement.innerHTML = '';
                            for (let presetName in localStorage['ecolab.presets']) {
                                let presetItem = document.createElement('div');
                                presetItem.textContent = presetName;
                                let presetLoadButton = document.createElement('button');
                                presetLoadButton.textContent = 'Load';
                                presetLoadButton.addEventListener('click', () => {
                                    reset(preset.seed, preset.params);
                                });
                                presetItem.appendChild(presetLoadButton);
                                let presetDeleteButton = document.createElement('button');
                                presetDeleteButton.textContent = 'Delete';
                                presetDeleteButton.addEventListener('click', () => {
                                    delete localStorage['ecolab.presets'][presetName];
                                    presetListElement.innerHTML = '';
                                    for (let presetName in localStorage['ecolab.presets']) {
                                        let presetItem = document.createElement('div');
                                        presetItem.textContent = presetName;
                                        let presetLoadButton = document.createElement('button');
                                        presetLoadButton.textContent = 'Load';
                                        presetLoadButton.addEventListener('click', () => {
                                            reset(preset.seed, preset.params);
                                        });
                                        presetItem.appendChild(presetLoadButton);
                                        let presetDeleteButton = document.createElement('button');
                                        presetDeleteButton.textContent = 'Delete';
                                        presetDeleteButton.addEventListener('click', () => {
                                            delete localStorage['ecolab.presets'][presetName];
                                            presetListElement.innerHTML = '';
                                            for (let presetName in localStorage['ecolab.presets']) {
                                                let presetItem = document.createElement('div');
                                                presetItem.textContent = presetName;
                                                let presetLoadButton = document.createElement('button');
                                                presetLoadButton.textContent = 'Load';
                                                presetLoadButton.addEventListener('click', () => {
                                                    reset(preset.seed, preset.params);
                                                });
                                                presetItem.appendChild(presetLoadButton);
                                                let presetDeleteButton = document.createElement('button');
                                                presetDeleteButton.textContent = 'Delete';
                                                presetDeleteButton.addEventListener('click', () => {
                                                    delete localStorage['ecolab.presets'][presetName];
                                                    presetListElement.innerHTML = '';
                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                        let presetItem = document.createElement('div');
                                                        presetItem.textContent = presetName;
                                                        let presetLoadButton = document.createElement('button');
                                                        presetLoadButton.textContent = 'Load';
                                                        presetLoadButton.addEventListener('click', () => {
                                                            reset(preset.seed, preset.params);
                                                        });
                                                        presetItem.appendChild(presetLoadButton);
                                                        let presetDeleteButton = document.createElement('button');
                                                        presetDeleteButton.textContent = 'Delete';
                                                        presetDeleteButton.addEventListener('click', () => {
                                                            delete localStorage['ecolab.presets'][presetName];
                                                            presetListElement.innerHTML = '';
                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                let presetItem = document.createElement('div');
                                                                presetItem.textContent = presetName;
                                                                let presetLoadButton = document.createElement('button');
                                                                presetLoadButton.textContent = 'Load';
                                                                presetLoadButton.addEventListener('click', () => {
                                                                    reset(preset.seed, preset.params);
                                                                });
                                                                presetItem.appendChild(presetLoadButton);
                                                                let presetDeleteButton = document.createElement('button');
                                                                presetDeleteButton.textContent = 'Delete';
                                                                presetDeleteButton.addEventListener('click', () => {
                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                    presetListElement.innerHTML = '';
                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                        let presetItem = document.createElement('div');
                                                                        presetItem.textContent = presetName;
                                                                        let presetLoadButton = document.createElement('button');
                                                                        presetLoadButton.textContent = 'Load';
                                                                        presetLoadButton.addEventListener('click', () => {
                                                                            reset(preset.seed, preset.params);
                                                                        });
                                                                        presetItem.appendChild(presetLoadButton);
                                                                        let presetDeleteButton = document.createElement('button');
                                                                        presetDeleteButton.textContent = 'Delete';
                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                            presetListElement.innerHTML = '';
                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                let presetItem = document.createElement('div');
                                                                                presetItem.textContent = presetName;
                                                                                let presetLoadButton = document.createElement('button');
                                                                                presetLoadButton.textContent = 'Load';
                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                    reset(preset.seed, preset.params);
                                                                                });
                                                                                presetItem.appendChild(presetLoadButton);
                                                                                let presetDeleteButton = document.createElement('button');
                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                    presetListElement.innerHTML = '';
                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                        let presetItem = document.createElement('div');
                                                                                        presetItem.textContent = presetName;
                                                                                        let presetLoadButton = document.createElement('button');
                                                                                        presetLoadButton.textContent = 'Load';
                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                            reset(preset.seed, preset.params);
                                                                                        });
                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                            presetListElement.innerHTML = '';
                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                let presetItem = document.createElement('div');
                                                                                                presetItem.textContent = presetName;
                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                    reset(preset.seed, preset.params);
                                                                                                });
                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                    presetListElement.innerHTML = '';
                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                        let presetItem = document.createElement('div');
                                                                                                        presetItem.textContent = presetName;
                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                            reset(preset.seed, preset.params);
                                                                                                        });
                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                            presetListElement.innerHTML = '';
                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                let presetItem = document.createElement('div');
                                                                                                                presetItem.textContent = presetName;
                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                });
                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                        presetItem.textContent = presetName;
                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                        });
                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                });
                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                        });
                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                });
                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                        });
                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                });
                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                        });
                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                });
                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                        });
                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                });
                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                        });
                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                });
                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                        });
                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                                presetItem.appendChild(presetDeleteButton);
                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                });
                                                                                                                                                                                                                            });
                                                                                                                                                                                                                            presetItem.appendChild(presetDeleteButton);
                                                                                                                                                                                                                        });
                                                                                                                                                                                                                    });
                                                                                                                                                                                                                });
                                                                                                                                                                                                            });
                                                                                                                                                                                                        });
                                                                                                                                                                                                    });
                                                                                                                                                                                                });
                                                                                                                                                                                            });
                                                                                                                                                                                        });
                                                                                                                                                                                    });
                                                                                                                                                                                });
                                                                                                                                                                            });
                                                                                                                                                                        });
                                                                                                                                                                    });
                                                                                                                                                                });
                                                                                                                                                            });
                                                                                                                                                        });
                                                                                                                                                    });
                                                                                                                                                });
                                                                                                                                            });
                                                                                                                                        });
                                                                                                                                    });
                                                                                                                                    presetListElement.appendChild(presetItem);
                    }
                }
            }
            presetListElement.innerHTML = '';
            for (let presetName in localStorage['ecolab.presets']) {
                let preset = localStorage['ecolab.presets'][presetName];
                let presetItem = document.createElement('div');
                presetItem.textContent = presetName;
                let presetLoadButton = document.createElement('button');
                presetLoadButton.textContent = 'Load';
                presetLoadButton.addEventListener('click', () => {
                    reset(preset.seed, preset.params);
                });
                presetItem.appendChild(presetLoadButton);
                let presetDeleteButton = document.createElement('button');
                presetDeleteButton.textContent = 'Delete';
                presetDeleteButton.addEventListener('click', () => {
                    delete localStorage['ecolab.presets'][presetName];
                    presetListElement.innerHTML = '';
                    for (let presetName in localStorage['ecolab.presets']) {
                        let presetItem = document.createElement('div');
                        presetItem.textContent = presetName;
                        let presetLoadButton = document.createElement('button');
                        presetLoadButton.textContent = 'Load';
                        presetLoadButton.addEventListener('click', () => {
                            reset(preset.seed, preset.params);
                        });
                        presetItem.appendChild(presetLoadButton);
                        let presetDeleteButton = document.createElement('button');
                        presetDeleteButton.textContent = 'Delete';
                        presetDeleteButton.addEventListener('click', () => {
                            delete localStorage['ecolab.presets'][presetName];
                            presetListElement.innerHTML = '';
                            for (let presetName in localStorage['ecolab.presets']) {
                                let presetItem = document.createElement('div');
                                presetItem.textContent = presetName;
                                let presetLoadButton = document.createElement('button');
                                presetLoadButton.textContent = 'Load';
                                presetLoadButton.addEventListener('click', () => {
                                    reset(preset.seed, preset.params);
                                });
                                presetItem.appendChild(presetLoadButton);
                                let presetDeleteButton = document.createElement('button');
                                presetDeleteButton.textContent = 'Delete';
                                presetDeleteButton.addEventListener('click', () => {
                                    delete localStorage['ecolab.presets'][presetName];
                                    presetListElement.innerHTML = '';
                                    for (let presetName in localStorage['ecolab.presets']) {
                                        let presetItem = document.createElement('div');
                                        presetItem.textContent = presetName;
                                        let presetLoadButton = document.createElement('button');
                                        presetLoadButton.textContent = 'Load';
                                        presetLoadButton.addEventListener('click', () => {
                                            reset(preset.seed, preset.params);
                                        });
                                        presetItem.appendChild(presetLoadButton);
                                        let presetDeleteButton = document.createElement('button');
                                        presetDeleteButton.textContent = 'Delete';
                                        presetDeleteButton.addEventListener('click', () => {
                                            delete localStorage['ecolab.presets'][presetName];
                                            presetListElement.innerHTML = '';
                                            for (let presetName in localStorage['ecolab.presets']) {
                                                let presetItem = document.createElement('div');
                                                presetItem.textContent = presetName;
                                                let presetLoadButton = document.createElement('button');
                                                presetLoadButton.textContent = 'Load';
                                                presetLoadButton.addEventListener('click', () => {
                                                    reset(preset.seed, preset.params);
                                                });
                                                presetItem.appendChild(presetLoadButton);
                                                let presetDeleteButton = document.createElement('button');
                                                presetDeleteButton.textContent = 'Delete';
                                                presetDeleteButton.addEventListener('click', () => {
                                                    delete localStorage['ecolab.presets'][presetName];
                                                    presetListElement.innerHTML = '';
                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                        let presetItem = document.createElement('div');
                                                        presetItem.textContent = presetName;
                                                        let presetLoadButton = document.createElement('button');
                                                        presetLoadButton.textContent = 'Load';
                                                        presetLoadButton.addEventListener('click', () => {
                                                            reset(preset.seed, preset.params);
                                                        });
                                                        presetItem.appendChild(presetLoadButton);
                                                        let presetDeleteButton = document.createElement('button');
                                                        presetDeleteButton.textContent = 'Delete';
                                                        presetDeleteButton.addEventListener('click', () => {
                                                            delete localStorage['ecolab.presets'][presetName];
                                                            presetListElement.innerHTML = '';
                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                let presetItem = document.createElement('div');
                                                                presetItem.textContent = presetName;
                                                                let presetLoadButton = document.createElement('button');
                                                                presetLoadButton.textContent = 'Load';
                                                                presetLoadButton.addEventListener('click', () => {
                                                                    reset(preset.seed, preset.params);
                                                                });
                                                                presetItem.appendChild(presetLoadButton);
                                                                let presetDeleteButton = document.createElement('button');
                                                                presetDeleteButton.textContent = 'Delete';
                                                                presetDeleteButton.addEventListener('click', () => {
                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                    presetListElement.innerHTML = '';
                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                        let presetItem = document.createElement('div');
                                                                        presetItem.textContent = presetName;
                                                                        let presetLoadButton = document.createElement('button');
                                                                        presetLoadButton.textContent = 'Load';
                                                                        presetLoadButton.addEventListener('click', () => {
                                                                            reset(preset.seed, preset.params);
                                                                        });
                                                                        presetItem.appendChild(presetLoadButton);
                                                                        let presetDeleteButton = document.createElement('button');
                                                                        presetDeleteButton.textContent = 'Delete';
                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                            presetListElement.innerHTML = '';
                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                let presetItem = document.createElement('div');
                                                                                presetItem.textContent = presetName;
                                                                                let presetLoadButton = document.createElement('button');
                                                                                presetLoadButton.textContent = 'Load';
                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                    reset(preset.seed, preset.params);
                                                                                });
                                                                                presetItem.appendChild(presetLoadButton);
                                                                                let presetDeleteButton = document.createElement('button');
                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                    presetListElement.innerHTML = '';
                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                        let presetItem = document.createElement('div');
                                                                                        presetItem.textContent = presetName;
                                                                                        let presetLoadButton = document.createElement('button');
                                                                                        presetLoadButton.textContent = 'Load';
                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                            reset(preset.seed, preset.params);
                                                                                        });
                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                            presetListElement.innerHTML = '';
                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                let presetItem = document.createElement('div');
                                                                                                presetItem.textContent = presetName;
                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                    reset(preset.seed, preset.params);
                                                                                                });
                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                    presetListElement.innerHTML = '';
                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                        let presetItem = document.createElement('div');
                                                                                                        presetItem.textContent = presetName;
                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                            reset(preset.seed, preset.params);
                                                                                                        });
                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                            presetListElement.innerHTML = '';
                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                let presetItem = document.createElement('div');
                                                                                                                presetItem.textContent = presetName;
                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                });
                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                        presetItem.textContent = presetName;
                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                        });
                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                });
                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                        });
                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                });
                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                        });
                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                });
                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                        });
                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                });
                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                        });
                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                });
                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                        });
                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                });
                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                        });
                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                });
                                                                                                                                                                                                                            });
                                                                                                                                                                                                                        });
                                                                                                                                                                                                                    });
                                                                                                                                                                                                                });
                                                                                                                                                                                                            });
                                                                                                                                                                                                        });
                                                                                                                                                                                                    });
                                                                                                                                                                                                });
                                                                                                                                                                                            });
                                                                                                                                                                                        });
                                                                                                                                                                                    });
                                                                                                                                                                                });
                                                                                                                                                                            });
                                                                                                                                                                        });
                                                                                                                                                                    });
                                                                                                                                                                });
                                                                                                                                                            });
                                                                                                                                                        });
                                                                                                                                                    });
                                                                                                                                                });
                                                                                                                                            });
                                                                                                                                        });
                                                                                                                                    });
                    }
                }
            }
            presetListElement.innerHTML = '';
            for (let presetName in localStorage['ecolab.presets']) {
                let preset = localStorage['ecolab.presets'][presetName];
                let presetItem = document.createElement('div');
                presetItem.textContent = presetName;
                let presetLoadButton = document.createElement('button');
                presetLoadButton.textContent = 'Load';
                presetLoadButton.addEventListener('click', () => {
                    reset(preset.seed, preset.params);
                });
                presetItem.appendChild(presetLoadButton);
                let presetDeleteButton = document.createElement('button');
                presetDeleteButton.textContent = 'Delete';
                presetDeleteButton.addEventListener('click', () => {
                    delete localStorage['ecolab.presets'][presetName];
                    presetListElement.innerHTML = '';
                    for (let presetName in localStorage['ecolab.presets']) {
                        let presetItem = document.createElement('div');
                        presetItem.textContent = presetName;
                        let presetLoadButton = document.createElement('button');
                        presetLoadButton.textContent = 'Load';
                        presetLoadButton.addEventListener('click', () => {
                            reset(preset.seed, preset.params);
                        });
                        presetItem.appendChild(presetLoadButton);
                        let presetDeleteButton = document.createElement('button');
                        presetDeleteButton.textContent = 'Delete';
                        presetDeleteButton.addEventListener('click', () => {
                            delete localStorage['ecolab.presets'][presetName];
                            presetListElement.innerHTML = '';
                            for (let presetName in localStorage['ecolab.presets']) {
                                let presetItem = document.createElement('div');
                                presetItem.textContent = presetName;
                                let presetLoadButton = document.createElement('button');
                                presetLoadButton.textContent = 'Load';
                                presetLoadButton.addEventListener('click', () => {
                                    reset(preset.seed, preset.params);
                                });
                                presetItem.appendChild(presetLoadButton);
                                let presetDeleteButton = document.createElement('button');
                                presetDeleteButton.textContent = 'Delete';
                                presetDeleteButton.addEventListener('click', () => {
                                    delete localStorage['ecolab.presets'][presetName];
                                    presetListElement.innerHTML = '';
                                    for (let presetName in localStorage['ecolab.presets']) {
                                        let presetItem = document.createElement('div');
                                        presetItem.textContent = presetName;
                                        let presetLoadButton = document.createElement('button');
                                        presetLoadButton.textContent = 'Load';
                                        presetLoadButton.addEventListener('click', () => {
                                            reset(preset.seed, preset.params);
                                        });
                                        presetItem.appendChild(presetLoadButton);
                                        let presetDeleteButton = document.createElement('button');
                                        presetDeleteButton.textContent = 'Delete';
                                        presetDeleteButton.addEventListener('click', () => {
                                            delete localStorage['ecolab.presets'][presetName];
                                            presetListElement.innerHTML = '';
                                            for (let presetName in localStorage['ecolab.presets']) {
                                                let presetItem = document.createElement('div');
                                                presetItem.textContent = presetName;
                                                let presetLoadButton = document.createElement('button');
                                                presetLoadButton.textContent = 'Load';
                                                presetLoadButton.addEventListener('click', () => {
                                                    reset(preset.seed, preset.params);
                                                });
                                                presetItem.appendChild(presetLoadButton);
                                                let presetDeleteButton = document.createElement('button');
                                                presetDeleteButton.textContent = 'Delete';
                                                presetDeleteButton.addEventListener('click', () => {
                                                    delete localStorage['ecolab.presets'][presetName];
                                                    presetListElement.innerHTML = '';
                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                        let presetItem = document.createElement('div');
                                                        presetItem.textContent = presetName;
                                                        let presetLoadButton = document.createElement('button');
                                                        presetLoadButton.textContent = 'Load';
                                                        presetLoadButton.addEventListener('click', () => {
                                                            reset(preset.seed, preset.params);
                                                        });
                                                        presetItem.appendChild(presetLoadButton);
                                                        let presetDeleteButton = document.createElement('button');
                                                        presetDeleteButton.textContent = 'Delete';
                                                        presetDeleteButton.addEventListener('click', () => {
                                                            delete localStorage['ecolab.presets'][presetName];
                                                            presetListElement.innerHTML = '';
                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                let presetItem = document.createElement('div');
                                                                presetItem.textContent = presetName;
                                                                let presetLoadButton = document.createElement('button');
                                                                presetLoadButton.textContent = 'Load';
                                                                presetLoadButton.addEventListener('click', () => {
                                                                    reset(preset.seed, preset.params);
                                                                });
                                                                presetItem.appendChild(presetLoadButton);
                                                                let presetDeleteButton = document.createElement('button');
                                                                presetDeleteButton.textContent = 'Delete';
                                                                presetDeleteButton.addEventListener('click', () => {
                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                    presetListElement.innerHTML = '';
                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                        let presetItem = document.createElement('div');
                                                                        presetItem.textContent = presetName;
                                                                        let presetLoadButton = document.createElement('button');
                                                                        presetLoadButton.textContent = 'Load';
                                                                        presetLoadButton.addEventListener('click', () => {
                                                                            reset(preset.seed, preset.params);
                                                                        });
                                                                        presetItem.appendChild(presetLoadButton);
                                                                        let presetDeleteButton = document.createElement('button');
                                                                        presetDeleteButton.textContent = 'Delete';
                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                            presetListElement.innerHTML = '';
                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                let presetItem = document.createElement('div');
                                                                                presetItem.textContent = presetName;
                                                                                let presetLoadButton = document.createElement('button');
                                                                                presetLoadButton.textContent = 'Load';
                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                    reset(preset.seed, preset.params);
                                                                                });
                                                                                presetItem.appendChild(presetLoadButton);
                                                                                let presetDeleteButton = document.createElement('button');
                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                    presetListElement.innerHTML = '';
                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                        let presetItem = document.createElement('div');
                                                                                        presetItem.textContent = presetName;
                                                                                        let presetLoadButton = document.createElement('button');
                                                                                        presetLoadButton.textContent = 'Load';
                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                            reset(preset.seed, preset.params);
                                                                                        });
                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                            presetListElement.innerHTML = '';
                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                let presetItem = document.createElement('div');
                                                                                                presetItem.textContent = presetName;
                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                    reset(preset.seed, preset.params);
                                                                                                });
                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                    presetListElement.innerHTML = '';
                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                        let presetItem = document.createElement('div');
                                                                                                        presetItem.textContent = presetName;
                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                            reset(preset.seed, preset.params);
                                                                                                        });
                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                            presetListElement.innerHTML = '';
                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                let presetItem = document.createElement('div');
                                                                                                                presetItem.textContent = presetName;
                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                });
                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                        presetItem.textContent = presetName;
                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                        });
                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                });
                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                        });
                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                });
                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                        });
                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                });
                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                        });
                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                });
                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                        });
                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                });
                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                        });
                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                });
                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                        });
                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                });
                                                                                                                                                                                                                            });
                                                                                                                                                                                                                        });
                                                                                                                                                                                                                    });
                                                                                                                                                                                                                });
                                                                                                                                                                                                            });
                                                                                                                                                                                                        });
                                                                                                                                                                                                    });
                                                                                                                                                                                                });
                                                                                                                                                                                            });
                                                                                                                                                                                        });
                                                                                                                                                                                    });
                                                                                                                                                                                });
                                                                                                                                                                            });
                                                                                                                                                                        });
                                                                                                                                                                    });
                                                                                                                                                                });
                                                                                                                                                            });
                                                                                                                                                        });
                                                                                                                                                    });
                                                                                                                                                });
                                                                                                                                            });
                                                                                                                                        });
                                                                                                                                    });
                    }
                }
            }
            presetListElement.innerHTML = '';
            for (let presetName in localStorage['ecolab.presets']) {
                let preset = localStorage['ecolab.presets'][presetName];
                let presetItem = document.createElement('div');
                presetItem.textContent = presetName;
                let presetLoadButton = document.createElement('button');
                presetLoadButton.textContent = 'Load';
                presetLoadButton.addEventListener('click', () => {
                    reset(preset.seed, preset.params);
                });
                presetItem.appendChild(presetLoadButton);
                let presetDeleteButton = document.createElement('button');
                presetDeleteButton.textContent = 'Delete';
                presetDeleteButton.addEventListener('click', () => {
                    delete localStorage['ecolab.presets'][presetName];
                    presetListElement.innerHTML = '';
                    for (let presetName in localStorage['ecolab.presets']) {
                        let presetItem = document.createElement('div');
                        presetItem.textContent = presetName;
                        let presetLoadButton = document.createElement('button');
                        presetLoadButton.textContent = 'Load';
                        presetLoadButton.addEventListener('click', () => {
                            reset(preset.seed, preset.params);
                        });
                        presetItem.appendChild(presetLoadButton);
                        let presetDeleteButton = document.createElement('button');
                        presetDeleteButton.textContent = 'Delete';
                        presetDeleteButton.addEventListener('click', () => {
                            delete localStorage['ecolab.presets'][presetName];
                            presetListElement.innerHTML = '';
                            for (let presetName in localStorage['ecolab.presets']) {
                                let presetItem = document.createElement('div');
                                presetItem.textContent = presetName;
                                let presetLoadButton = document.createElement('button');
                                presetLoadButton.textContent = 'Load';
                                presetLoadButton.addEventListener('click', () => {
                                    reset(preset.seed, preset.params);
                                });
                                presetItem.appendChild(presetLoadButton);
                                let presetDeleteButton = document.createElement('button');
                                presetDeleteButton.textContent = 'Delete';
                                presetDeleteButton.addEventListener('click', () => {
                                    delete localStorage['ecolab.presets'][presetName];
                                    presetListElement.innerHTML = '';
                                    for (let presetName in localStorage['ecolab.presets']) {
                                        let presetItem = document.createElement('div');
                                        presetItem.textContent = presetName;
                                        let presetLoadButton = document.createElement('button');
                                        presetLoadButton.textContent = 'Load';
                                        presetLoadButton.addEventListener('click', () => {
                                            reset(preset.seed, preset.params);
                                        });
                                        presetItem.appendChild(presetLoadButton);
                                        let presetDeleteButton = document.createElement('button');
                                        presetDeleteButton.textContent = 'Delete';
                                        presetDeleteButton.addEventListener('click', () => {
                                            delete localStorage['ecolab.presets'][presetName];
                                            presetListElement.innerHTML = '';
                                            for (let presetName in localStorage['ecolab.presets']) {
                                                let presetItem = document.createElement('div');
                                                presetItem.textContent = presetName;
                                                let presetLoadButton = document.createElement('button');
                                                presetLoadButton.textContent = 'Load';
                                                presetLoadButton.addEventListener('click', () => {
                                                    reset(preset.seed, preset.params);
                                                });
                                                presetItem.appendChild(presetLoadButton);
                                                let presetDeleteButton = document.createElement('button');
                                                presetDeleteButton.textContent = 'Delete';
                                                presetDeleteButton.addEventListener('click', () => {
                                                    delete localStorage['ecolab.presets'][presetName];
                                                    presetListElement.innerHTML = '';
                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                        let presetItem = document.createElement('div');
                                                        presetItem.textContent = presetName;
                                                        let presetLoadButton = document.createElement('button');
                                                        presetLoadButton.textContent = 'Load';
                                                        presetLoadButton.addEventListener('click', () => {
                                                            reset(preset.seed, preset.params);
                                                        });
                                                        presetItem.appendChild(presetLoadButton);
                                                        let presetDeleteButton = document.createElement('button');
                                                        presetDeleteButton.textContent = 'Delete';
                                                        presetDeleteButton.addEventListener('click', () => {
                                                            delete localStorage['ecolab.presets'][presetName];
                                                            presetListElement.innerHTML = '';
                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                let presetItem = document.createElement('div');
                                                                presetItem.textContent = presetName;
                                                                let presetLoadButton = document.createElement('button');
                                                                presetLoadButton.textContent = 'Load';
                                                                presetLoadButton.addEventListener('click', () => {
                                                                    reset(preset.seed, preset.params);
                                                                });
                                                                presetItem.appendChild(presetLoadButton);
                                                                let presetDeleteButton = document.createElement('button');
                                                                presetDeleteButton.textContent = 'Delete';
                                                                presetDeleteButton.addEventListener('click', () => {
                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                    presetListElement.innerHTML = '';
                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                        let presetItem = document.createElement('div');
                                                                        presetItem.textContent = presetName;
                                                                        let presetLoadButton = document.createElement('button');
                                                                        presetLoadButton.textContent = 'Load';
                                                                        presetLoadButton.addEventListener('click', () => {
                                                                            reset(preset.seed, preset.params);
                                                                        });
                                                                        presetItem.appendChild(presetLoadButton);
                                                                        let presetDeleteButton = document.createElement('button');
                                                                        presetDeleteButton.textContent = 'Delete';
                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                            presetListElement.innerHTML = '';
                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                let presetItem = document.createElement('div');
                                                                                presetItem.textContent = presetName;
                                                                                let presetLoadButton = document.createElement('button');
                                                                                presetLoadButton.textContent = 'Load';
                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                    reset(preset.seed, preset.params);
                                                                                });
                                                                                presetItem.appendChild(presetLoadButton);
                                                                                let presetDeleteButton = document.createElement('button');
                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                    presetListElement.innerHTML = '';
                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                        let presetItem = document.createElement('div');
                                                                                        presetItem.textContent = presetName;
                                                                                        let presetLoadButton = document.createElement('button');
                                                                                        presetLoadButton.textContent = 'Load';
                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                            reset(preset.seed, preset.params);
                                                                                        });
                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                            presetListElement.innerHTML = '';
                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                let presetItem = document.createElement('div');
                                                                                                presetItem.textContent = presetName;
                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                    reset(preset.seed, preset.params);
                                                                                                });
                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                    presetListElement.innerHTML = '';
                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                        let presetItem = document.createElement('div');
                                                                                                        presetItem.textContent = presetName;
                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                            reset(preset.seed, preset.params);
                                                                                                        });
                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                            presetListElement.innerHTML = '';
                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                let presetItem = document.createElement('div');
                                                                                                                presetItem.textContent = presetName;
                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                });
                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                        presetItem.textContent = presetName;
                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                        });
                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                });
                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                        });
                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                });
                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                        });
                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                });
                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                        });
                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                });
                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                        });
                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                });
                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                        });
                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                });
                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                        });
                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                });
                                                                                                                                                                                                                            });
                                                                                                                                                                                                                        });
                                                                                                                                                                                                                    });
                                                                                                                                                                                                                });
                                                                                                                                                                                                            });
                                                                                                                                                                                                        });
                                                                                                                                                                                                    });
                                                                                                                                                                                                });
                                                                                                                                                                                            });
                                                                                                                                                                                        });
                                                                                                                                                                                    });
                                                                                                                                                                                });
                                                                                                                                                                            });
                                                                                                                                                                        });
                                                                                                                                                                    });
                                                                                                                                                                });
                                                                                                                                                            });
                                                                                                                                                        });
                                                                                                                                                    });
                                                                                                                                                });
                                                                                                                                            });
                                                                                                                                        });
                                                                                                                                    });
                    }
                }
            }
            presetListElement.innerHTML = '';
            for (let presetName in localStorage['ecolab.presets']) {
                let preset = localStorage['ecolab.presets'][presetName];
                let presetItem = document.createElement('div');
                presetItem.textContent = presetName;
                let presetLoadButton = document.createElement('button');
                presetLoadButton.textContent = 'Load';
                presetLoadButton.addEventListener('click', () => {
                    reset(preset.seed, preset.params);
                });
                presetItem.appendChild(presetLoadButton);
                let presetDeleteButton = document.createElement('button');
                presetDeleteButton.textContent = 'Delete';
                presetDeleteButton.addEventListener('click', () => {
                    delete localStorage['ecolab.presets'][presetName];
                    presetListElement.innerHTML = '';
                    for (let presetName in localStorage['ecolab.presets']) {
                        let presetItem = document.createElement('div');
                        presetItem.textContent = presetName;
                        let presetLoadButton = document.createElement('button');
                        presetLoadButton.textContent = 'Load';
                        presetLoadButton.addEventListener('click', () => {
                            reset(preset.seed, preset.params);
                        });
                        presetItem.appendChild(presetLoadButton);
                        let presetDeleteButton = document.createElement('button');
                        presetDeleteButton.textContent = 'Delete';
                        presetDeleteButton.addEventListener('click', () => {
                            delete localStorage['ecolab.presets'][presetName];
                            presetListElement.innerHTML = '';
                            for (let presetName in localStorage['ecolab.presets']) {
                                let presetItem = document.createElement('div');
                                presetItem.textContent = presetName;
                                let presetLoadButton = document.createElement('button');
                                presetLoadButton.textContent = 'Load';
                                presetLoadButton.addEventListener('click', () => {
                                    reset(preset.seed, preset.params);
                                });
                                presetItem.appendChild(presetLoadButton);
                                let presetDeleteButton = document.createElement('button');
                                presetDeleteButton.textContent = 'Delete';
                                presetDeleteButton.addEventListener('click', () => {
                                    delete localStorage['ecolab.presets'][presetName];
                                    presetListElement.innerHTML = '';
                                    for (let presetName in localStorage['ecolab.presets']) {
                                        let presetItem = document.createElement('div');
                                        presetItem.textContent = presetName;
                                        let presetLoadButton = document.createElement('button');
                                        presetLoadButton.textContent = 'Load';
                                        presetLoadButton.addEventListener('click', () => {
                                            reset(preset.seed, preset.params);
                                        });
                                        presetItem.appendChild(presetLoadButton);
                                        let presetDeleteButton = document.createElement('button');
                                        presetDeleteButton.textContent = 'Delete';
                                        presetDeleteButton.addEventListener('click', () => {
                                            delete localStorage['ecolab.presets'][presetName];
                                            presetListElement.innerHTML = '';
                                            for (let presetName in localStorage['ecolab.presets']) {
                                                let presetItem = document.createElement('div');
                                                presetItem.textContent = presetName;
                                                let presetLoadButton = document.createElement('button');
                                                presetLoadButton.textContent = 'Load';
                                                presetLoadButton.addEventListener('click', () => {
                                                    reset(preset.seed, preset.params);
                                                });
                                                presetItem.appendChild(presetLoadButton);
                                                let presetDeleteButton = document.createElement('button');
                                                presetDeleteButton.textContent = 'Delete';
                                                presetDeleteButton.addEventListener('click', () => {
                                                    delete localStorage['ecolab.presets'][presetName];
                                                    presetListElement.innerHTML = '';
                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                        let presetItem = document.createElement('div');
                                                        presetItem.textContent = presetName;
                                                        let presetLoadButton = document.createElement('button');
                                                        presetLoadButton.textContent = 'Load';
                                                        presetLoadButton.addEventListener('click', () => {
                                                            reset(preset.seed, preset.params);
                                                        });
                                                        presetItem.appendChild(presetLoadButton);
                                                        let presetDeleteButton = document.createElement('button');
                                                        presetDeleteButton.textContent = 'Delete';
                                                        presetDeleteButton.addEventListener('click', () => {
                                                            delete localStorage['ecolab.presets'][presetName];
                                                            presetListElement.innerHTML = '';
                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                let presetItem = document.createElement('div');
                                                                presetItem.textContent = presetName;
                                                                let presetLoadButton = document.createElement('button');
                                                                presetLoadButton.textContent = 'Load';
                                                                presetLoadButton.addEventListener('click', () => {
                                                                    reset(preset.seed, preset.params);
                                                                });
                                                                presetItem.appendChild(presetLoadButton);
                                                                let presetDeleteButton = document.createElement('button');
                                                                presetDeleteButton.textContent = 'Delete';
                                                                presetDeleteButton.addEventListener('click', () => {
                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                    presetListElement.innerHTML = '';
                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                        let presetItem = document.createElement('div');
                                                                        presetItem.textContent = presetName;
                                                                        let presetLoadButton = document.createElement('button');
                                                                        presetLoadButton.textContent = 'Load';
                                                                        presetLoadButton.addEventListener('click', () => {
                                                                            reset(preset.seed, preset.params);
                                                                        });
                                                                        presetItem.appendChild(presetLoadButton);
                                                                        let presetDeleteButton = document.createElement('button');
                                                                        presetDeleteButton.textContent = 'Delete';
                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                            presetListElement.innerHTML = '';
                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                let presetItem = document.createElement('div');
                                                                                presetItem.textContent = presetName;
                                                                                let presetLoadButton = document.createElement('button');
                                                                                presetLoadButton.textContent = 'Load';
                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                    reset(preset.seed, preset.params);
                                                                                });
                                                                                presetItem.appendChild(presetLoadButton);
                                                                                let presetDeleteButton = document.createElement('button');
                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                    presetListElement.innerHTML = '';
                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                        let presetItem = document.createElement('div');
                                                                                        presetItem.textContent = presetName;
                                                                                        let presetLoadButton = document.createElement('button');
                                                                                        presetLoadButton.textContent = 'Load';
                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                            reset(preset.seed, preset.params);
                                                                                        });
                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                            presetListElement.innerHTML = '';
                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                let presetItem = document.createElement('div');
                                                                                                presetItem.textContent = presetName;
                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                    reset(preset.seed, preset.params);
                                                                                                });
                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                    presetListElement.innerHTML = '';
                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                        let presetItem = document.createElement('div');
                                                                                                        presetItem.textContent = presetName;
                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                            reset(preset.seed, preset.params);
                                                                                                        });
                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                            presetListElement.innerHTML = '';
                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                let presetItem = document.createElement('div');
                                                                                                                presetItem.textContent = presetName;
                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                });
                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                        presetItem.textContent = presetName;
                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                        });
                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                });
                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                        });
                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                });
                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                        });
                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                });
                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                        });
                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                });
                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                        });
                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                });
                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                        });
                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                });
                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                        });
                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                            });
                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                });
                                                                                                                                                                                                                            });
                                                                                                                                                                                                                        });
                                                                                                                                                                                                                    });
                                                                                                                                                                                                                });
                                                                                                                                                                                                            });
                                                                                                                                                                                                        });
                                                                                                                                                                                                    });
                                                                                                                                                                                                });
                                                                                                                                                                                            });
                                                                                                                                                                                        });
                                                                                                                                                                                    });
                                                                                                                                                                                });
                                                                                                                                                                            });
                                                                                                                                                                        });
                                                                                                                                                                    });
                                                                                                                                                                });
                                                                                                                                                            });
                                                                                                                                                        });
                                                                                                                                                    });
                                                                                                                                                });
                                                                                                                                            });
                                                                                                                                        });
                                                                                                                                    });
                    }
                }
            }
            presetListElement.innerHTML = '';
            for (let presetName in localStorage['ecolab.presets']) {
                let preset = localStorage['ecolab.presets'][presetName];
                let presetItem = document.createElement('div');
                presetItem.textContent = presetName;
                let presetLoadButton = document.createElement('button');
                presetLoadButton.textContent = 'Load';
                presetLoadButton.addEventListener('click', () => {
                    reset(preset.seed, preset.params);
                });
                presetItem.appendChild(presetLoadButton);
                let presetDeleteButton = document.createElement('button');
                presetDeleteButton.textContent = 'Delete';
                presetDeleteButton.addEventListener('click', () => {
                    delete localStorage['ecolab.presets'][presetName];
                    presetListElement.innerHTML = '';
                    for (let presetName in localStorage['ecolab.presets']) {
                        let presetItem = document.createElement('div');
                        presetItem.textContent = presetName;
                        let presetLoadButton = document.createElement('button');
                        presetLoadButton.textContent = 'Load';
                        presetLoadButton.addEventListener('click', () => {
                            reset(preset.seed, preset.params);
                        });
                        presetItem.appendChild(presetLoadButton);
                        let presetDeleteButton = document.createElement('button');
                        presetDeleteButton.textContent = 'Delete';
                        presetDeleteButton.addEventListener('click', () => {
                            delete localStorage['ecolab.presets'][presetName];
                            presetListElement.innerHTML = '';
                            for (let presetName in localStorage['ecolab.presets']) {
                                let presetItem = document.createElement('div');
                                presetItem.textContent = presetName;
                                let presetLoadButton = document.createElement('button');
                                presetLoadButton.textContent = 'Load';
                                presetLoadButton.addEventListener('click', () => {
                                    reset(preset.seed, preset.params);
                                });
                                presetItem.appendChild(presetLoadButton);
                                let presetDeleteButton = document.createElement('button');
                                presetDeleteButton.textContent = 'Delete';
                                presetDeleteButton.addEventListener('click', () => {
                                    delete localStorage['ecolab.presets'][presetName];
                                    presetListElement.innerHTML = '';
                                    for (let presetName in localStorage['ecolab.presets']) {
                                        let presetItem = document.createElement('div');
                                        presetItem.textContent = presetName;
                                        let presetLoadButton = document.createElement('button');
                                        presetLoadButton.textContent = 'Load';
                                        presetLoadButton.addEventListener('click', () => {
                                            reset(preset.seed, preset.params);
                                        });
                                        presetItem.appendChild(presetLoadButton);
                                        let presetDeleteButton = document.createElement('button');
                                        presetDeleteButton.textContent = 'Delete';
                                        presetDeleteButton.addEventListener('click', () => {
                                            delete localStorage['ecolab.presets'][presetName];
                                            presetListElement.innerHTML = '';
                                            for (let presetName in localStorage['ecolab.presets']) {
                                                let presetItem = document.createElement('div');
                                                presetItem.textContent = presetName;
                                                let presetLoadButton = document.createElement('button');
                                                presetLoadButton.textContent = 'Load';
                                                presetLoadButton.addEventListener('click', () => {
                                                    reset(preset.seed, preset.params);
                                                });
                                                presetItem.appendChild(presetLoadButton);
                                                let presetDeleteButton = document.createElement('button');
                                                presetDeleteButton.textContent = 'Delete';
                                                presetDeleteButton.addEventListener('click', () => {
                                                    delete localStorage['ecolab.presets'][presetName];
                                                    presetListElement.innerHTML = '';
                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                        let presetItem = document.createElement('div');
                                                        presetItem.textContent = presetName;
                                                        let presetLoadButton = document.createElement('button');
                                                        presetLoadButton.textContent = 'Load';
                                                        presetLoadButton.addEventListener('click', () => {
                                                            reset(preset.seed, preset.params);
                                                        });
                                                        presetItem.appendChild(presetLoadButton);
                                                        let presetDeleteButton = document.createElement('button');
                                                        presetDeleteButton.textContent = 'Delete';
                                                        presetDeleteButton.addEventListener('click', () => {
                                                            delete localStorage['ecolab.presets'][presetName];
                                                            presetListElement.innerHTML = '';
                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                let presetItem = document.createElement('div');
                                                                presetItem.textContent = presetName;
                                                                let presetLoadButton = document.createElement('button');
                                                                presetLoadButton.textContent = 'Load';
                                                                presetLoadButton.addEventListener('click', () => {
                                                                    reset(preset.seed, preset.params);
                                                                });
                                                                presetItem.appendChild(presetLoadButton);
                                                                let presetDeleteButton = document.createElement('button');
                                                                presetDeleteButton.textContent = 'Delete';
                                                                presetDeleteButton.addEventListener('click', () => {
                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                    presetListElement.innerHTML = '';
                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                        let presetItem = document.createElement('div');
                                                                        presetItem.textContent = presetName;
                                                                        let presetLoadButton = document.createElement('button');
                                                                        presetLoadButton.textContent = 'Load';
                                                                        presetLoadButton.addEventListener('click', () => {
                                                                            reset(preset.seed, preset.params);
                                                                        });
                                                                        presetItem.appendChild(presetLoadButton);
                                                                        let presetDeleteButton = document.createElement('button');
                                                                        presetDeleteButton.textContent = 'Delete';
                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                            presetListElement.innerHTML = '';
                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                let presetItem = document.createElement('div');
                                                                                presetItem.textContent = presetName;
                                                                                let presetLoadButton = document.createElement('button');
                                                                                presetLoadButton.textContent = 'Load';
                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                    reset(preset.seed, preset.params);
                                                                                });
                                                                                presetItem.appendChild(presetLoadButton);
                                                                                let presetDeleteButton = document.createElement('button');
                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                    presetListElement.innerHTML = '';
                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                        let presetItem = document.createElement('div');
                                                                                        presetItem.textContent = presetName;
                                                                                        let presetLoadButton = document.createElement('button');
                                                                                        presetLoadButton.textContent = 'Load';
                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                            reset(preset.seed, preset.params);
                                                                                        });
                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                            presetListElement.innerHTML = '';
                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                let presetItem = document.createElement('div');
                                                                                                presetItem.textContent = presetName;
                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                    reset(preset.seed, preset.params);
                                                                                                });
                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                    presetListElement.innerHTML = '';
                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                        let presetItem = document.createElement('div');
                                                                                                        presetItem.textContent = presetName;
                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                            reset(preset.seed, preset.params);
                                                                                                        });
                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                            presetListElement.innerHTML = '';
                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                let presetItem = document.createElement('div');
                                                                                                                presetItem.textContent = presetName;
                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                });
                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                        presetItem.textContent = presetName;
                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                        });
                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                });
                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                        });
                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                });
                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                        });
                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                });
                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                        });
                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                });
                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                        });
                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                        presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                        presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                            delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                            presetListElement.innerHTML = '';
                                                                                                                                                                                            for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                let presetItem = document.createElement('div');
                                                                                                                                                                                                presetItem.textContent = presetName;
                                                                                                                                                                                                let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                    reset(preset.seed, preset.params);
                                                                                                                                                                                                });
                                                                                                                                                                                                presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                let presetDeleteButton = document.createElement('button');
                                                                                                                                                                                                presetDeleteButton.textContent = 'Delete';
                                                                                                                                                                                                presetDeleteButton.addEventListener('click', () => {
                                                                                                                                                                                                    delete localStorage['ecolab.presets'][presetName];
                                                                                                                                                                                                    presetListElement.innerHTML = '';
                                                                                                                                                                                                    for (let presetName in localStorage['ecolab.presets']) {
                                                                                                                                                                                                        let presetItem = document.createElement('div');
                                                                                                                                                                                                        presetItem.textContent = presetName;
                                                                                                                                                                                                        let presetLoadButton = document.createElement('button');
                                                                                                                                                                                                        presetLoadButton.textContent = 'Load';
                                                                                                                                                                                                        presetLoadButton.addEventListener('click', () => {
                                                                                                                                                                                                            reset(preset.seed, preset.params);
                                                                                                                                                                                                        });
                                                                                                                                                                                                        presetItem.appendChild(presetLoadButton);
                                                                                                                                                                                                        let presetDeleteButton = document.createElement('button');
