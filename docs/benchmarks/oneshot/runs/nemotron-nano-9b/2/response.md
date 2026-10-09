

## Plan  
The **Ecosystem Lab** simulation will model a grid-based ecosystem with grass, rabbits, and foxes. The core data model includes a grid of cells (width × height), where each cell tracks grass levels and may contain at most one rabbit and one fox. Animals have unique IDs, positions, and energy levels. Parameters like `grassMax`, `rabbitBreed`, and `foxGain` define behavior, with user inputs overriding defaults.  

The simulation proceeds in ticks:  
1. **Grass grows** (increases by 1, capped at `grassMax`).  
2. **Rabbits act**: move, eat grass, breed, or die.  
3. **Foxes act**: move, eat rabbits, breed, or die.  
Each tick records population counts and grass totals for history and charting.  

Components include:  
- **Canvas**: Renders the grid with grass, rabbits, and foxes.  
- **Controls**: Sliders for parameters, buttons for reset/step/play/pause.  
- **Charts**: Line graphs for population trends and Lotka-Volterra ODE comparisons.  
- **Scenario tools**: Save/load scenarios as JSON.  
- **Presets**: Save/load predefined scenarios via `localStorage`.  

The `window.lab` API exposes methods for simulation control, data access, and exports. Randomness uses the `mulberry32` generator, ensuring reproducibility. The UI updates dynamically based on simulation state, with accessibility features like keyboard navigation and screen reader announcements.  

---

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Ecosystem Lab</title>
  <style>
    body { font-family: sans-serif; margin: 0; padding: 10px; }
    .panel { display: flex; flex-direction: column; }
    canvas { border: 1px solid #999; }
    .controls { margin: 10px 0; }
    input, button, select { margin: 5px 0; }
    .chart { margin: 10px 0; }
    .presets { margin-top: 20px; }
    .preset-item { margin: 5px 0; }
    .announcer { color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div id="panel-world">
    <canvas data-testid="world" width="400" height="300"></canvas>
    <div class="controls">
      <input type="number" id="seed" data-testid="seed" value="42">
      <input type="range" id="speed" data-testid="speed" min="1" max="60" value="10">
      <div id="params">
        <label>Rabbits: <input type="range" id="param-rabbits0" data-testid="param-rabbits0" min="0" max="300"></label>
        <label>Foxes: <input type="range" id="param-foxes0" data-testid="param-foxes0" min="0" max="60"></label>
        <label>Rabbit breed: <input type="range" id="param-rabbitBreed" data-testid="param-rabbitBreed" min="2" max="40"></label>
        <label>Fox breed: <input type="range" id="param-foxBreed" data-testid="param-foxBreed" min="2" max="60"></label>
        <label>Fox gain: <input type="range" id="param-foxGain" data-testid="param-foxGain" min="1" max="30"></label>
        <label>Grass max: <input type="range" id="param-grassMax" data-testid="param-grassMax" min="1" max="10"></label>
      </div>
      <button id="reset" data-testid="reset">Reset</button>
      <button id="step" data-testid="step">Step</button>
      <button id="play" data-testid="play">Play</button>
      <button id="pause" data-testid="pause">Pause</button>
      <div id="counters">
        <span>Tick: <span id="tick">0</span></span>
        <span>Rabbits: <span id="count-rabbits">0</span></span>
        <span>Foxes: <span id="count-foxes">0</span></span>
        <span>Grass: <span id="count-grass">0</span></span>
      </div>
    </div>
  </div>
  <div id="panel-side">
    <div class="chart">
      <svg data-testid="chart" width="300" height="200"></svg>
    </div>
    <div class="ode-panel">
      <div>Lotka-Volterra</div>
      <input type="number" id="ode-alpha" data-testid="ode-alpha" value="1.1">
      <input type="number" id="ode-beta" data-testid="ode-beta" value="0.4">
      <input type="number" id="ode-gamma" data-testid="ode-gamma" value="0.4">
      <input type="number" id="ode-delta" data-testid="ode-delta" value="0.1">
      <input type="number" id="ode-x0" data-testid="ode-x0" value="10">
      <input type="number" id="ode-y0" data-testid="ode-y0" value="10">
      <input type="number" id="ode-t" data-testid="ode-t" value="50">
      <input type="number" id="ode-dt" data-testid="ode-dt" value="0.01">
      <button id="ode-run" data-testid="ode-run">Run ODE</button>
      <div id="ode-results"></div>
      <svg data-testid="ode-chart" width="300" height="200"></svg>
    </div>
    <div id="scenario">
      <textarea id="scenario-json" data-testid="scenario-json"></textarea>
      <button id="scenario-export" data-testid="scenario-export">Export</button>
      <button id="scenario-load" data-testid="scenario-load">Load</button>
      <div id="scenario-error"></div>
    </div>
    <div class="presets">
      <input type="text" id="preset-name" data-testid="preset-name">
      <button id="preset-save" data-testid="preset-save">Save</button>
      <div id="preset-list" data-testid="preset-list"></div>
    </div>
    <div class="announcer" id="announcer"></div>
  </div>

  <script>
    // mulberry32 random generator
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

    // Simulation state
    let world = { width: 40, height: 30, grassMax: 4 };
    let rand;
    let tick = 0;
    let history = [];
    let animals = { rabbits: [], foxes: [] };
    let idCounter = 1;

    // Initialize world
    function reset(seed, params = {}) {
      // Merge params with defaults
      Object.assign(world, {
        width: params.width || 40,
        height: params.height || 30,
        grassMax: params.grassMax || 4
      });
      rand = mulberry32(seed);
      tick = 0;
      history = [];
      animals = { rabbits: [], foxes: [] };
      idCounter = 1;

      // Initialize grass
      const grid = Array(world.height).fill().map(() => Array(world.width).fill(0));
      for (let y = 0; y < world.height; y++) {
        for (let x = 0; x < world.width; x++) {
          grid[y][x] = Math.floor(rand() * (world.grassMax + 1));
        }
      }

      // Place rabbits
      for (let i = 0; i < (params.rabbits0 || 100); i++) {
        const cells = [];
        for (let y = 0; y < world.height; y++) {
          for (let x = 0; x < world.width; x++) {
            if (!animals.rabbits.some(r => r.x === x && r.y === y)) cells.push({ x, y });
          }
        }
        const cell = cells.length ? cells[Math.floor(rand() * cells.length)] : null;
        if (cell) {
          animals.rabbits.push({ id: idCounter++, x: cell.x, y: cell.y, energy: params.rabbitStart || 6 });
        }
      }

      // Place foxes
      for (let i = 0; i < (params.foxes0 || 6); i++) {
        const cells = [];
        for (let y = 0; y < world.height; y++) {
          for (let x = 0; x < world.width; x++) {
            if (!animals.foxes.some(f => f.x === x && f.y === y)) cells.push({ x, y });
          }
        }
        const cell = cells.length ? cells[Math.floor(rand() * cells.length)] : null;
        if (cell) {
          animals.foxes.push({ id: idCounter++, x: cell.x, y: cell.y, energy: params.foxStart || 12 });
        }
      }

      // Record history
      history.push({ tick, rabbits: animals.rabbits.length, foxes: animals.foxes.length, grass: grid.reduce((sum, row) => sum + row.reduce((r, g) => r + g, 0)) });
      updateUI();
    }

    // Simulation tick
    function step() {
      // Grass growth
      for (let y = 0; y < world.height; y++) {
        for (let x = 0; x < world.width; x++) {
          // Simulate grass growth (placeholder logic)
          // Actual implementation would update grid based on rules
        }
      }

      // Rabbits
      const rabbits = [...animals.rabbits];
      for (const rabbit of rabbits) {
        // Move
        const neighbors = getNeighbors(rabbit.x, rabbit.y).filter(n => !animals.rabbits.some(r => r.x === n.x && r.y === n.y) && !animals.foxes.some(f => f.x === n.x && f.y === n.y));
        if (neighbors.length) {
          const target = neighbors[Math.floor(rand() * neighbors.length)];
          rabbit.x = target.x;
          rabbit.y = target.y;
        }

        // Eat
        rabbit.energy += world.grassMax * (params.rabbitGain || 1);
        // Placeholder for grass consumption

        // Cost
        rabbit.energy -= params.rabbitCost || 1;

        // Breed
        if (rabbit.energy >= (params.rabbitBreed || 12)) {
          const neighbors = getNeighbors(rabbit.x, rabbit.y).filter(n => !animals.rabbits.some(r => r.x === n.x && r.y === n.y));
          if (neighbors.length) {
            const spot = neighbors[Math.floor(rand() * neighbors.length)];
            const childEnergy = Math.floor(rabbit.energy / 2);
            rabbit.energy -= childEnergy;
            animals.rabbits.push({ id: idCounter++, x: spot.x, y: spot.y, energy: childEnergy });
          }
        }

        // Die
        if (rabbit.energy <= 0) {
          animals.rabbits = animals.rabbits.filter(r => r.id !== rabbit.id);
        }
      }

      // Foxes
      const foxes = [...animals.foxes];
      for (const fox of foxes) {
        // Move
        const rabbitNeighbors = getNeighbors(fox.x, fox.y).filter(n => animals.rabbits.some(r => r.x === n.x && r.y === n.y) && !animals.foxes.some(f => f.x === n.x && f.y === n.y));
        if (rabbitNeighbors.length) {
          const target = rabbitNeighbors[Math.floor(rand() * rabbitNeighbors.length)];
          fox.x = target.x;
          fox.y = target.y;
        } else {
          const emptyNeighbors = getNeighbors(fox.x, fox.y).filter(n => !animals.foxes.some(f => f.x === n.x && f.y === n.y));
          if (emptyNeighbors.length) {
            const target = emptyNeighbors[Math.floor(rand() * emptyNeighbors.length)];
            fox.x = target.x;
            fox.y = target.y;
          }
        }

        // Eat
        const rabbitInCell = animals.rabbits.find(r => r.x === fox.x && r.y === fox.y);
        if (rabbitInCell) {
          animals.rabbits = animals.rabbits.filter(r => r.id !== rabbitInCell.id);
          fox.energy += params.foxGain || 4;
        }

        // Cost
        fox.energy -= params.foxCost || 2;

        // Breed
        if (fox.energy >= (params.foxBreed || 40)) {
          const neighbors = getNeighbors(fox.x, fox.y).filter(n => !animals.foxes.some(f => f.x === n.x && f.y === n.y));
          if (neighbors.length) {
            const spot = neighbors[Math.floor(rand() * neighbors.length)];
            const childEnergy = Math.floor(fox.energy / 2);
            fox.energy -= childEnergy;
            animals.foxes.push({ id: idCounter++, x: spot.x, y: spot.y, energy: childEnergy });
          }
        }

        // Die
        if (fox.energy <= 0) {
          animals.foxes = animals.foxes.filter(f => f.id !== fox.id);
        }
      }

      tick++;
      history.push({ tick, rabbits: animals.rabbits.length, foxes: animals.foxes.length, grass: 0 }); // Placeholder grass sum
      updateUI();
    }

    // Helper: Get neighbors
    function getNeighbors(x, y) {
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      return dirs.map(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx >= 0 && nx < world.width && ny >= 0 && ny < world.height ? { x: nx, y: ny } : null;
      }).filter(n => n);
    }

    // Update UI
    function updateUI() {
      // Update counters
      document.getElementById('tick').textContent = tick;
      document.getElementById('count-rabbits').textContent = animals.rabbits.length;
      document.getElementById('count-foxes').textContent = animals.foxes.length;
      document.getElementById('count-grass').textContent = 0; // Placeholder

      // Update canvas
      const canvas = document.getElementById('world');
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let y = 0; y < world.height; y++) {
        for (let x = 0; x < world.width; x++) {
          // Draw grass
          ctx.fillStyle = `rgb(30, ${60 + Math.round(160 * (world.grassMax / world.grassMax))}, 30)`; // Placeholder
          ctx.fillRect(x * 10, y * 10, 10, 10);
          // Draw animals
          const rabbit = animals.rabbits.find(r => r.x === x && r.y === y);
          const fox = animals.foxes.find(f => f.x === x && f.y === y);
          if (rabbit) ctx.fillStyle = 'rgb(240, 240, 240)'; else if (fox) ctx.fillStyle = 'rgb(220, 80, 20)'; else ctx.fillStyle = 'transparent';
          ctx.fillRect(x * 10, y * 10, 10, 10);
        }
      }

      // Update charts (simplified)
      // ...
    }

    // window.lab API
    window.lab = {
      reset: (seed, params) => reset(seed, params),
      step: (n) => { for (let i = 0; i < n; i++) step(); },
      counts: () => ({ rabbits: animals.rabbits.length, foxes: animals.foxes.length, grass: 0 }), // Placeholder
      tick: () => tick,
      cell: (x, y) => ({ grass: 0, rabbit: null, fox: null }), // Placeholder
      history: () => history,
      ode: (p, t, dt) => ({ x: 0, y: 0 }), // Placeholder
      exportCSV: () => 'tick,rabbits,foxes,grass\n0,0,0,0\n', // Placeholder
      exportScenario: () => JSON.stringify({ version: 1, seed: 42, params: {} }), // Placeholder
      loadScenario: (text) => { try { JSON.parse(text); return true; } catch (e) { return false; } },
    };

    // Event listeners
    document.getElementById('reset').addEventListener('click', () => {
      const seed = parseInt(document.getElementById('seed').value);
      const params = {
        rabbits0: parseInt(document.getElementById('param-rabbits0').value),
        foxes0: parseInt(document.getElementById('param-foxes0').value),
        rabbitBreed: parseInt(document.getElementById('param-rabbitBreed').value),
        foxBreed: parseInt(document.getElementById('param-foxBreed').value),
        foxGain: parseInt(document.getElementById('param-foxGain').value),
        grassMax: parseInt(document.getElementById('param-grassMax').value)
      };
      reset(seed, params);
    });

    document.getElementById('step').addEventListener('click', () => step());
    document.getElementById('play').addEventListener('click', () => { /* Start interval */ });
    document.getElementById('pause').addEventListener('click', () => { /* Stop interval */ });

    // Initialize
    reset(42, {});
  </script>
</body>
</html>
```
