## Plan

**Data model.** A `world` object holds `grid` (a `width × height` array of `{grass, rabbit, fox}`), `rabbits` and `foxes` (arrays of `{id, energy, x, y}`), `tick`, `history`, `seed`, `params`, and `rand`. Ids come from one shared counter.

**Tick order.** Grass regrows; rabbits act in ascending-id order (move, eat, cost, breed, die); foxes act in ascending-id order (move, eat, cost, breed, die); then the history point is recorded.

**Components.** Canvas world, play/pause/step/reset buttons, seed/speed/parameter sliders, counters, SVG population chart, Lotka–Volterra panel, CSV/scenario tools, presets, announcer, and keyboard shortcuts.