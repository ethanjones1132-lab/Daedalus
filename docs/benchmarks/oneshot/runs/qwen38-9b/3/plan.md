## Plan

**Data Model:**
The app maintains a single global state object containing:
- `grid`: A 2D array of objects `{grass: number, rabbit: object|null, fox: object|null}`.
- `rabbits`: An array of objects `{id, x, y, energy}`.
- `foxes`: An array of objects `{id, x, y, energy}`.
- `tick`: Current tick counter.
- `history`: Array of `{tick, rabbits, foxes, grass}`.
- `seed`: The current random seed.
- `params`: The current configuration parameters.
- `isPlaying`: Boolean flag for the game loop.
- `speed`: Ticks per second.
- `rng`: The `mulberry32` generator instance.
- `idCounter`: Integer counter for unique IDs.

**Tick Order:**
1. **Grass Growth:** Iterate all cells, increment grass level (capped at `grassMax`).
2. **Rabbits:** Iterate rabbits sorted by ID. For each: Move (pick random empty neighbor), Eat (gain energy, clear grass), Lose Energy, Breed (if energy high enough, pick random empty neighbor), Die (if energy <= 0).
3. **Foxes:** Iterate foxes sorted by ID. For each: Move (prefer neighbors with rabbits, then empty neighbors), Eat (if rabbit present, remove rabbit, gain energy), Lose Energy, Breed, Die.
4. **Update:** Increment tick, record history point.

**Components:**
- **World Panel:** Canvas for rendering the grid, counters, play/pause/step/reset controls, and parameter sliders.
- **Side Panel:** Population chart (SVG), Lotka-Volterra calculator (inputs, RK4 integration, SVG chart), Scenario tools (JSON export/load), and Presets list.
- **Layout:** Flexbox layout that switches from side-by-side to stacked based on viewport width.