import type { HarnessSensorBatch } from "../controller";
import type { HarnessModule } from "../module";

/** A failed sensor is the next retry target; N/A and passing results are not. */
function firstFailingSensor(batch: HarnessSensorBatch | undefined): string | undefined {
  return batch?.sensors.find((sensor) => sensor.status === "nonzero" || sensor.status === "failed")?.sensor_id;
}

/**
 * Retry one failing sensor at a time. A focused round only narrows which sensor
 * evidence the module reads; the engine still runs the full manifest and only
 * accepts a pass after a full, all-sensor round, so a retry can never turn a
 * partial observation into a green run.
 */
export const retry: HarnessModule = {
  id: "retry",
  version: "1.0.0",
  description: "Retry the first failing sensor one at a time until a full sensor pass is green.",
  good_for: ["a known sensor failure that needs focused iteration"],
  bad_for: ["first runs with no sensor evidence", "tasks whose failure has no sensor yet"],
  params_schema: { type: "object", properties: {}, additionalProperties: false },
  limits: { max_rounds: 5 },
  beforeRound: (state) => {
    const sensorId = firstFailingSensor(state.last_sensors);
    if (!sensorId) return { instructions: "" };
    return {
      instructions: [
        `Retry the "${sensorId}" sensor this round.`,
        "Change only what that failure needs, then finish with the evidence you observed.",
        "This focused round is not a full sensor pass, so it cannot pass the run by itself.",
      ].join(" "),
      sensor_ids: [sensorId],
      skip_checker: true,
    };
  },
  afterSensors: () => ({ kind: "continue" }),
};
