Okay, I need to create a single-page web app called Ecosystem Lab. Let me start by understanding the requirements. The app should simulate grass, rabbits, and foxes on a grid. It needs to display the simulation, chart populations, compare with Lotka-Volterra equations, and allow saving/sharing scenarios. 

First, the plan section. The data model should include the grid, animals (rabbits and foxes), grass levels, and their interactions. The tick order is crucial: grass grows first, then rabbits move and eat, then foxes. Each tick updates the state. Components would be the canvas for the grid, chart for populations, controls for parameters, and the scenario management.

For the data model, each cell has grass, and possibly a rabbit or fox. Animals have energy, and their actions depend on energy levels. The simulation steps are grass growth, rabbit actions (move, eat, breed, die), then fox actions. The history tracks populations over time.

Components: The main parts are the simulation canvas, population chart, parameter sliders, controls (play, pause, step, reset), scenario input/output, and the Lotka-Volterra panel. Each needs to be connected via the lab API.

Next, the HTML code. It needs to be self-contained with inline CSS and JS. No external libraries. The structure should include the canvas, controls, charts, and scenario elements. The JavaScript will handle the simulation logic, API methods, and DOM interactions.

I need to make sure all parameters are handled correctly, using the default values and allowing overrides. The random number generator must be the mulberry32 function as specified. The simulation steps must follow the exact order: grass, rabbits, foxes. 

For the UI, the canvas should be sized correctly, with cells as 10x10 pixels. Grass is colored based on its level. Rabbits and foxes are drawn as shapes in their cells. The chart uses polylines for rabbits and foxes. The scenario section allows saving and loading JSON.

The lab API methods must be exposed on window.lab. Each method like reset, step, counts, etc., needs to be implemented. The CSV export and scenario export/load are also required.

Testing the code is important. The automated tests will check the data-testid attributes and the window.lab API. So all elements must have the correct data-testid as specified.

Potential issues: Ensuring the simulation runs correctly with the given rules, handling the random number generator properly, and making sure all UI elements are correctly linked. Also, the Lotka-Volterra panel needs to compute the equations accurately and display the results.

I need to structure the HTML with all elements, inline CSS for styling, and JavaScript that initializes the simulation, handles user interactions, and updates the DOM. The JavaScript should be concise but cover all required functionalities.

Finally, ensuring that the code is a single HTML file, no external resources. All styles and scripts are inline. The data-testid attributes must match exactly as per the requirements to pass the tests.
