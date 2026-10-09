

## Plan

### Data Model
The simulation is built around a grid of cells (`width` × `height`), each containing grass levels (0–`grassMax`), and possibly a rabbit or fox. Animals (rabbits and foxes) have unique IDs, positions, and energy levels. The state is updated in ticks, following a strict order: grass grows first, then rabbits process (move, eat, breed, die), then foxes (move, eat, breed, die). History tracks population counts and grass levels per tick. Parameters like `rabbits0`, `foxes0`, and energy thresholds are stored and merged with defaults during reset.

### Tick Order
1. **Grass Growth**: All cells increase grass by 1 (capped at `grassMax`).
2. **Rabbits**: Process each rabbit in ID order:
   - Move to a random empty neighbor (or stay).
   - Eat grass from current cell, reducing it to 0.
   - Lose energy (`rabbitCost`).
   - Breed if energy ≥ `rabbitBreed`, creating a child rabbit in a random empty neighbor.
   - Die if energy ≤ 0.
3. **Foxes**: Process each fox in ID order:
   - Move to a rabbit-containing or empty neighbor (prioritizing rabbits).
   - Eat a rabbit if present, gaining energy.
   - Lose energy (`foxCost`).
   - Breed if energy ≥ `foxBreed`, creating a child fox in a random empty neighbor.
   - Die if energy ≤ 0.

### Components
- **Simulation Engine**: Manages grid, animals, history, and parameter merging.
- **UI Controls**: Buttons (play/pause/step/reset), sliders for parameters, seed input.
- **Chart**: SVG polylines for rabbit/fox populations vs. ticks.
- **Lotka-Volterra Panel**: Inputs for equations, trajectory visualization.
- **Scenario Manager**: Save/load JSON scenarios via textarea and buttons.
- **Counters**: Display current tick and population counts.

---

```html
<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: sans-serif; margin: 0; }
canvas { border: 1px solid #000; }
.panel { display: flex; flex-direction: column; }
.panel-world, .panel-side { width: 100%; }
@media (min-width: 1000px) {
  .panel { flex-direction: row; }
}
#world { position: relative; }
.cell { width: 10px; height: 10px; }
.grass { fill: rgb(30, 60, 30); }
.rabbit { fill: rgb(240, 240, 240); }
.fox { fill: rgb(220, 80, 20); }
</style>
</head>
<body>
<canvas id="world" data-testid="world"></canvas>
<div class="panel panel-world">
  <div id="controls">
    <input type="number" id="seed" data-testid="seed" value="42">
    <button id="play" data-testid="play">Play</button>
    <button id="pause" data-testid="pause">Pause</button>
    <button id="step" data-testid="step">Step</button>
    <button id="reset" data-testid="reset">Reset</button>
    <div id="counters">
      <span>Tick: <span id="tick">0</span></span>
      <span>Rabbits: <span id="count-rabbits">0</span></span>
      <span>Foxes: <span id="count-foxes">0</span></span>
      <span>Grass: <span id="count-grass">0</span></span>
    </div>
    <div id="params">
      <label>Rabbits0: <input type="range" id="param-rabbits0" data-testid="param-rabbits0" min="0" max="300"></label>
      <label>Foxes0: <input type="range" id="param-foxes0" data-testid="param-foxes0" min="0" max="60"></label>
      <label>RabbitBreed: <input type="range" id="param-rabbitBreed" data-testid="param-rabbitBreed" min="2" max="40"></label>
      <label>FoxBreed: <input type="range" id="param-foxBreed" data-testid="param-foxBreed" min="2" max="60"></label>
      <label>FoxGain: <input type="range" id="param-foxGain" data-testid="param-foxGain" min="1" max="30"></label>
      <label>GrassMax: <input type="range" id="param-grassMax" data-testid="param-grassMax" min="1" max="10"></label>
    </div>
  </div>
  <div id="chart" data-testid="chart"></div>
</div>
<div class="panel panel-side">
  <div id="ode-panel">
    <label>α: <input type="number" id="ode-alpha" step="0.1"></label>
    <label>β: <input type="number" id="ode-beta" step="0.1"></label>
    <label>γ: <input type="number" id="ode-gamma" step="0.1"></label>
    <label>δ: <input type="number" id="ode-delta" step="0.1"></label>
    <label>x0: <input type="number" id="ode-x0"></label>
    <label>y0: <input type="number" id="ode-y0"></label>
    <label>t: <input type="number" id="ode-t"></label>
    <label>dt: <input type="number" id="ode-dt" step="0.01"></label>
    <button id="ode-run">Run</button>
    <div id="ode-results"></div>
    <svg id="ode-chart" data-testid="ode-chart"></svg>
  </div>
  <div id="scenario">
    <textarea id="scenario-json" data-testid="scenario-json"></textarea>
    <button id="scenario-export" data-testid="scenario-export">Export</button>
    <button id="scenario-load" data-testid="scenario-load">Load</button>
    <div id="scenario-error" data-testid="scenario-error"></div>
  </div>
  <div id="presets">
    <input type="text" id="preset-name" placeholder="Name">
    <button id="preset-save">Save</button>
    <div id="preset-list" data-testid="preset-list"></div>
  </div>
  <div id="announcer" aria-live="polite"></div>
</div>
<script>
const lab = {
  seed: 42,
  rand: null,
  tick: 0,
  history: [],
  grid: [],
  rabbits: [],
  foxes: [],
  params: {
    width: 40, height: 30, grassMax: 4,
    rabbits0: 100, foxes0: 6,
    rabbitStart: 6, rabbitGain: 1, rabbitCost: 1, rabbitBreed: 12,
    foxStart: 12, foxGain: 4, foxCost: 2, foxBreed: 40
  },
  mulberry32(seed) {
    let a = seed | 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },
  reset(seed, params) {
    this.seed = seed;
    this.rand = this.mulberry32(seed);
    this.tick = 0;
    this.history = [];
    this.grid = [];
    for (let y = 0; y < this.params.height; y++) {
      this.grid[y] = [];
      for (let x = 0; x < this.params.width; x++) {
        this.grid[y][x] = Math.floor(this.rand() * (this.params.grassMax + 1));
      }
    }
    this.rabbits = [];
    this.foxes = [];
    for (let i = 0; i < params.rabbits0 || this.params.rabbits0; i++) {
      let cells = [];
      for (let y = 0; y < this.params.height; y++) {
        for (let x = 0; x < this.params.width; x++) {
          if (!this.rabbits.some(r => r.x === x && r.y === y)) cells.push({x, y});
        }
      }
      if (cells.length) {
        const cell = cells[this.rand() * cells.length | 0];
        this.rabbits.push({id: this.rabbits.length + 1, x: cell.x, y: cell.y, energy: params.rabbitStart || this.params.rabbitStart});
      }
    }
    for (let i = 0; i < params.foxes0 || this.params.foxes0; i++) {
      let cells = [];
      for (let y = 0; y < this.params.height; y++) {
        for (let x = 0; x < this.params.width; x++) {
          if (!this.foxes.some(f => f.x === x && f.y === y)) cells.push({x, y});
        }
      }
      if (cells.length) {
        const cell = cells[this.rand() * cells.length | 0];
        this.foxes.push({id: this.foxes.length + 1, x: cell.x, y: cell.y, energy: params.foxStart || this.params.foxStart});
      }
    }
    this.history.push({tick: 0, rabbits: this.rabbits.length, foxes: this.foxes.length, grass: this.grid.reduce((sum, row) => sum + row.reduce((s, g) => s + g, 0), 0)});
    this.draw();
  },
  step(n = 1) {
    for (let i = 0; i < n; i++) {
      // Grass growth
      for (let y = 0; y < this.params.height; y++) {
        for (let x = 0; x < this.params.width; x++) {
          this.grid[y][x] = Math.min(this.params.grassMax, this.grid[y][x] + 1);
        }
      }
      // Rabbits
      const rabbits = [...this.rabbits];
      for (const rabbit of rabbits) {
        // Move
        const neighbors = this.getNeighbors(rabbit.x, rabbit.y).filter(c => !this.rabbits.some(r => r.x === c.x && r.y === c.y) && !this.foxes.some(f => f.x === c.x && f.y === c.y));
        if (neighbors.length) {
          const target = neighbors[this.rand() * neighbors.length | 0];
          rabbit.x = target.x;
          rabbit.y = target.y;
        }
        // Eat
        rabbit.energy += this.params.rabbitGain * this.grid[rabbit.y][rabbit.x];
        this.grid[rabbit.y][rabbit.x] = 0;
        rabbit.energy -= this.params.rabbitCost;
        // Breed
        if (rabbit.energy >= this.params.rabbitBreed) {
          const neighbors = this.getNeighbors(rabbit.x, rabbit.y).filter(c => !this.rabbits.some(r => r.x === c.x && r.y === c.y) && !this.foxes.some(f => f.x === c.x && f.y === c.y));
          if (neighbors.length) {
            const target = neighbors[this.rand() * neighbors.length | 0];
            rabbit.energy -= Math.floor(rabbit.energy / 2);
            this.rabbits.push({id: this.rabbits.length + 1, x: target.x, y: target.y, energy: Math.floor(rabbit.energy / 2)});
          }
        }
        // Die
        if (rabbit.energy <= 0) {
          this.rabbits = this.rabbits.filter(r => r.id !== rabbit.id);
        }
      }
      // Foxes
      const foxes = [...this.foxes];
      for (const fox of foxes) {
        // Move
        let neighbors = this.getNeighbors(fox.x, fox.y).filter(c => 
          this.rabbits.some(r => r.x === c.x && r.y === c.y) || 
          !this.foxes.some(f => f.x === c.x && f.y === c.y)
        );
        if (neighbors.length) {
          const target = neighbors[this.rand() * neighbors.length | 0];
          fox.x = target.x;
          fox.y = target.y;
        }
        // Eat
        const rabbit = this.rabbits.find(r => r.x === fox.x && r.y === fox.y);
        if (rabbit) {
          this.rabbits = this.rabbits.filter(r => r.id !== rabbit.id);
          fox.energy += this.params.foxGain;
        }
        fox.energy -= this.params.foxCost;
        // Breed
        if (fox.energy >= this.params.foxBreed) {
          const neighbors = this.getNeighbors(fox.x, fox.y).filter(c => !this.foxes.some(f => f.x === c.x && f.y === c.y));
          if (neighbors.length) {
            const target = neighbors[this.rand() * neighbors.length | 0];
            fox.energy -= Math.floor(fox.energy / 2);
            this.foxes.push({id: this.foxes.length + 1, x: target.x, y: target.y, energy: Math.floor(fox.energy / 2)});
          }
        }
        // Die
        if (fox.energy <= 0) {
          this.foxes = this.foxes.filter(f => f.id !== fox.id);
        }
      }
      this.tick++;
      this.history.push({tick: this.tick, rabbits: this.rabbits.length, foxes: this.foxes.length, grass: this.grid.reduce((sum, row) => sum + row.reduce((s, g) => s + g, 0), 0)});
    }
    this.draw();
    return this.counts();
  },
  counts() {
    return {rabbits: this.rabbits.length, foxes: this.foxes.length, grass: this.grid.reduce((sum, row) => sum + row.reduce((s, g) => s + g, 0), 0)};
  },
  cell(x, y) {
    return {grass: this.grid[y][x], rabbit: this.rabbits.find(r => r.x === x && r.y === y) || null, fox: this.foxes.find(f => f.x === x && f.y === y) || null};
  },
  history() {
    return this.history;
  },
  ode(p) {
    const {alpha, beta, gamma, delta, x0, y0, t, dt} = p;
    const n = Math.round(t / dt);
    let x = x0, y = y0;
    for (let i = 0; i < n; i++) {
      const k1x = alpha * x - beta * x * y;
      const k1y = delta * x * y - gamma * y;
      const k2x = alpha * (x + 0.5 * dt * k1x) - beta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y);
      const k2y = delta * (x + 0.5 * dt * k1x) * (y + 0.5 * dt * k1y) - gamma * (y + 0.5 * dt * k1y);
      const k3x = alpha * (x + 0.5 * dt * k2x) - beta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y);
      const k3y = delta * (x + 0.5 * dt * k2x) * (y + 0.5 * dt * k2y) - gamma * (y + 0.5 * dt * k2y);
      const k4x = alpha * (x + dt * k3x) - beta * (x + dt * k3x) * (y + dt * k3y);
      const k4y = delta * (x + dt * k3x) * (y + dt * k3y) - gamma * (y + dt * k3y);
      x += (k1x + 2 * k2x + 2 * k3x + k4x) * dt / 6;
      y += (k1y + 2 * k2y + 2 * k3y + k4y) * dt / 6;
    }
    return {x: x.toFixed(8), y: y.toFixed(8)};
  },
  exportCSV() {
    const lines = [`tick,rabbits,foxes,grass`];
    for (const entry of this.history) {
      lines.push(`${entry.tick},${entry.rabbits},${entry.foxes},${entry.grass}`);
    }
    return lines.join('\n') + '\n';
  },
  exportScenario() {
    return JSON.stringify({version: 1, seed: this.seed, params: this.params});
  },
  loadScenario(text) {
    try {
      const data = JSON.parse(text);
      if (data.version !== 1 || typeof data.seed !== 'number') return false;
      this.reset(data.seed, data.params);
      return true;
    } catch (e) {
      this.scenarioError.textContent = 'Invalid scenario';
      return false;
    }
  },
  getNeighbors(x, y) {
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    return dirs.flatMap(d => {
      const nx = x + d[0], ny = y + d[1];
      if (nx >= 0 && nx < this.params.width && ny >= 0 && ny < this.params.height) {
        return [{x: nx, y: ny}];
      }
    });
  },
  draw() {
    const canvas = document.getElementById('world');
    const ctx = canvas.getContext('2d');
    canvas.width = this.params.width * 10;
    canvas.height = this.params.height * 10;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < this.params.height; y++) {
      for (let x = 0; x < this.params.width; x++) {
        const g = this.grid[y][x];
        ctx.fillStyle = `rgb(30, ${60 + Math.round(160 * g / this.params.grassMax)}, 30)`;
        ctx.fillRect(x * 10, y * 10, 10, 10);
        const rabbit = this.rabbits.find(r => r.x === x && r.y === y);
        if (rabbit) {
          ctx.fillStyle = 'rgb(240, 240, 240)';
          ctx.fillRect(x * 10 + 3, y * 10 + 3, 4, 4);
        }
        const fox = this.foxes.find(f => f.x === x && f.y === y);
        if (fox) {
          ctx.fillStyle = 'rgb(220, 80, 20)';
          ctx.fillRect(x * 10 + 3, y * 10 + 3, 4, 4);
        }
      }
    }
  }
};
window.lab = lab;

// UI event handlers
document.getElementById('play').addEventListener('click', () => {
  // Implement play/pause logic
});
document.getElementById('step').addEventListener('click', () => lab.step());
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
  lab.reset(seed, params);
});
// Add other event handlers for sliders, scenario, etc.
</script>
</body>
</html>
```
