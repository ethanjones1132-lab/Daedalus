import { createHash, timingSafeEqual } from "node:crypto";

export const SERVER_TOKEN_ENV = "JARVIS_SERVER_TOKEN";
export const PROXY_TOKEN_ENV = "JARVIS_CLAUDE_PROXY_TOKEN";

// Take both out of the inherited environment before any tools spawn children.
// Give them back only to the TCP bridge and to Claude CLI in proxy mode,
// respectively. The native-memory bearer is separately scoped and consumed.
export function takeLaunchToken(name: string): string {
  const token = process.env[name] ?? "";
  delete process.env[name];
  return token;
}

// tauri.conf.json's devUrl and the default Windows WebView2 app protocol.
const WEBVIEW_ORIGINS = new Set(["http://localhost:5173", "http://tauri.localhost"]);

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function protectLocalApi(token: string, route: (req: Request, path: string) => Promise<Response>) {
  const expected = token ? digest(token) : null;
  return async (req: Request, path: string): Promise<Response> => {
    const origin = req.headers.get("Origin");
    if (origin !== null && !WEBVIEW_ORIGINS.has(origin)) {
      return Response.json({ error: "origin_not_allowed" }, {
        status: 403,
        headers: { Vary: "Origin", "Cache-Control": "no-store" },
      });
    }
    const cors = new Headers({ Vary: "Origin" });
    if (origin !== null) cors.set("Access-Control-Allow-Origin", origin);
    // A browser preflight cannot carry credentials. This branch never routes.
    if (req.method === "OPTIONS" && origin !== null && req.headers.has("Access-Control-Request-Method")) {
      cors.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      cors.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return new Response(null, { status: 204, headers: cors });
    }
    if (req.method === "GET" && path === "/livez") {
      return Response.json({ ok: true }, { headers: cors });
    }
    // Internal Native surface requests still need their separate Authorization
    // bearer; the launch token is an additional gate, not its replacement.
    const presented = path.startsWith("/internal/")
      ? req.headers.get("X-Jarvis-Token")
      : /^Bearer (\S+)$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
    if (!expected || !presented || !timingSafeEqual(digest(presented), expected)) {
      cors.set("Cache-Control", "no-store");
      return Response.json({ error: "authentication_required" }, { status: 401, headers: cors });
    }
    const response = await route(req, path);
    response.headers.set("Cache-Control", path === "/chat/stream" ? "no-cache" : "no-store");
    if (origin !== null) response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.append("Vary", "Origin");
    return response;
  };
}
