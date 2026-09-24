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
}
type ReceiptAction =
  | { type: 'pending' }
  | { type: 'failure' }
  | { type: 'success'; receipts: DeliveryReceipt[] };

export const initialReceiptState: ReceiptState = { phase: 'loading', receipts: null };

export function reduceReceiptState(state: ReceiptState, action: ReceiptAction): ReceiptState {
  switch (action.type) {
    case 'pending': return { ...state, phase: 'loading' };
    case 'failure': return { ...state, phase: 'failed' };
    case 'success': return { phase: 'ready', receipts: action.receipts };
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
