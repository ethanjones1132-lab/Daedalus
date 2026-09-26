import { describe, expect, it } from 'vitest';
import {
  formatGatewayAge,
  projectGatewayStatus,
  type GatewayMetric,
  type GatewayStatusRecord,
} from './gateway-metrics';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const PORT = 19876;

const ago = (ms: number) => new Date(NOW - ms).toISOString();

function record(fields: Record<string, unknown> = {}): GatewayStatusRecord {
  return {
    running: true,
    port: PORT,
    active_connections: 0,
    uptime_seconds: 0,
    version: '1.4.2',
    timestamp: ago(4000),
    ...fields,
  };
}

function metricOf(view: { metrics: GatewayMetric[] }, key: GatewayMetric['key']): GatewayMetric {
  const metric = view.metrics.find((m) => m.key === key);
  if (!metric) throw new Error(`missing metric ${key}`);
  return metric;
}

describe('gateway liveness claim', () => {
  it('claims running on a confirmed probe and keeps the running vocabulary', () => {
    const view = projectGatewayStatus(record(), NOW);
    expect(view.claim).toBe('running');
    expect(view.claimLabel).toBe('Gateway is running');
    expect(view.pill).toBe('online');
    expect(view.tone).toBe('success');
    expect(view.ok).toBe(true);
    expect(view.warn).toBe(false);
  });

  it('claims stopped when the probe found no listener and keeps the stopped vocabulary', () => {
    const view = projectGatewayStatus(record({ running: false }), NOW);
    expect(view.claim).toBe('stopped');
    expect(view.claimLabel).toBe('Gateway is stopped');
    expect(view.pill).toBe('offline');
    expect(view.tone).toBe('error');
    expect(view.ok).toBe(false);
    expect(view.warn).toBe(true);
  });

  it('names the port it checked and the age of that observation', () => {
    expect(projectGatewayStatus(record(), NOW).basis).toBe('A listener answered on port 19876, 4s ago.');
    expect(projectGatewayStatus(record({ running: false }), NOW).basis).toBe(
      'Nothing was listening on port 19876, 4s ago.',
    );
  });

  it('says when the observation time is unreadable instead of claiming a fresh reading', () => {
    const basis = projectGatewayStatus(record({ timestamp: 'not-a-time' }), NOW).basis;
    expect(basis).toBe('A listener answered on port 19876, at a time Daedalus cannot read.');
    expect(projectGatewayStatus(record({ timestamp: 'not-a-time' }), NOW).observedAge).toBe('unknown');
  });

  it('refuses a stamp ahead of the clock as evidence of an observation', () => {
    const ahead = new Date(NOW + 10 * 60_000).toISOString();
    const view = projectGatewayStatus(record({ timestamp: ahead }), NOW);
    expect(view.observedAge).toBe('unknown');
    expect(view.basis).toContain('at a time Daedalus cannot read');
  });

  it('treats a stamp inside the skew tolerance as observed now', () => {
    const ahead = new Date(NOW + 20_000).toISOString();
    expect(projectGatewayStatus(record({ timestamp: ahead }), NOW).observedAge).toBe('0s');
  });

  it('treats an absent timestamp as an unreadable observation time', () => {
    const view = projectGatewayStatus(record({ timestamp: undefined }), NOW);
    expect(view.observedAge).toBe('unknown');
    expect(view.basis).toContain('at a time Daedalus cannot read');
  });

  it.each([null, undefined, 'true', 1, 0, {}, []])('makes no liveness claim from a running state of %p', (running) => {
    const view = projectGatewayStatus(record({ running }), NOW);
    expect(view.claim).toBe('unreadable');
    expect(view.claimLabel).toBe('Gateway state not readable');
    expect(view.pill).toBe('not readable');
    expect(view.tone).toBe('warn');
    expect(view.ok).toBe(false);
    expect(view.warn).toBe(true);
    expect(view.basis).toBe('The gateway read returned no running state Daedalus can read, so no liveness claim is made.');
  });

  it('never echoes a drifted running value into the claim', () => {
    const view = projectGatewayStatus(record({ running: 'native panic at /secret/path' }), NOW);
    expect(view.basis).not.toContain('secret');
    expect(view.claimLabel).not.toContain('native');
  });

  it.each([null, undefined, 'gateway', 42, [], true])('reports a root that is not a status record: %p', (root) => {
    const view = projectGatewayStatus(root, NOW);
    expect(view.claim).toBe('unreadable');
    expect(view.basis).toBe('The gateway read returned something that is not a gateway status, so no liveness claim is made.');
  });

  it('keeps reading a port Daedalus can use when the running state is unreadable', () => {
    expect(metricOf(projectGatewayStatus(record({ running: 'maybe' }), NOW), 'port').value).toBe('19876');
  });
});

describe('gateway observation age', () => {
  it.each([
    [0, '0s'],
    [4000, '4s'],
    [45_000, '45s'],
    [90_000, '2m'],
    [3_600_000, '1h'],
    [7_200_000, '2h'],
    [86_400_000, '1d'],
    [172_800_000, '2d'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatGatewayAge(ms)).toBe(expected);
  });

  it('clamps a negative age to zero rather than printing a negative age', () => {
    expect(formatGatewayAge(-5000)).toBe('0s');
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])('reports an unreadable age for %p', (ms) => {
    expect(formatGatewayAge(ms as number | null)).toBe('unknown');
  });
});

describe('gateway metric tiles', () => {
  it('keeps the four tiles, their labels, and their order', () => {
    const view = projectGatewayStatus(record(), NOW);
    expect(view.metrics.map((m) => m.key)).toEqual(['port', 'connections', 'uptime', 'version']);
    expect(view.metrics.map((m) => m.label)).toEqual(['Port', 'Connections', 'Uptime', 'Version']);
  });

  it('prints the port as the port Daedalus checks, never as a detected one', () => {
    const metric = metricOf(projectGatewayStatus(record(), NOW), 'port');
    expect(metric.value).toBe('19876');
    expect(metric.basis).toBe('The port Daedalus checks, not one it detects.');
  });

  it.each([
    ['missing', undefined],
    ['a string', '19876'],
    ['a float', 19876.5],
    ['negative', -1],
    ['not a number', Number.NaN],
  ])('reads a %s port as unreadable rather than printing it', (_label, port) => {
    const metric = metricOf(projectGatewayStatus(record({ port }), NOW), 'port');
    expect(metric.value).toBe('Not readable');
    expect(metric.basis).toBe('The status record carries no port Daedalus can read.');
  });

  it('names the checked port generically when the record has no readable port', () => {
    expect(projectGatewayStatus(record({ port: 'x' }), NOW).basis).toBe(
      'A listener answered on the port Daedalus checks, 4s ago.',
    );
  });

  it.each([0, 3, 12, null, undefined, 'many', -2])(
    'refuses to print a connection count from a record value of %p',
    (active_connections) => {
      const metric = metricOf(projectGatewayStatus(record({ active_connections }), NOW), 'connections');
      expect(metric.value).toBe('Not measured');
      expect(metric.basis).toBe('This build reports a fixed zero here instead of counting connections to this port.');
    },
  );

  it.each([0, 3661, 86400, null, undefined, '1h', -5])(
    'refuses to print an uptime from a record value of %p',
    (uptime_seconds) => {
      const metric = metricOf(projectGatewayStatus(record({ uptime_seconds }), NOW), 'uptime');
      expect(metric.value).toBe('Not measured');
      expect(metric.basis).toBe('This build reports a fixed zero here instead of tracking how long the port has been open.');
    },
  );

  it('keeps reporting the build version the record carries', () => {
    const metric = metricOf(projectGatewayStatus(record(), NOW), 'version');
    expect(metric.value).toBe('1.4.2');
    expect(metric.basis).toBe('The version of this Daedalus build, not a reading from the port.');
  });

  it.each([null, undefined, '', '   ', 42, {}])('reads a version of %p as unreadable', (version) => {
    const metric = metricOf(projectGatewayStatus(record({ version }), NOW), 'version');
    expect(metric.value).toBe('Not readable');
    expect(metric.basis).toBe('The status record carries no version Daedalus can read.');
  });

  it('still names the connection and uptime limits when the whole record is unreadable', () => {
    const view = projectGatewayStatus('not a record', NOW);
    expect(metricOf(view, 'connections').value).toBe('Not measured');
    expect(metricOf(view, 'uptime').value).toBe('Not measured');
    expect(metricOf(view, 'port').value).toBe('Not readable');
    expect(metricOf(view, 'version').value).toBe('Not readable');
  });

  it('never prints a native value where no value was read', () => {
    const view = projectGatewayStatus(record({ running: 'drifted' }), NOW);
    for (const metric of view.metrics) {
      expect(metric.value).not.toBe('drifted');
      expect(metric.value).not.toBe('');
    }
  });
});
