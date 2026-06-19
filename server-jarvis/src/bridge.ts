// ═══════════════════════════════════════════════════════════════
// ── TCP Bridge (port 19876) ──
// ═══════════════════════════════════════════════════════════════
// Lightweight TCP server for external agent connections.
// Receives JSON requests, forwards to Jarvis HTTP API, streams back responses.

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_FILE = join(homedir(), ".openclaw", "jarvis", "config.json");
const JARVIS_API = "http://localhost:19877";

// Minimal defensive helpers (dupe of the ones in index.ts / openrouter.ts).
function safeErrorMessage(e: unknown): string {
  if (e == null) return "Unknown error (null or undefined)";
  if (typeof e === "string") return e;
  if (e instanceof Error) {
    return e.message || e.stack?.split("\n")[0] || e.toString() || "Error (no message)";
  }
  if (typeof e === "object") {
    const anyE = e as any;
    if (typeof anyE.message === "string" && anyE.message) return anyE.message;
    if (typeof anyE.toString === "function") {
      try { const s = anyE.toString(); if (s && s !== "[object Object]") return s; } catch {}
    }
    try { return JSON.stringify(e).slice(0, 300); } catch { return Object.prototype.toString.call(e); }
  }
  return String(e);
}

function loadConfig(): { bridge_port: number } {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { bridge_port: 19876 };
  }
}

const { bridge_port } = loadConfig();

try {
  Bun.listen({
  hostname: "127.0.0.1",
  port: bridge_port,
  socket: {
    data(socket, data) {
      const text = data.toString().trim();
      const lines = text.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line);
          const session = req.session || "default";

          // Forward to Jarvis HTTP API — now with abort awareness on socket close.
          const upstreamAbort = new AbortController();
          // If the TCP socket closes (client disconnect), abort the upstream fetch.
          // (socket "close" fires for both clean and abrupt closes.)
          const onSocketClose = () => { try { upstreamAbort.abort(); } catch {} };
          socket.on("close", onSocketClose);

          fetch(`${JARVIS_API}/chat/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: req.message, session_id: session }),
            signal: upstreamAbort.signal,
          }).then(async (res) => {
            const reader = res.body?.getReader();
            if (!reader) {
              try { socket.write(JSON.stringify({ error: "No response body", session_id: session }) + "\n"); } catch {}
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
                          try { socket.write(JSON.stringify(evt) + "\n"); } catch {}
                        }
                      } catch { /* skip */ }
                    }
                  }
                }
              } catch (readErr) {
                // Reader error (often from upstream abort or conn drop) — best effort.
                try { socket.write(JSON.stringify({ error: safeErrorMessage(readErr), session_id: session }) + "\n"); } catch {}
                break;
              }
            }
          }).catch((e) => {
            try { socket.write(JSON.stringify({ error: safeErrorMessage(e), session_id: session }) + "\n"); } catch {}
          }).finally(() => {
            // Clean up the close listener.
            try { socket.off("close", onSocketClose); } catch {}
          });

          try { socket.write(JSON.stringify({ response: "queued", session_id: session }) + "\n"); } catch {}
        } catch (e: unknown) {
          try { socket.write(JSON.stringify({ error: safeErrorMessage(e) }) + "\n"); } catch {}
        }
      }
    },
    open(socket) {
      console.log(`[Bridge] Agent connected from ${socket.remoteAddress}`);
    },
    close(socket) {
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