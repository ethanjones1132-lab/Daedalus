import { describe, expect, it } from 'vitest';
import type { BackendSession } from '../../types';
import { activeSessions, greetingFor, newestFirst, parsePercent, systemVerdict, type OverviewData } from './overview-model';

const session = (id: string, updated_at: string, message_count = 1): BackendSession => ({
  id, agent_id: 'a', title: id, backend: 'ollama', model: 'm', context_tokens: 0, total_tokens: 0,
  created_at: updated_at, updated_at, archived: false, message_count,
});
const NOW = Date.parse('2026-10-11T12:00:00Z');
const base: OverviewData = {
  health: {
    ollama: { running: true, model: 'm', url: '' }, bun_server: { running: true, url: '' }, bridge: { running: false, port: 1 },
    disk: { total: '', used: '', available: '', use_percent: '10%' }, memory: { total_mb: 1, available_mb: 1, used_mb: 0, used_percent: 1 }, timestamp: '',
  },
  agents: [{ id: '1', name: 'a', model: 'm', enabled: true }, { id: '2', name: 'b', model: 'm', enabled: false }],
  sessions: [session('old', '2026-10-01T00:00:00Z'), session('new', '2026-10-11T11:30:00Z'), session('bad', 'nope')],
};

describe('overview model', () => {
  it('greets by local hour', () => {
    expect(greetingFor(new Date(2026, 9, 11, 8))).toBe('Good morning.');
    expect(greetingFor(new Date(2026, 9, 11, 13))).toBe('Good afternoon.');
    expect(greetingFor(new Date(2026, 9, 11, 21))).toBe('Good evening.');
    expect(greetingFor(new Date(2026, 9, 11, 2))).toBe('Good evening.');
  });

  it('counts only parseable Sessions updated inside the last hour', () => {
    expect(activeSessions(base.sessions, NOW).map((s) => s.id)).toEqual(['new']);
  });

  it('sorts newest first and sinks unparseable timestamps', () => {
    expect(newestFirst(base.sessions).map((s) => s.id)).toEqual(['new', 'old', 'bad']);
  });

  it('parses percentages tolerantly', () => {
    expect(parsePercent('25%')).toBe(25);
    expect(parsePercent(' 7.5 %')).toBe(7.5);
    expect(parsePercent('n/a')).toBeNull();
    expect(parsePercent(null)).toBeNull();
  });

  it('writes a verdict from the snapshot only', () => {
    expect(systemVerdict(base, NOW)).toBe(
      'Bun server and Ollama are running, Bridge is offline · 1 Agent enabled · 1 Session active in the last hour',
    );
    const healthy = { ...base, health: { ...base.health, bridge: { running: true, port: 1 } } };
    expect(systemVerdict(healthy, NOW)).toMatch(/^Bun server, Bridge and Ollama are running · /);
    const dark = { ...base, health: { ...base.health, ollama: { running: false, model: null, url: '' }, bun_server: { running: false, url: '' } } };
    expect(systemVerdict(dark, NOW)).toMatch(/^No services are running/);
  });
});
