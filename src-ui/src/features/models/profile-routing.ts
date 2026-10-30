// ═══════════════════════════════════════════════════════════════
// ── profile-routing — saved profile vs configured route identity
// ═══════════════════════════════════════════════════════════════
//
// `model_profiles.is_active` is set only by the Inference Activate action, and
// Activate also projects the profile onto `jarvis_get_config`
// (`set_active_profile_and_reconcile`). Two stores therefore exist, and they can
// drift: Settings can change the backend without touching the profile row. The
// hero must not infer the routing backend from the profile — it shows both, and
// names a disagreement instead of silently rewriting either store.

import type { JarvisConfig } from '../../domain/types';
import { backendLabels } from '../../lib/backend-identity';
import type { ModelProfile } from './types';

export interface RoutingIdentity {
  /** Whether `jarvis_get_config` answered in this view. */
  observed: boolean;
  backendLabel: string;
  modelLabel: string;
  /** The saved profile's projected route differs from the configured route. */
  disagrees: boolean;
}

/**
 * The backend `apply_profile_to_config` projects for a profile. A CLI profile
 * is projected by its engine, not its provider column, so the comparison uses
 * the same rule the writer does.
 */
export function projectedProfileBackend(profile: ModelProfile): string {
  return profile.engine === 'claude_cli' ? 'claude_cli' : profile.provider;
}

export function projectRoutingIdentity(
  config: JarvisConfig | null,
  profile: ModelProfile | null,
): RoutingIdentity {
  const { backendLabel, modelLabel } = backendLabels(config);
  if (!config) {
    return { observed: false, backendLabel, modelLabel, disagrees: false };
  }
  const backend = typeof config.active_backend === 'string' ? config.active_backend : null;
  const disagrees =
    profile !== null &&
    (projectedProfileBackend(profile) !== backend ||
      profile.model.trim() !== modelLabel.trim());
  return { observed: true, backendLabel, modelLabel, disagrees };
}
