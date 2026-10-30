import { type DiscoveryRootVerdict, type LifecycleAgent } from '../../domain/agent-discovery-state';
import { effectiveLifecycleState, type AgentProjection } from '../../domain/agent-lifecycle-state';
import type { LifecycleOperation } from './types';

/*
 * The Agent lifecycle is discover -> validate -> project -> activate. These
 * pure functions turn what the Bun server and the native surface have
 * actually observed into four stations. A station is only "done" when the
 * observation proves it; pending is hollow, never silently green.
 */

export type StationKey = 'discover' | 'validate' | 'project' | 'activate';
export type StationState = 'done' | 'current' | 'failed' | 'pending';

export interface Station {
  key: StationKey;
  label: string;
  state: StationState;
  /** The last result, in one short sentence. */
  result: string;
}

const LABELS: Record<StationKey, string> = {
  discover: 'Discover',
  validate: 'Validate',
  project: 'Project',
  activate: 'Activate',
};

export const shortHash = (hash: string | undefined | null) => (hash ? hash.slice(0, 8) : 'unknown');

function station(key: StationKey, state: StationState, result: string): Station {
  return { key, label: LABELS[key], state, result };
}

function sourceName(path: string | undefined): string {
  if (!path) return 'Found in the Agents root.';
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `Found at …/${parts.slice(-2).join('/')}` : `Found at ${path}`;
}

export function directoryStations(
  agent: LifecycleAgent,
  projection: AgentProjection | undefined,
  operation?: LifecycleOperation,
): Station[] {
  const state = effectiveLifecycleState(agent, projection);
  const valid = agent.status === 'valid';

  const discover = station('discover', 'done', sourceName(agent.source_path));

  let validate: Station;
  if (valid) validate = station('validate', 'done', 'soul.md passed validation.');
  else if (agent.status === 'invalid') {
    validate = station('validate', 'failed', projection?.validation_errors || 'soul.md failed validation.');
  } else validate = station('validate', 'pending', `Reported as ${agent.status}.`);

  let project: Station;
  if (!valid) project = station('project', 'pending', 'Waits for a passing validation.');
  else if (!agent.source_hash) project = station('project', 'pending', 'Waits for source provenance.');
  else if (!projection) project = station('project', 'current', 'No Runtime projection yet.');
  else if (projection.source_hash !== agent.source_hash) {
    project = station('project', 'current', `Source changed since projection v${projection.projection_version}.`);
  } else project = station('project', 'done', `Projection v${projection.projection_version} · ${shortHash(projection.source_hash)}`);

  let activate: Station;
  if (state === 'active') activate = station('activate', 'done', 'Live for new work.');
  else if (state === 'stale') activate = station('activate', 'current', 'Active on the previous source.');
  else if (projection && !projection.active && valid) activate = station('activate', 'pending', 'Inactive.');
  else if (projection?.active) activate = station('activate', 'current', 'Active, but the source cannot be validated.');
  else activate = station('activate', 'pending', 'Not active.');

  if (operation) {
    const verb = operation.action === 'activate' ? 'Activation' : 'Deactivation';
    if (operation.phase === 'writing') activate = station('activate', 'current', `${verb} is being written.`);
    else if (operation.phase === 'reconciling') activate = station('activate', 'current', 'Written. Confirming the projection.');
    else if (operation.phase === 'write-failed') activate = station('activate', 'failed', `${verb} failed. Confirmed state kept.`);
    else activate = station('activate', 'failed', `${verb} saved; readback is unconfirmed.`);
  }

  return [discover, validate, project, activate];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What an empty-or-rootless scan means. A bare "no agents" is only honest when
 * the root was read; unconfigured, missing and unreadable are distinct states
 * with their own fixed copy, and the resolved path is never part of the copy.
 */
const EMPTY_ROOT_RESULTS: Record<DiscoveryRootVerdict, { discover: StationState; result: string }> = {
  ok: { discover: 'pending', result: 'No Agent directories found.' },
  unconfigured: { discover: 'pending', result: 'No Agents root is configured.' },
  missing: { discover: 'failed', result: 'The configured Agents root does not exist.' },
  unreadable: { discover: 'failed', result: 'The Agents root cannot be read.' },
};

/** One track for the whole Agents root: each station summarises every directory. */
export function aggregateStations(
  agents: LifecycleAgent[] | null,
  projections: AgentProjection[] | null,
  flags: { loading: boolean; error: boolean; rootVerdict?: DiscoveryRootVerdict | null },
): Station[] {
  if (agents === null) {
    return [
      flags.error
        ? station('discover', 'failed', 'The Agents root could not be scanned.')
        : station('discover', 'current', 'Scanning the Agents root…'),
      station('validate', 'pending', 'Waits for discovery.'),
      station('project', 'pending', 'Waits for discovery.'),
      station('activate', 'pending', 'Waits for discovery.'),
    ];
  }
  const total = agents.length;
  if (total === 0) {
    // A successful scan of nothing is only "no directories" when the root
    // itself was read; the server's verdict names every other cause.
    const empty = EMPTY_ROOT_RESULTS[flags.rootVerdict ?? 'ok'];
    return [
      station('discover', empty.discover, empty.result),
      station('validate', 'pending', 'Nothing to validate.'),
      station('project', 'pending', 'Nothing to project.'),
      station('activate', 'pending', 'Nothing to activate.'),
    ];
  }
  const bySlug = new Map((projections ?? []).map((p) => [p.slug, p]));
  const invalid = agents.filter((a) => a.status === 'invalid').length;
  const valid = agents.filter((a) => a.status === 'valid');
  const projected = valid.filter((a) => {
    const p = bySlug.get(a.slug);
    return p && a.source_hash && p.source_hash === a.source_hash;
  });
  const drifted = valid.filter((a) => {
    const p = bySlug.get(a.slug);
    return p && a.source_hash && p.source_hash !== a.source_hash;
  });
  const active = agents.filter((a) => effectiveLifecycleState(a, bySlug.get(a.slug)) === 'active').length;

  const discover = station('discover', 'done', `${plural(total, 'directory', 'directories')} found.`);
  const validate = invalid > 0
    ? station('validate', 'failed', `${invalid} of ${total} failed validation.`)
    : valid.length === total
      ? station('validate', 'done', `All ${total} passed.`)
      : station('validate', 'pending', `${valid.length} of ${total} validated.`);
  const project = projections === null
    ? station('project', 'pending', 'Projections not observed.')
    : drifted.length > 0
      ? station('project', 'current', `${plural(drifted.length, 'projection needs', 'projections need')} refreshing.`)
      : valid.length > 0 && projected.length === valid.length
        ? station('project', 'done', `${projected.length} of ${valid.length} valid projected.`)
        : station('project', 'current', `${projected.length} of ${valid.length} valid projected.`);
  const activate = projections === null
    ? station('activate', 'pending', 'Activation not observed.')
    : active > 0
      ? station('activate', active === total ? 'done' : 'current', `${active} of ${total} active.`)
      : station('activate', 'pending', 'None active.');
  return [discover, validate, project, activate];
}

export const stationsDone = (stations: Station[]) => stations.filter((s) => s.state === 'done').length;
