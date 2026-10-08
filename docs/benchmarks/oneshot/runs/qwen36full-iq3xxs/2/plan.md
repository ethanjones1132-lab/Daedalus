## Plan

**Data Model:**
The simulation state is encapsulated in a `World` object.
- `grid`: A 1D array of size `width * height`. Each element is an object `{ grass, rabbit: {id, energy}, fox: {id, energy} }`.
- `animals`: A Map of `id` to `{ type: 'rabbit'|'fox', energy }`.
- `params`: Merged configuration (defaults + user overrides).
- `history`: Array of `{ tick, rabbits, foxes, grass }`.
- `rng`: The Mulberry32 generator instance.

**Tick Order:**
1. **Grass Growth:** Increment all cells.
2. **Rabbits:** Iterate sorted by ID. Move (to empty neighbor), Eat (consume grass), Reproduce (if energy high, spawn child in neighbor), Die (if energy <= 0).
3. **Foxes:** Iterate sorted by ID. Move (prefer rabbit, else empty), Eat (consume rabbit), Reproduce, Die.
4. **Finalize:** Increment tick counter, record history.

**Components:**
- `World`: Manages simulation logic, RNG, and grid state.
- `Renderer`: Handles Canvas drawing (world) and SVG updates (charts).
- `UI`: Manages DOM elements, event listeners, and the `window.lab` API.
- `ODE`: Implements RK4 integration for Lotka-Volterra equations.