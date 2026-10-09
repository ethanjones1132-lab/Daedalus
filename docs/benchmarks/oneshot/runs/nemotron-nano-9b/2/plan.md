## Plan  
The **Ecosystem Lab** simulation will model a grid-based ecosystem with grass, rabbits, and foxes. The core data model includes a grid of cells (width × height), where each cell tracks grass levels and may contain at most one rabbit and one fox. Animals have unique IDs, positions, and energy levels. Parameters like `grassMax`, `rabbitBreed`, and `foxGain` define behavior, with user inputs overriding defaults.  

The simulation proceeds in ticks:  
1. **Grass grows** (increases by 1, capped at `grassMax`).  
2. **Rabbits act**: move, eat grass, breed, or die.  
3. **Foxes act**: move, eat rabbits, breed, or die.  
Each tick records population counts and grass totals for history and charting.  

Components include:  
- **Canvas**: Renders the grid with grass, rabbits, and foxes.  
- **Controls**: Sliders for parameters, buttons for reset/step/play/pause.  
- **Charts**: Line graphs for population trends and Lotka-Volterra ODE comparisons.  
- **Scenario tools**: Save/load scenarios as JSON.  
- **Presets**: Save/load predefined scenarios via `localStorage`.  

The `window.lab` API exposes methods for simulation control, data access, and exports. Randomness uses the `mulberry32` generator, ensuring reproducibility. The UI updates dynamically based on simulation state, with accessibility features like keyboard navigation and screen reader announcements.  

---