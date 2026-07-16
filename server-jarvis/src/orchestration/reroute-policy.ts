/** Maximum number of conductor queue rewrites allowed in one execution segment. */
export const DEFAULT_MAX_REROUTES_PER_SEGMENT = 3;

export function canApplyConductorReroute(
  applied: number,
  max = DEFAULT_MAX_REROUTES_PER_SEGMENT,
): boolean {
  return Number.isFinite(applied) && applied >= 0 && applied < Math.max(1, Math.floor(max));
}
