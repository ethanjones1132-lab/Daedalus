import { describe, expect, test } from "bun:test";
import { BridgeReplayGuard, signBridgeEnvelope, verifyBridgeEnvelope, type BridgeEnvelope } from "./bridge-protocol";

const unsigned = {
  protocol_version: 1 as const,
  request_id: "req-1",
  device_id: "phone-1",
  issued_at: "2026-07-10T20:00:00.000Z",
  payload: { type: "chat" as const, session_id: "s1", message: "hello" },
};

describe("authenticated bridge protocol", () => {
  test("signs and verifies a v1 envelope", async () => {
    const signature = await signBridgeEnvelope(unsigned, "test-secret");
    const envelope: BridgeEnvelope = { ...unsigned, signature };
    expect(await verifyBridgeEnvelope(envelope, "test-secret", Date.parse(unsigned.issued_at))).toMatchObject({ ok: true });
  });

  test("rejects unsigned and tampered envelopes", async () => {
    expect(await verifyBridgeEnvelope(unsigned, "test-secret", Date.parse(unsigned.issued_at))).toMatchObject({ code: "bridge_auth_failed" });
    const signature = await signBridgeEnvelope(unsigned, "test-secret");
    expect(await verifyBridgeEnvelope({ ...unsigned, signature, payload: { ...unsigned.payload, message: "tampered" } }, "test-secret", Date.parse(unsigned.issued_at))).toMatchObject({ code: "bridge_auth_failed" });
  });

  test("rejects stale envelopes before invoking chat", async () => {
    const signature = await signBridgeEnvelope(unsigned, "test-secret");
    expect(await verifyBridgeEnvelope({ ...unsigned, signature }, "test-secret", Date.parse(unsigned.issued_at) + 6 * 60_000)).toMatchObject({ code: "bridge_expired" });
  });

  test("accepts a signed cancel envelope and rejects a replayed request id", async () => {
    const cancel = {
      protocol_version: 1 as const,
      request_id: "cancel-1",
      device_id: "phone-1",
      issued_at: "2026-07-10T20:00:00.000Z",
      payload: { type: "cancel" as const, target_request_id: "req-1" },
    };
    const signature = await signBridgeEnvelope(cancel, "test-secret");
    expect(await verifyBridgeEnvelope({ ...cancel, signature }, "test-secret", Date.parse(cancel.issued_at))).toMatchObject({ ok: true });
    const guard = new BridgeReplayGuard(1000);
    expect(guard.accept("cancel-1", 100)).toBe(true);
    expect(guard.accept("cancel-1", 200)).toBe(false);
    expect(guard.accept("cancel-1", 1200)).toBe(true);
  });
});
