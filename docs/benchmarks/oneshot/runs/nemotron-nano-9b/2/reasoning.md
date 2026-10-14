Okay, I need to create a single-page web app called Ecosystem Lab. Let me start by understanding the requirements. The app should simulate grass, rabbits, and foxes on a grid. It needs to display the simulation, chart populations, compare with Lotka-Volterra equations, and allow saving/sharing scenarios. 

First, the plan section. The data model should include the grid, animals (rabbits and foxes), their energy levels, and the parameters. The tick order is important: grass grows first, then rabbits act, then foxes. Each tick involves updating grass, processing rabbits, then foxes. 

Components needed: the canvas for the grid, controls for parameters and actions (play, pause, step, reset), charts for populations and ODE results, scenario management (save/load), and presets. Also, the UI elements like sliders, inputs, and buttons with specific data-testid attributes.

For the data model, each cell in the grid has grass level, and possibly a rabbit or fox. Animals have IDs, positions, and energy. The parameters are all the defaults plus any provided by the user. The random number generator is fixed using the mulberry32 function. 

The tick process: grass increases, rabbits move, eat, breed, die; then foxes do the same. The history is recorded each tick with counts. The API methods need to be exposed via window.lab, which the UI will use.

Now, the components. The main parts are the simulation canvas, control panel (parameters, buttons), charts (population and ODE), scenario tools, and presets. Each component must be properly structured with the required data-testid attributes for testing.

For the HTML code, I need to create a single file with inline CSS and JavaScript. No external libraries. The canvas should be sized correctly, and the UI elements arranged according to the layout rules. The JavaScript will handle the simulation logic, API methods, and DOM interactions.

I need to make sure all parameters are correctly handled, including merging user inputs with defaults. The random number generator must be used as specified. The simulation steps must follow the exact order: grass, rabbits, foxes. 

The charts need to update with each tick, showing rabbits and foxes over time. The ODE panel requires input fields for the parameters and displaying the results. The scenario saving and loading must handle JSON correctly, with error checking.

Accessibility is important: keyboard navigation, ARIA labels, announcer for screen readers. The layout must adapt to different screen sizes, ensuring no horizontal scrolling.

Potential challenges: ensuring the simulation runs correctly with the exact randomness and tick order. Also, handling the history and chart updates efficiently. The CSV export and scenario export need to generate the correct data. Testing with the provided API methods is crucial.

I need to structure the HTML with all elements, inline CSS for styling, and JavaScript that initializes the simulation, handles user interactions, and updates the UI. The window.lab API must be correctly implemented with all required methods.

Finally, the code must be a single HTML file, no external resources. All CSS is inline, and JavaScript is within a script tag. The data-testid attributes must match exactly as specified for the automated tests to pass.
