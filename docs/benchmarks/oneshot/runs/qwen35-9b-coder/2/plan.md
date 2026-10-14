## Plan

**Data Model:**
- **World:** A 2D grid of `width × height` cells. Each cell stores `grass` (0–`grassMax`), and optionally a `rabbit` and a `fox` (each an object with `id` and `energy`, or `null`).
- **Animals:** Every animal has a unique `id` from a shared counter starting at 1. Ids are assigned sequentially on creation (parent then child).
- **State:** `tick` (counter), `history` (array of `{tick, rabbits, foxes, grass}`), `playing` (boolean), `speed` (ticks/sec), `seed` (integer), and `params` (object of 13 parameters).
- **Randomness:** A single `mulberry32` generator seeded by `seed`. All randomness (grass placement, animal placement, movement choices) draws from this stream in a deterministic order.

**Tick Order:**
1. **Grass:** Every cell's grass grows by 1, capped at `grassMax`.
2. **Rabbits:** For each rabbit (sorted by ascending id, excluding those born this tick): move to a free neighbour (if any), eat grass, lose energy, breed if energy ≥ `rabbitBreed` (placing a child in a free neighbour), then die if energy ≤ 0.
3. **Foxes:** For each fox (sorted by ascending id, excluding those born this tick): move to a neighbour with a rabbit (if any), else to a free neighbour (if any), eat a rabbit if present, lose energy, breed if energy ≥ `foxBreed` (placing a child in a free neighbour), then die if energy ≤ 0.
4. Increment `tick`, record history point, redraw.

**Components:**
- **Canvas:** Renders the grid with grass levels, rabbits, and foxes.
- **Controls:** Play/pause/step/reset buttons, seed input, speed slider, parameter sliders.
- **Counters:** Live tick, rabbit, fox, and grass counts.
- **Chart:** SVG polyline chart comparing rabbit and fox populations over time.
- **CSV Export:** Downloads population history as CSV.
- **Scenario Tools:** JSON textarea, export/load buttons, error message.
- **Lotka–Volterra Panel:** RK4 integrator with adjustable parameters, trajectory chart, and drift calculation.
- **Presets:** localStorage-based save/load/delete for scenario snapshots.
- **Announcer:** `aria-live` element for keyboard shortcuts and play/pause state.

---