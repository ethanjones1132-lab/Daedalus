// ═══════════════════════════════════════════════════════════════
// ── TCP Bridge (port 19876) ──
// ═══════════════════════════════════════════════════════════════
// Lightweight TCP server for external agent connections.
// Receives JSON requests, forwards to Jarvis HTTP API, streams back responses.

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { BridgeReplayGuard, verifyBridgeEnvelope } from "./bridge-protocol";

const CONFIG_FILE = join(homedir(), ".openclaw", "jarvis", "config.json");
const JARVIS_API = "http://localhost:19877";

type BridgeSocket = {
  write?(data: string | ArrayBuffer | Uint8Array): void;
  on?(event: string, listener: () => void): void;
  off?(event: string, listener: () => void): void;
  remoteAddress?: string;
};

type BridgeData = string | ArrayBuffer | Uint8Array;

function safeErrorMessage(e: unknown): string {
  if (e == null) return "Unknown error (null or undefined)";
  if (typeof e === "string") return e;
  if (e instanceof Error) {
    return e.message || e.stack?.split("\n")[0] || e.toString() || "Error (no message)";
  }
  if (typeof e === "object") {
    const anyE = e as { message?: unknown; toString?: () => string };
    if (typeof anyE.message === "string" && anyE.message) return anyE.message;
    if (typeof anyE.toString === "function") {
      try { const s = anyE.toString(); if (s && s !== "[object Object]") return s; } catch {}
    }
    try { return JSON.stringify(e).slice(0, 300); } catch { return Object.prototype.toString.call(e); }
  }
  return String(e);
}

function loadConfig(): { bridge_port: number; bridge_secret?: string } {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { bridge_port: 19876 };
  }
}

function writeSocket(socket: BridgeSocket, value: string): void {
  try { socket.write?.(value); } catch {}
}

const { bridge_port, bridge_secret } = loadConfig();
const bridgeSecret = process.env.JARVIS_BRIDGE_SECRET || bridge_secret || "";
const replayGuard = new BridgeReplayGuard();
const activeUpstreams = new Map<string, AbortController>();

try {
  Bun.listen({
    hostname: "127.0.0.1",
    port: bridge_port,
    socket: {
      async data(socket: BridgeSocket, data: BridgeData) {
        const text = data.toString().trim();
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const req = JSON.parse(line);
            const auth = await verifyBridgeEnvelope(req, bridgeSecret);
            if (!auth.ok) {
              writeSocket(socket, JSON.stringify({ error: auth.code }) + "\n");
              continue;
            }
            if (!replayGuard.accept(auth.envelope.request_id)) {
              writeSocket(socket, JSON.stringify({ error: "bridge_replay_detected", request_id: auth.envelope.request_id }) + "\n");
              continue;
            }
            if (auth.envelope.payload.type === "cancel") {
              const controller = activeUpstreams.get(auth.envelope.payload.target_request_id);
              if (controller) {
                controller.abort();
                writeSocket(socket, JSON.stringify({ type: "cancelled", request_id: auth.envelope.payload.target_request_id }) + "\n");
              } else {
                writeSocket(socket, JSON.stringify({ error: "bridge_request_not_found", request_id: auth.envelope.payload.target_request_id }) + "\n");
              }
              continue;
            }
            const session = auth.envelope.payload.session_id || "default";

            const upstreamAbort = new AbortController();
            activeUpstreams.set(auth.envelope.request_id, upstreamAbort);
            const onSocketClose = () => { try { upstreamAbort.abort(); } catch {} };
            socket.on?.("close", onSocketClose);

            fetch(`${JARVIS_API}/chat/stream`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: auth.envelope.payload.message, session_id: session }),
              signal: upstreamAbort.signal,
            }).then(async (res) => {
              const reader = res.body?.getReader();
              if (!reader) {
                writeSocket(socket, JSON.stringify({ error: "No response body", session_id: session }) + "\n");
                return;
              }
              const decoder = new TextDecoder();
              let buf = "";
              while (true) {
                try {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buf += decoder.decode(value, { stream: true });
                  const parts = buf.split("\n");
                  buf = parts.pop() || "";
                  for (const part of parts) {
                    if (part.startsWith("data: ")) {
                      const payload = part.slice(6).trim();
                      if (payload && payload !== "[DONE]") {
                        try {
                          const evt = JSON.parse(payload);
                          if (evt.type === "stream_event" || evt.type === "result") {
                            writeSocket(socket, JSON.stringify(evt) + "\n");
                          }
                        } catch { /* skip malformed SSE frames */ }
                      }
                    }
                  }
                } catch (readErr) {
                  writeSocket(socket, JSON.stringify({ error: safeErrorMessage(readErr), session_id: session }) + "\n");
                  break;
                }
              }
            }).catch((e) => {
              writeSocket(socket, JSON.stringify({ error: safeErrorMessage(e), session_id: session }) + "\n");
            }).finally(() => {
              activeUpstreams.delete(auth.envelope.request_id);
              socket.off?.("close", onSocketClose);
            });

            writeSocket(socket, JSON.stringify({ response: "queued", session_id: session }) + "\n");
          } catch (e: unknown) {
            writeSocket(socket, JSON.stringify({ error: safeErrorMessage(e) }) + "\n");
          }
        }
      },
      open(socket: BridgeSocket) {
        console.log(`[Bridge] Agent connected from ${socket.remoteAddress ?? "unknown"}`);
      },
      close() {
        console.log("[Bridge] Agent disconnected");
      },
    },
  });
  console.log(`[Bridge] Listening on 127.0.0.1:${bridge_port}`);
} catch (e: any) {
  if (e && (e.code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(String(e?.message)))) {
    console.warn(`[Bridge] Port ${bridge_port} already in use — a bridge is already running; exiting cleanly.`);
    process.exit(0);
  }
  console.error("[Bridge] Failed to start:", e);
  process.exit(1);
}
