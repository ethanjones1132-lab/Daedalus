export interface DeliveryReceipt {
  message_id: string;
  channel: string;
  status: 'queued' | 'delivered' | 'failed';
  retry_count: number;
  error_code?: string;
  correlation_id: string;
  finished_at: string;
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

// A malformed response is unavailable telemetry, never a successful empty list.
export function parseReceipts(body: unknown): DeliveryReceipt[] {
  if (!body || typeof body !== 'object' || !('receipts' in body) || !Array.isArray(body.receipts)) {
    throw new Error('Invalid delivery telemetry');
  }
  for (const receipt of body.receipts) {
    if (!receipt || typeof receipt !== 'object'
      || typeof receipt.message_id !== 'string' || typeof receipt.channel !== 'string'
      || !['queued', 'delivered', 'failed'].includes(receipt.status)
      || !Number.isInteger(receipt.retry_count) || receipt.retry_count < 0
      || typeof receipt.correlation_id !== 'string' || typeof receipt.finished_at !== 'string'
      || (receipt.error_code !== undefined && typeof receipt.error_code !== 'string')) {
      throw new Error('Invalid delivery telemetry');
    }
  }
  return body.receipts;
}
