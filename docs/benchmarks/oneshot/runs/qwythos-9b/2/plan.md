## Plan

**Data Model**
- **World**: A 2D grid of `width × height` cells. Each cell holds an integer `grass` (0–`grassMax`) and at most one `rabbit` and one `fox`. Animals have an `id`, `energy`, and position `(x, y)`.
- **State**: `tick` (integer), `history` (array of `{tick, rabbits, foxes, grass}`), `seed` (integer), `params` (object with all configurable values).
- **Randomness**: A single `mulberry32` generator seeded once at reset. All randomness (grass init, animal placement, movement picks) draws from this stream.
- **IDs**: A shared counter starting at 1, incremented for every animal created (including children).

**Tick Order**
1. **Grass**: `grass = min(grassMax, grass + 1)`.
2. **Rabbits** (sorted by ascending id):
   - Move to a neighbour with no rabbit (pick one).
   - Eat grass: `energy += rabbitGain * grass`, set cell grass to 0.
   - Lose energy: `energy -= rabbitCost`.
   - Breed if `energy >= rabbitBreed`: pick a neighbour with no rabbit, create child with `energy / 2`, parent loses that amount.
   - Die if `energy <= 0`.
3. **Foxes** (sorted by ascending id):
   - Move: prefer neighbours with a rabbit and no fox; if none, neighbours with no fox; else stay.
   - Eat: if cell has a rabbit, remove it, `energy += foxGain`.
   - Lose energy: `energy -= foxCost`.
   - Breed if `energy >= foxBreed`: pick a neighbour with no fox, create child, parent loses `energy / 2`.
   - Die if `energy <= 0`.
4. Increment `tick`, record history point.

**Components**
- **Canvas** (`data-testid="world"`): Renders grass (green gradient), rabbits (white), foxes (purple over rabbits).
- **Controls**: Play/Pause/Step/Reset buttons, Seed input, Speed slider, Parameter sliders (rabbits0, foxes0, rabbitBreed, foxBreed, foxGain, grassMax), Counters (tick, rabbits, foxes, grass).
- **Chart** (`data-testid="chart"`): SVG polyline for rabbits and foxes over ticks.
- **Lotka–Volterra Panel**: Inputs for α, β, γ, δ, x0, y0, t, dt; Run button; displays final x, y, equilibrium values, drift, and an SVG chart.
- **Scenario Tools**: Textarea (`scenario-json`), Export/Load buttons, Error message.
- **Presets**: Save/Load/Delete buttons, list of saved preset items.
- **Announcer**: `aria-live="polite"` element for status updates.
- **Keyboard shortcuts**: Space (toggle play/pause), `s` (step), `r` (reset) when no input/button is focused.

The app is fully self-contained: no external libraries, fonts, or images. All logic runs in vanilla JavaScript with inline CSS.