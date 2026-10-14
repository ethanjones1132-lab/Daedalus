# Ecosystem Lab: judging rubric

- **Status:** committed before any build is generated (spec §4).
- **Blind judging:** builds carry random ids. The judge sees `plan.md`, `app.html` and the four screenshots: `load`, `step200`, `phone` and `ode`.
- **Scoring:** each item scores an integer from 0 to 5, with a one-line reason. These scores are reported **beside** the check score, never mixed into it.
- **Anchors:** 0, 3 and 5 are described for each item. Use 1–2 and 4 for builds that fall between them.

## Plan (from `plan.md`)

| Item | 0 | 3 | 5 |
|---|---|---|---|
| **P1. Rules stated correctly** | Missing, or contradicts the prompt's rules | The tick order and main rules are right; one or two details are wrong or omitted (breeding split, neighbour order, start-of-phase list) | Tick order, the random-stream discipline, ids, neighbour order and the breed/eat/die order are all stated correctly |
| **P2. Complete** | Covers under a third of the components | Covers the simulation and most UI parts; misses some (presets, announcer, layout, ODE panel) | Names every component: simulation, API, canvas, chart, ODE panel, scenario, CSV, presets, keyboard/a11y, layout |
| **P3. Followed by the code** | The code ignores the plan | The code mostly follows it, with some departures | Its data model and structure are visibly the plan's |

## Code (from `app.html`)

| Item | 0 | 3 | 5 |
|---|---|---|---|
| **C1. Structure** | One tangled block; simulation, rendering and DOM mixed throughout | Recognisable parts, but leaky: the simulation touches the DOM, or there is duplicated logic | Clear separation between simulation, API, rendering, chart, panels and storage; one source of truth for state |
| **C2. Readability** | Unreadable: cryptic names, no structure | Readable with effort; some long functions or magic numbers | Clear names, short functions, constants named, comments only where needed |
| **C3. Robustness** | Crashes on ordinary actions | Handles the main flows; some edge states unguarded (empty presets, bad JSON, zero animals) | Guards bad input and edge states; no global leaks or listeners that pile up |

## Product (from the screenshots)

| Item | 0 | 3 | 5 |
|---|---|---|---|
| **D1. Layout clarity** | Elements overlap or are scattered | Grouped, with some awkward spacing or alignment | Clean, logical grouping; the regions are obvious |
| **D2. Visual quality** | Broken or unstyled | Plain but tidy | Polished: consistent type, spacing and colour; the chart is readable |
| **D3. Usability** | Controls unlabeled or hidden | Usable; some labels or values unclear | Every control labelled with its value shown; state is easy to read |
| **D4. Phone view (390 px)** | Broken or cut off | Usable but cramped | Reflows well; everything readable and reachable |

**Totals:** Plan /15, Code /15, Product /20.
