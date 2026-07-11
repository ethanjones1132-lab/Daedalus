/** Versioned authenticated envelope for the optional remote device bridge. */

export interface BridgeEnvelope {
  protocol_version: 1;
  request_id: string;
  device_id: string;
  issued_at: string;
  payload:
    | { type: "chat"; session_id: string; message: string }
    | { type: "cancel"; target_request_id: string };
  signature: string;
}

export type BridgeAuthFailure = "bridge_auth_failed" | "bridge_replay_detected" | "bridge_expired";

export class BridgeReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 5 * 60_000) {}

  accept(requestId: string, nowMs = Date.now()): boolean {
    for (const [id, expires] of this.seen) if (expires <= nowMs) this.seen.delete(id);
    if (this.seen.has(requestId)) return false;
    this.seen.set(requestId, nowMs + this.ttlMs);
    return true;
  }
}

function signingBytes(envelope: Omit<BridgeEnvelope, "signature">): ArrayBuffer {
  return new TextEncoder().encode([
    envelope.protocol_version,
    envelope.request_id,
    envelope.device_id,
    envelope.issued_at,
    JSON.stringify(envelope.payload),
  ].join(".")).buffer as ArrayBuffer;
}

function decodeHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export async function signBridgeEnvelope(
  envelope: Omit<BridgeEnvelope, "signature">,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, signingBytes(envelope));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyBridgeEnvelope(
  value: unknown,
  secret: string,
  nowMs = Date.now(),
  maxSkewMs = 5 * 60_000,
): Promise<{ ok: true; envelope: BridgeEnvelope } | { ok: false; code: BridgeAuthFailure }> {
  if (!secret || !value || typeof value !== "object") return { ok: false, code: "bridge_auth_failed" };
  const envelope = value as Partial<BridgeEnvelope>;
  if (
    envelope.protocol_version !== 1 ||
    !envelope.request_id ||
    !envelope.device_id ||
    !envelope.issued_at ||
    !envelope.signature ||
    !envelope.payload ||
    !(["chat", "cancel"] as const).includes(envelope.payload.type) ||
    (envelope.payload.type === "chat" && (typeof envelope.payload.session_id !== "string" || typeof envelope.payload.message !== "string")) ||
    (envelope.payload.type === "cancel" && typeof envelope.payload.target_request_id !== "string")
  ) return { ok: false, code: "bridge_auth_failed" };
  const issuedAt = Date.parse(envelope.issued_at);
  if (!Number.isFinite(issuedAt) || Math.abs(nowMs - issuedAt) > maxSkewMs) return { ok: false, code: "bridge_expired" };
  const expected = await signBridgeEnvelope(envelope as Omit<BridgeEnvelope, "signature">, secret);
  const actual = decodeHex(envelope.signature);
  const expectedBytes = decodeHex(expected);
  if (!actual || !expectedBytes || actual.some((byte, i) => byte !== expectedBytes[i])) return { ok: false, code: "bridge_auth_failed" };
  return { ok: true, envelope: envelope as BridgeEnvelope };
}
