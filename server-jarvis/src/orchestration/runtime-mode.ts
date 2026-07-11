import type { JarvisConfig } from "../config";

export function isOrchestrationEnabled(
  cfg: Pick<JarvisConfig, "orchestrator">,
): boolean {
  return cfg.orchestrator?.enabled === true;
}
