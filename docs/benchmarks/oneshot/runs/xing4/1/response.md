```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Ecolab</title>
<style>
/* ===== GLOBAL RESET & RESET ===== */
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f4f6f8; color: #222; }
.app { display: flex; min-height: 100vh; }

/* ===== PANEL WORLD (LEFT) ===== */
#panel-world { width: 70%; flex: none; padding: 14px; background: #fff; border: 1px solid #d8dde6; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
#panel-side { width: 30%; flex: none; padding: 14px; background: #fff; border: 1px solid #d8dde6; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
#panel-side { margin-left: auto; }

/* ===== CANVAS / WORLD ===== */
#world { display: block; width: 100%; max-width: 640px; height: auto; image-rendering: pixelated; background: #e8f3e8; border-radius: 6px; }

/* ===== CONTROLS / BUTTONS ===== */
.controls { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
.btn { padding: 7px 14px; border-radius: 6px; border: 1px solid #b8c2d6; background: #eef2f7; cursor: pointer; font-size: 13px; line-height: 1.5; }
.btn:hover { background: #dde4f0; }
.btn:active { transform: translateY(1px); }
.btn.primary { background: #2b6cb0; color: #fff; border-color: #2b6cb0; }
.btn.primary:hover { background: #1e5a96; }
.btn.warn { background: #d97706; color: #fff; border-color: #d97706; }
.btn.warn:hover { background: #c2630a; }
.btn.danger { background: #dc2626; color: #fff; border-color: #dc2626; }
.btn.danger:hover { background: #b91c1c; }

/* ===== SLIDERS / INPUTS ===== */
.controls .group { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.controls .group label { font-size: 12px; color: #555; white-space: nowrap; }
input[type=range] { width: 140px; accent-color: #2b6cb0; }
.val { font-size: 12px; color: #333; min-width: 3em; text-align: right; }

/* ===== COUNTERS / TICKER ===== */
.tickers { display: flex; gap: 14px; margin-top: 8px; }
.ticker { background: #f7f9fb; border: 1px solid #dde3ea; border-radius: 6px; padding: 5px 10px; font-size: 12px; }
.ticker .num { font-weight: 700; color: #1f6feb; }

/* ===== SVG / CHART ===== */
svg { display: block; width: 100%; height: auto; max-width: 560px; }
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b8; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b8; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b8; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b8; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b8; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b8; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b8; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b8; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b8; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b8; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid #dde3ea; border-radius: 6px; padding: 8px; }
svg .grid { stroke: #e2e6ee; stroke-width: 1; }
svg .axis { stroke: #9aa4b7; stroke-width: 1; }
svg .line { fill: none; stroke-width: 2; }

/* ===== SVG / CHART CONTAINER ===== */
.chart-wrap { background: #fff; border: 1px solid