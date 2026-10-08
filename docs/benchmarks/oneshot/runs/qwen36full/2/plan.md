## Plan

**Data Model:**
The simulation state is encapsulated in a `State` object containing `grid` (2D array of grass levels), `rabbits` (Map of id -> {id, x, y, energy}), `foxes` (Map of id -> {id, x, y, energy}), `seed`, `tick`, `history`, and `rand` (the PRNG).
Parameters are stored in a `params` object.
The grid is `width` x `height`.

**Tick Order:**
1. **Grass:** Increment all cells by 1, capped at `grassMax`.
2. **Rabbits:** Sort alive rabbits by ID. For each:
   - Move to a random neighbor (no rabbit) or stay.
   - Eat grass (add energy, set grass to 0).
   - Lose cost energy.
   - Breed if energy >= threshold (split energy, place child in random neighbor).
   - Die if energy <= 0.
3. **Foxes:** Sort alive foxes by ID. For each:
   - Move to random neighbor (rabbit present, no fox) or (no fox) or stay.
   - Eat rabbit (remove rabbit, add energy).
   - Lose cost energy.
   - Breed if energy >= threshold.
   - Die if energy <= 0.
4. **Record:** Append `{tick, rabbits, foxes, grass}` to history.

**Components:**
- `State` class: Manages simulation logic, PRNG, and API methods (`reset`, `step`, `counts`, `ode`, etc.).
- `Renderer`: Handles Canvas drawing and SVG chart updates.
- `UI`: Manages DOM elements, event listeners, keyboard shortcuts, and layout.
- `Presets`: Handles `localStorage` persistence.