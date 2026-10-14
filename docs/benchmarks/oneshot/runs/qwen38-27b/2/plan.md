## Plan

**Data model.** A `world` object holds `width`, `height`, `grassMax`, a `grass` array of length `width*height`, and two arrays `rabbits`/`foxes` of `{id, energy, x, y}`. A shared `idCounter` starts at 1 and increments for every animal created. `history` is an array of `{tick, rabbits, foxes, grass}`. `params` holds the 13 parameters, merged over defaults on reset.

**Tick order.** Grass regrows first. Rabbits act in ascending-id order: move to a rabbit-free neighbour, eat grass, lose energy, breed if energy ≥ threshold, die if energy ≤ 0. Foxes act in ascending-id order: move toward a rabbit-bearing fox-free neighbour, else a fox-free neighbour, eat a rabbit if present, lose energy, breed, die. Then tick increments and a history point is recorded.

**Randomness.** `mulberry32(seed)` is the sole source. `pick(list)` draws exactly one number only if the list is non-empty.

**Components.** `window.lab` API (reset, step, counts, tick, cell, history, ode, exportCSV, exportScenario, loadScenario), canvas renderer, SVG chart, Lotka–Volterra panel, scenario tools, presets, keyboard shortcuts, announcer.