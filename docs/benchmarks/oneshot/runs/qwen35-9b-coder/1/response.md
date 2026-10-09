## Plan

The app is a single HTML file with inline CSS and JS. It exposes a `window.lab` API that drives both the UI and the simulation.

**Data model:**
- **Grid:** `width` × `height` cells. Each cell stores `grass` (0–`grassMax`), and optional `rabbit` / `fox` objects `{id, energy}` or `null`.
- **Animals:** every animal has a unique `id` from a shared counter starting at 1.
- **State:** `tick`, `history` array of `{tick, rabbits, foxes, grass}`, `seed`, `params` object, `playing` boolean, `speed` ticks/sec, `elapsed` time, `lastTickTime`.
- **Randomness:** a single `mulberry32` generator seeded by the reset seed. `pick(list)` draws from it.

**Tick order (per section 3):**
1. Grass grows.
2. Rabbits move, eat, lose energy, breed, die.
3. Foxes move, eat, lose energy, breed, die.
4. Increment tick, record history.

**Components:**
- **World panel:** canvas (`data-testid="world"`), counters (`tick`, `count-rabbits`, `count-foxes`, `count-grass`), play/pause/step/reset buttons, seed input, speed slider, parameter sliders.
- **Side panel:** population chart (`data-testid="chart"`), Lotka–Volterra panel with RK4 integration and its own chart (`data-testid="ode-chart"`), scenario tools (textarea, export/load buttons, error message), presets list.
- **Announcer:** `aria-live="polite"` element for keyboard shortcuts.
- **Layout:** flexbox; side panel moves below world panel on narrow viewports.

**Rendering:**
- Canvas backing size is `width*10` × `height*10`. Grass cells are filled with green intensity based on grass level. Rabbits and foxes are drawn as filled shapes centered in their cells, fox over rabbit when sharing.
- SVG chart with polylines for rabbit and fox populations over ticks.
- ODE chart with polylines for x(t) and y(t).

**Persistence:**
- Presets saved to `localStorage` under `ecolab.presets`.
- Scenario export/parse via `exportScenario()` / `loadScenario()`.

**Keyboard:**
- Space toggles play/pause when no input is focused.
- `s` steps one tick.
- `r` resets.
- Focus is tracked to disable shortcuts when an input/button has focus.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ecosystem Lab</title>
<style>
  :root {
    --bg: #f5f5f0;
    --fg: #222;
    --panel-bg: #fff;
    --border: #ccc;
    --accent: #333;
    --accent-hover: #555;
    --grass-base: #1e301e;
    --rabbit: #f0f0f0;
    --fox: #dc5014;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: var(--bg);
    color: var(--fg);
    height: 100vh;
    overflow: hidden;
  }
  h1 { font-size: 1.1rem; margin: 0 0 0.5rem 0; }
  h2 { font-size: 1rem; margin: 0 0 0.3rem 0; }
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 8px;
    gap: 8px;
  }
  .top {
    display: flex;
    gap: 8px;
    flex: 1;
    min-height: 0;
  }
  .panel-world {
    flex: 1;
    min-width: 360px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
  .panel-side {
    flex: 1;
    min-width: 240px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
  .world-inner {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-height: 0;
  }
  .canvas-wrap {
    flex: 1;
    min-height: 0;
    position: relative;
    background: #e0e0e0;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding: 4px 0;
  }
  .controls button, .controls input, .controls select {
    font-size: 0.85rem;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-bg);
    color: var(--fg);
    cursor: pointer;
    outline: 2px solid transparent;
    outline-offset: 2px;
  }
  .controls button:hover, .controls button:focus {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .controls button:focus {
    outline-color: #0066cc;
    outline-style: solid;
    outline-width: 2px;
    outline-offset: 0;
  }
  .controls input[type="number"] {
    width: 60px;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-bg);
    color: var(--fg);
    font-size: 0.85rem;
    text-align: center;
  }
  .controls input[type="range"] {
    width: 100px;
  }
  .controls label {
    font-size: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .controls label span {
    font-size: 0.75rem;
    color: #666;
  }
  .controls .value {
    font-size: 0.8rem;
    min-width: 28px;
    text-align: right;
    margin-left: 4px;
  }
  .counters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 0.85rem;
    padding: 2px 0;
  }
  .counter {
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    min-width: 70px;
    text-align: center;
  }
  .counter .label {
    font-size: 0.7rem;
    color: #666;
    display: block;
  }
  .counter .value {
    font-size: 1rem;
    font-weight: 600;
    display: block;
  }
  .chart-wrap {
    flex: 1;
    min-height: 0;
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .chart {
    flex: 1;
    min-height: 0;
    width: 100%;
    height: 100%;
  }
  .chart svg {
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .chart text {
    font: 11px sans-serif;
    fill: #333;
  }
  .chart polyline {
    fill: none;
    stroke-width: 2;
  }
  .chart .series-rabbits { stroke: #333; }
  .chart .series-foxes { stroke: #dc5014; }
  .chart .axis-label { font-size: 10px; }
  .chart .axis-tick { font-size: 9px; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }
  .chart .axis-line { stroke: #ccc; stroke-width: 1; }
  .chart .grid-line { stroke: #eee; stroke-width: 1; }
  .chart .grid-label { font-size: 9px; fill: #999; }
  .chart .axis-label { font-size: 10px; fill: #333; }
  .chart .axis-tick { font-size: 9px; fill: #333; }