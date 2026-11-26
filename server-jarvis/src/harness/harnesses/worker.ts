import type { HarnessModule } from "../module";

export const worker: HarnessModule = {
  id: "worker",
  version: "1.0.0",
  description: "Do the work yourself, run the manifest sensors, and send a passing round to the checker.",
  good_for: ["implementation", "bug fixes", "single-agent work"],
  bad_for: ["planning without edits", "large plans with independent workstreams"],
  params_schema: { type: "object", properties: {}, additionalProperties: false },
  limits: { max_rounds: 5 },
  beforeRound: () => ({ instructions: "" }),
  afterSensors: () => ({ kind: "continue" }),
};
