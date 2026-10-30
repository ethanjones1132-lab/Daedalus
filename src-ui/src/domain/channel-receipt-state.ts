export interface DeliveryReceipt {
  message_id: string;
  channel: string;
  status: 'queued' | 'delivered' | 'failed';
  retry_count: number;
  error_code?: string;
  correlation_id: string;
  finished_at: string;
}

export interface DiscordSendResponse {
  ok: boolean;
  receipt?: DeliveryReceipt;
  error?: string;
}

interface ReceiptState {
  phase: 'loading' | 'ready' | 'failed';
  receipts: DeliveryReceipt[] | null;
  /**
   * Why the telemetry read failed, as a fixed code the UI can translate.
   * A telemetry-read failure is never evidence that a message went undelivered
   * and never marks a channel disconnected: telemetry and delivery are
   * different facts.
   */
  reason: ReceiptFailureReason | null;
}
export type ReceiptFailureReason = 'bun_unreachable' | 'http_status' | 'malformed';

export const RECEIPT_FAILURE_COPY: Record<ReceiptFailureReason, string> = {
  bun_unreachable: 'The Bun server did not answer the telemetry request.',
  http_status: 'The Bun server refused the telemetry request.',
  malformed: 'The delivery telemetry payload was not readable.',
};

type ReceiptAction =
  | { type: 'pending' }
  | { type: 'failure'; reason?: ReceiptFailureReason }
  | { type: 'success'; receipts: DeliveryReceipt[] };

export const initialReceiptState: ReceiptState = { phase: 'loading', receipts: null, reason: null };

export function reduceReceiptState(state: ReceiptState, action: ReceiptAction): ReceiptState {
  switch (action.type) {
    case 'pending': return { ...state, phase: 'loading' };
    case 'failure': return { ...state, phase: 'failed', reason: action.reason ?? null };
    case 'success': return { phase: 'ready', receipts: action.receipts, reason: null };
  }
}

function parseDeliveryReceipt(value: unknown): DeliveryReceipt {
  if (!value || typeof value !== 'object'
    || typeof (value as Record<string, unknown>).message_id !== 'string'
    || typeof (value as Record<string, unknown>).channel !== 'string'
    || !['queued', 'delivered', 'failed'].includes(String((value as Record<string, unknown>).status))
    || !Number.isInteger((value as Record<string, unknown>).retry_count)
    || Number((value as Record<string, unknown>).retry_count) < 0
    || typeof (value as Record<string, unknown>).correlation_id !== 'string'
    || typeof (value as Record<string, unknown>).finished_at !== 'string'
    || ((value as Record<string, unknown>).error_code !== undefined
      && typeof (value as Record<string, unknown>).error_code !== 'string')) {
    throw new Error('Invalid delivery receipt');
  }
  return value as DeliveryReceipt;
}

export function parseDiscordSendResponse(body: unknown): DiscordSendResponse {
  if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).ok !== 'boolean') {
    throw new Error('Invalid delivery response');
  }
  const source = body as Record<string, unknown>;
  const result: DiscordSendResponse = { ok: source.ok as boolean };
  if (source.receipt !== undefined) result.receipt = parseDeliveryReceipt(source.receipt);
  if (source.error !== undefined) {
    if (typeof source.error !== 'string') throw new Error('Invalid delivery response');
    result.error = source.error;
  }
  if (result.ok && !result.receipt) throw new Error('Invalid delivery response');
  return result;
}

export function parseReceipts(body: unknown): DeliveryReceipt[] {
  if (!body || typeof body !== 'object' || !('receipts' in body) || !Array.isArray((body as { receipts?: unknown }).receipts)) {
    throw new Error('Invalid delivery telemetry');
  }
  return (body as { receipts: unknown[] }).receipts.map(parseDeliveryReceipt);
}
