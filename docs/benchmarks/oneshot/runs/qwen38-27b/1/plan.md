## Plan

**Data model.** A `world` object holds `grid` (a `width × height` array of `{grass, rabbit, fox}`), `rabbits` and `foxes` (arrays of `{id, energy, x, y}`), `tick`, `history`, `seed`, `params`, and `rand`. `history` is an array of `{tick, rabbits, foxes, grass}`.

**Tick order.** Grass regrows first. Rabbits act in ascending-id order: move to a rabbit-free neighbour, eat the cell's grass, lose cost, breed if energy is high enough, die if energy ≤ 0. Foxes act the same way: move toward a rabbit-bearing neighbour (else any fox-free neighbour), eat a rabbit if present, lose cost, breed, die. Then the tick increments and a history point is recorded.

**Components.** `panel-world` (canvas, controls, counters), `panel-side` (chart, Lotka–Volterra, scenario, presets), plus the announcer.