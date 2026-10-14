## Plan

**Data Model:**
- **Grid:** 2D array of size `width` × `height`. Each cell holds `{grass: number, rabbit: object|null, fox: object|null}`.
- **Animals:** Objects `{id: number, x: number, y: number, energy: number}`.
- **State:** `tick`, `history` array, `idCounter`, `params` object, `isPlaying`, `speed`, `timerId`.
- **UI:** Canvas for the world, SVG for the chart, input elements for controls.

**Tick Order:**
1. **Grass Growth:** All cells `grass = min(grassMax, grass + 1)`.
2. **Rabbits:** Iterate sorted by ID. Move (to neighbor with no rabbit), Eat (gain energy, set grass to 0), Lose energy, Breed (if energy >= threshold, place child), Die (if energy <= 0).
3. **Foxes:** Iterate sorted by ID. Move (prioritize rabbit, then empty), Eat (if rabbit present, remove and gain energy), Lose energy, Breed, Die.
4. **Tick Increment:** `tick++`.
5. **History Record:** Push `{tick, rabbits, foxes, grassSum}`.

**Components:**
- **World Canvas:** Renders grid, grass, rabbits, foxes.
- **Chart SVG:** Polyline for rabbits and foxes over time.
- **Lotka-Volterra Panel:** Inputs for parameters, RK4 integration button, results display, trajectory chart.
- **Controls:** Play/Pause, Step, Reset, Speed slider, Parameter sliders.
- **Scenario Tools:** Export/Load JSON, CSV export.
- **Presets:** Save/Load/Delete from localStorage.
- **Announcer:** `aria-live` region for keyboard shortcuts.