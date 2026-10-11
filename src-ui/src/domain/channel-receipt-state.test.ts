import { describe, expect, it } from 'vitest';
import { initialReceiptState, parseDiscordSendResponse, parseReceipts, reduceReceiptState } from './channel-receipt-state';

const receipt = {
  message_id: 'm1', channel: 'discord', status: 'delivered' as const, retry_count: 0,
  correlation_id: 'c1', finished_at: '2026-09-16T00:00:00Z',
};

describe('receipt response state', () => {
  it('keeps unavailable distinct from successful empty telemetry', () => {
    expect(reduceReceiptState(initialReceiptState, { type: 'failure' })).toEqual({ phase: 'failed', receipts: null });
    expect(reduceReceiptState(initialReceiptState, { type: 'success', receipts: [] })).toEqual({ phase: 'ready', receipts: [] });
  });

  it('retains the last snapshot during refresh and failure, replacing it only on success', () => {
    const ready = reduceReceiptState(initialReceiptState, { type: 'success', receipts: [receipt] });
    const pending = reduceReceiptState(ready, { type: 'pending' });
    expect(pending).toEqual({ phase: 'loading', receipts: [receipt] });
    expect(reduceReceiptState(pending, { type: 'failure' })).toEqual({ phase: 'failed', receipts: [receipt] });
    expect(reduceReceiptState(pending, { type: 'success', receipts: [] })).toEqual({ phase: 'ready', receipts: [] });
  });

  it('accepts the endpoint envelope without inventing receipt data or channel mappings', () => {
    expect(parseReceipts({ receipts: [receipt] })).toEqual([receipt]);
    expect(parseReceipts({ receipts: [] })).toEqual([]);
  });

  it('accepts only a delivered receipt as an externally verified result', () => {
    expect(parseDiscordSendResponse({ ok: true, receipt })).toEqual({ ok: true, receipt });
    expect(parseDiscordSendResponse({ ok: false, error: 'discord_secret_unavailable' })).toEqual({ ok: false, error: 'discord_secret_unavailable' });
    expect(parseDiscordSendResponse({ ok: false, receipt: { ...receipt, status: 'failed' } })).toEqual({ ok: false, receipt: { ...receipt, status: 'failed' } });
  });

  it.each([null, {}, { ok: 'true' }, { ok: true }, { ok: true, receipt: { ...receipt, status: 'unknown' } },
    { ok: true, receipt: { ...receipt, retry_count: -1 } },
  ])('rejects malformed delivery responses instead of claiming verification: %j', (body) => {
    expect(() => parseDiscordSendResponse(body)).toThrow();
  });

  it.each([null, {}, { receipts: null }, { receipts: {} }, { receipts: [null] },
    { receipts: [{ ...receipt, status: 'unknown' }] }, { receipts: [{ ...receipt, retry_count: -1 }] },
    { receipts: [{ ...receipt, message_id: undefined }] },
  ])('rejects malformed telemetry instead of claiming an empty or delivered result: %j', (body) => {
    expect(() => parseReceipts(body)).toThrow();
  });
});
