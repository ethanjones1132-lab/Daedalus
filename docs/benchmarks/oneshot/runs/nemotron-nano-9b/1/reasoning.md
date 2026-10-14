Okay, I need to build this Ecosystem Lab web app. Let me start by understanding the requirements. The app is a single-page web app with a grid where grass, rabbits, and foxes interact. It needs to simulate their populations, show charts, compare with Lotka-Volterra equations, and allow saving/sharing scenarios. 

First, the plan section. The data model should include the grid, animals (rabbits and foxes), grass levels, and their states. Each cell in the grid has grass, and possibly a rabbit or fox. The animals have energy levels that change based on eating, moving, and breeding. The simulation runs in ticks, with each tick updating the state of the world.

The tick order is important. According to the specs, the order is: Grass grows first, then rabbits process (move, eat, breed, die), then foxes (move, eat, breed, die). This order ensures that rabbits eat the grass before foxes eat rabbits. Also, when animals move, they check neighbors in a specific order (up, right, down, left) and pick a direction if possible.

Components needed: The main parts are the simulation engine, the UI for controls, the chart for population data, the Lotka-Volterra panel, and the scenario management. The simulation engine will handle the grid updates, animal behaviors, and history tracking. The UI needs input fields for parameters, buttons for controls, and displays for counters and charts.

For the data model, I'll need a grid structure, maybe a 2D array for grass levels, and objects for each animal with their positions, energy, and IDs. The history will store each tick's data for the chart. The parameters are all the settings that can be adjusted, which are merged with defaults when resetting.

The tick order is crucial. Grass grows first, then rabbits, then foxes. Each step in the tick must follow this sequence. For rabbits, they move, eat, breed, and die. Foxes do similar steps but with their own rules. The random number generator is specific, using the mulberry32 function, which must be used everywhere instead of Math.random.

Now, the components. The simulation engine is the core. Then the UI components: the canvas for the grid, the controls (buttons, sliders, inputs), the chart, the Lotka-Volterra panel, and the scenario management (save/load). Each of these needs to be connected to the simulation engine.

For the UI, the canvas will be a grid of cells. Each cell's color depends on grass level. Rabbits and foxes are drawn as shapes in their cells. The controls include sliders for parameters, input for seed, buttons for play/pause/step/reset. The chart is an SVG with polylines for rabbits and foxes populations. The Lotka-Volterra panel has inputs for the equations and displays the results. Scenario management involves saving and loading JSON data.

Now, the code. The HTML needs to be self-contained. I'll start with the structure: a canvas for the world, a div for controls, a section for the chart, and the Lotka-Volterra panel. The CSS will handle layout, especially for different screen sizes. The JavaScript will handle the simulation, the API methods, and the UI interactions.

The simulation engine will have a grid, animals (rabbits and foxes), and a history array. The reset function will initialize everything based on the seed and parameters. The step function will run the simulation for n ticks. The counts method returns the current numbers. The cell method returns the state of a specific cell. The history method returns the stored data. The ode function will handle the Lotka-Volterra equations using RK4. The exportCSV and exportScenario methods will generate the required data.

For the UI, event listeners will handle button clicks, slider changes, and input updates. The canvas will be redrawn after each tick or reset. The chart will update with the history data. The Lotka-Volterra panel will update when parameters change or when the ode is run.

Testing the code is important. The data-testid attributes must match the requirements. The mulberry32 function must be used for all random choices. The parameters are merged correctly during reset. The simulation must follow the exact tick order and rules.

Potential issues: Ensuring that the random number generator is correctly implemented. Making sure that the grid updates properly, especially when animals move. Handling the breeding and death conditions accurately. The chart and CSV export must match the history data. The scenario saving and loading must work with JSON, and the error handling for invalid inputs.

Another thing is the accessibility and keyboard shortcuts. The buttons need to be focusable, and the announcer element should update when play is paused. The layout must adjust for different screen sizes, ensuring no horizontal scrolling.

I need to make sure that all the parameters are correctly handled, especially when merging defaults. The seed is used to initialize the random generator. The history is recorded after each tick, including the grass sum.

For the code, I'll structure it as a single HTML file. The JavaScript will be in a script tag. The CSS will be inline. The canvas will have the correct backing size. The controls will have the right data-testid attributes. The chart and Lotka-Volterra panel will have their respective elements.

Finally, the code must be self-contained, no external libraries. All functionality is implemented with vanilla JavaScript, HTML, and CSS. The mulberry32 function is defined as specified. The API methods are exposed on window.lab, which the UI uses to interact with the simulation.
