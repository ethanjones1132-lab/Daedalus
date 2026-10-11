import type { BackendSession } from '../../types';

/*
 * Overview snapshot model: the shapes returned by the three native reads that
 * make up one atomic request group, and the pure derivations the page renders.
 */

export interface HealthData {
  ollama: { running: boolean; model: string | null; url: string };
  bun_server: { running: boolean; url: string };
  bridge: { running: boolean; port: number };
  disk: { total: string; used: string; available: string; use_percent: string };
  memory: { total_mb: number; available_mb: number; used_mb: number; used_percent: number };
  timestamp: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  model: string;
  enabled: boolean;
}

export interface OverviewData {
  health: HealthData;
  agents: AgentSummary[];
  sessions: BackendSession[];
}

export const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

export function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'Good morning.';
  if (h >= 12 && h < 17) return 'Good afternoon.';
  return 'Good evening.';
}

export function activeSessions(sessions: BackendSession[], now = Date.now()): BackendSession[] {
  return sessions.filter((s) => {
    const updated = Date.parse(s.updated_at);
    return !Number.isNaN(updated) && now - updated < ACTIVE_WINDOW_MS;
  });
}

export function totalMessages(sessions: BackendSession[]): number {
  return sessions.reduce((sum, s) => sum + s.message_count, 0);
}

/** Newest first; unparseable timestamps sink to the bottom. */
export function newestFirst(sessions: BackendSession[]): BackendSession[] {
  const time = (s: BackendSession) => {
    const t = Date.parse(s.updated_at);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...sessions].sort((a, b) => time(b) - time(a));
}

/** Parse "25%" / "25.5 %" / 25 into a number, or null when unreadable. */
export function parsePercent(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** One sentence that says how the system is, derived only from the snapshot. */
export function systemVerdict(data: OverviewData, now = Date.now()): string {
  const { health, agents, sessions } = data;
  const services: Array<[string, boolean]> = [
    ['Bun server', health.bun_server.running],
    ['Bridge', health.bridge.running],
    ['Ollama', health.ollama.running],
  ];
  const up = services.filter(([, ok]) => ok).map(([n]) => n);
  const down = services.filter(([, ok]) => !ok).map(([n]) => n);
  const parts: string[] = [];
  if (down.length === 0) parts.push(`${joinNames(up)} are running`);
  else if (up.length === 0) parts.push('No services are running');
  else parts.push(`${joinNames(up)} ${up.length === 1 ? 'is' : 'are'} running, ${joinNames(down)} ${down.length === 1 ? 'is' : 'are'} offline`);
  parts.push(`${plural(agents.filter((a) => a.enabled).length, 'Agent')} enabled`);
  parts.push(`${plural(activeSessions(sessions, now).length, 'Session')} active in the last hour`);
  return parts.join(' · ');
}
