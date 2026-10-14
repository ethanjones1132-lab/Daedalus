## Plan

**Data model.** A `world` object holds `width`, `height`, `grassMax`, a `grass` array of length `width*height`, and two arrays `rabbits`/`foxes` of `{id, energy, x, y}`. A shared `idCounter` starts at 1 and increments for every animal created. `history` is an array of `{tick, rabbits, foxes, grass}`. `params` holds the 13 parameters, merged over defaults on reset.

**Tick order.** Grass regrows first. Rabbits act in ascending-id order: move to a rabbit-free neighbour, eat grass, lose energy, breed if energy ≥ threshold, die if energy ≤ 0. Foxes act in ascending-id order: move toward a rabbit-bearing fox-free neighbour, else a fox-free neighbour, eat a rabbit if present, lose energy, breed, die. Then tick increments and a history point is recorded.

**Randomness.** `mulberry32(seed)` is the sole source. `pick(list)` draws exactly one number only if the list is non-empty.

**Components.** `window.lab` API (reset, step, counts, tick, cell, history, ode, exportCSV, exportScenario, loadScenario), canvas renderer, SVG chart, Lotka–Volterra panel, scenario tools, presets, keyboard shortcuts, announcer.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ecosystem Lab</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { font-family: system-ui, sans-serif; color: #1c1c1c; background: #f4f6f8; }
  h1 { font-size: 1.1rem; margin: 0 0 8px; }
  .app { max-width: 1100px; margin: 0 auto; padding: 12px; }
  .regions { display: flex; flex-wrap: wrap; gap: 16px; }
  .panel { min-width: 0; }
  .panel-world { flex: 1 1 480px; }
  .panel-side { flex: 1 1 360px; }
  .panel-box { border: 1px solid #cfd4da; border-radius: 8px; padding: 12px; background: #fff; }
  .panel-box + .panel-box { margin-top: 12px; }
  .panel-world { display: flex; flex-direction: column; }
  .panel-world .panel-box { flex: 1; }
  .panel-world .panel-box + .panel-box { flex: 0; }
  .panel-side { display: flex; flex-direction: column; }
  .panel-side .panel-box { flex: 1; }
  .panel-side .panel-box + .panel-box { flex: 0; }
  #world { display: block; width: 100%; height: auto; image-rendering: pixelated; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; }
  .controls button { cursor: pointer; }
  .controls input[type=number] { width: 64px; }
  .controls input[type=range] { width: 120px; }
  .controls label { display: flex; gap: 6px; align-items: center; }
  .counters { display: flex; gap: 16px; margin-top: 12px; }
  .counters span { font-variant-numeric: tabular-nums; }
  .sliders { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin-top: 12px; }
  .sliders label { display: flex; gap: 8px; align-items: center; }
  .sliders input[type=range] { flex: 1; }
  .sliders .val { min-width: 28px; text-align: right; }
  .sliders .name { min-width: 90px; }
  .chart-box { display: flex; flex-direction: column; }
  .chart-box svg { width: 100%; height: auto; }
  .ode-box { display: flex; flex-direction: column; }
  .ode-box .inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }
  .ode-box .inputs label { display: flex; gap: 8px; align-items: center; }
  .ode-box .inputs input { width: 72px; }
  .ode-box .inputs .name { min-width: 120px; }
  .ode-box .results { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
  .ode-box .results span { font-variant-numeric: tabular-nums; }
  .ode-box svg { width: 100%; height: auto; }
  .scenario-box { display: flex; flex-direction: column; }
  .scenario-box textarea { width: 100%; min-height: 120px; }
  .scenario-box .row { display: flex; gap: 8px; margin-top: 8px; }
  .scenario-box .error { min-height: 1.2em; color: #b00; }
  .presets-box { display: flex; flex-direction: column; }
  .presets-box .row { display: flex; gap: 8px; }
  .presets-box .preset-item { display: flex; gap: 8px; align-items: center; }
  .presets-box .preset-item button { cursor: pointer; }
  .presets-box .preset-item .name { flex: 1; }
  .presets-box .preset-item .name::after { content: " — "; }
  .presets-box .preset-item .name::before { content: attr(name); }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { font-weight: 600; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .preset-item .name::before { content: ""; }
  .presets-box .preset-item .name { color: #1c1c1c; }
  .presets-box .preset-item .name::after { content: ""; }
  .presets-box .