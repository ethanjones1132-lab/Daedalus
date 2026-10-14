export interface GatewayStatusRecord {
  running?: unknown;
  port?: unknown;
  active_connections?: unknown;
  uptime_seconds?: unknown;
  version?: unknown;
  timestamp?: unknown;
}

export const GATEWAY_SKEW_TOLERANCE_MS = 60_000;

export type GatewayClaim = 'running' | 'stopped' | 'unreadable';

export type GatewayTone = 'success' | 'error' | 'warn';

export type GatewayMetricKey = 'port' | 'connections' | 'uptime' | 'version';

export interface GatewayMetric {
  key: GatewayMetricKey;
  label: string;
  value: string;
  basis: string;
}

export interface GatewayStatusView {
  claim: GatewayClaim;
  claimLabel: string;
  basis: string;
  pill: string;
  tone: GatewayTone;
  ok: boolean;
  warn: boolean;
  observedAge: string;
  metrics: GatewayMetric[];
}

export function formatGatewayAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown';
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${Math.round(clamped / 1000)}s`;
  if (clamped < 3_600_000) return `${Math.round(clamped / 60_000)}m`;
  if (clamped < 86_400_000) return `${Math.round(clamped / 3_600_000)}h`;
  return `${Math.round(clamped / 86_400_000)}d`;
}

function recordOf(value: unknown): GatewayStatusRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as GatewayStatusRecord;
}

function portOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function versionOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function observedAtOf(value: unknown, now: number): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed - now > GATEWAY_SKEW_TOLERANCE_MS) return null;
  return parsed;
}

export function gatewayMetrics(record: GatewayStatusRecord | null): GatewayMetric[] {
  const port = portOf(record?.port);
  const version = versionOf(record?.version);
  return [
    {
      key: 'port',
      label: 'Port',
      value: port === null ? 'Not readable' : String(port),
      basis: port === null
        ? 'The status record carries no port Daedalus can read.'
        : 'The port Daedalus checks, not one it detects.',
    },
    {
      key: 'connections',
      label: 'Connections',
      value: 'Not measured',
      basis: 'This build reports a fixed zero here instead of counting connections to this port.',
    },
    {
      key: 'uptime',
      label: 'Uptime',
      value: 'Not measured',
      basis: 'This build reports a fixed zero here instead of tracking how long the port has been open.',
    },
    {
      key: 'version',
      label: 'Version',
      value: version === null ? 'Not readable' : version,
      basis: version === null
        ? 'The status record carries no version Daedalus can read.'
        : 'The version of this Daedalus build, not a reading from the port.',
    },
  ];
}

function projection(
  claim: GatewayClaim,
  claimLabel: string,
  basis: string,
  pill: string,
  tone: GatewayTone,
  ok: boolean,
  observedAge: string,
  record: GatewayStatusRecord | null,
): GatewayStatusView {
  return {
    claim,
    claimLabel,
    basis,
    pill,
    tone,
    ok,
    warn: !ok,
    observedAge,
    metrics: gatewayMetrics(record),
  };
}

export function projectGatewayStatus(raw: unknown, now: number = Date.now()): GatewayStatusView {
  const record = recordOf(raw);
  const at = observedAtOf(record?.timestamp, now);
  const observedAge = formatGatewayAge(at === null ? null : Math.max(0, now - at));
  const ageClause = at === null ? 'at a time Daedalus cannot read' : `${observedAge} ago`;
  const port = portOf(record?.port);
  const portText = port === null ? 'the port Daedalus checks' : `port ${port}`;

  if (record === null) {
    return projection(
      'unreadable',
      'Gateway state not readable',
      'The gateway read returned something that is not a gateway status, so no liveness claim is made.',
      'not readable',
      'warn',
      false,
      observedAge,
      null,
    );
  }
  if (typeof record.running !== 'boolean') {
    return projection(
      'unreadable',
      'Gateway state not readable',
      'The gateway read returned no running state Daedalus can read, so no liveness claim is made.',
      'not readable',
      'warn',
      false,
      observedAge,
      record,
    );
  }
  return record.running
    ? projection('running', 'Gateway is running', `A listener answered on ${portText}, ${ageClause}.`, 'online', 'success', true, observedAge, record)
    : projection('stopped', 'Gateway is stopped', `Nothing was listening on ${portText}, ${ageClause}.`, 'offline', 'error', false, observedAge, record);
}
