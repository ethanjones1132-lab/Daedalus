## Plan

### Data Model
- `width`, `height`, `grassMax`, `rabbits0`, `foxes0`, `rabbitStart`, `rabbitGain`, `rabbitCost`, `rabbitBreed`, `foxStart`, `foxGain`, `foxCost`, `foxBreed`
- `rand`: Mulberry32 generator
- `tick`: current tick number
- `idCounter`: shared animal ID counter
- `history`: array of `{tick, rabbits, foxes, grass}`
- `grid`: 2D array of cells with `grass`, `rabbit`, `fox`
- `rabbits`: list of `{id, x, y, energy}`
- `foxes`: list of `{id, x, y, energy}`

### Tick Order
1. Grass: increment all cells
2. Rabbits: move, eat, breed, die
3. Foxes: move, eat, breed, die
4. Record history

### Components
- `world` canvas: grid rendering
- `chart` SVG: population history
- `lotka-volterra` panel: ODE simulation
- `scenario` panel: export/load scenarios
- `presets` panel: save/load presets
- `controls`: play/pause/step/reset/speed/seed
- `counters`: tick/rabbits/foxes/grass counts
- `announcer`: accessibility text