import { describe, expect, test } from "bun:test";
import { deprecatedSessionsPostResponse } from "./session-authority";

describe("session-authority: deprecatedSessionsPostResponse", () => {
  test("returns HTTP 410 Gone (NOT 404 / 403 / 200)", async () => {
    const response = deprecatedSessionsPostResponse();
    expect(response.status).toBe(410);
  });

  test("Content-Type is application/json (so clients can parse the body without sniffing)", () => {
    const response = deprecatedSessionsPostResponse();
    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType.toLowerCase()).toContain("application/json");
  });

  test("body.error is the stable machine-readable code 'sessions_are_native'", async () => {
    const response = deprecatedSessionsPostResponse();
    const body = await response.json();
    expect(body.error).toBe("sessions_are_native");
  });

  test("body.code is the stable machine-readable code 'deprecated_session_api'", async () => {
    const response = deprecatedSessionsPostResponse();
    const body = await response.json();
    expect(body.code).toBe("deprecated_session_api");
  });

  test("body.message is a non-empty human-readable string mentioning the native path", async () => {
    const response = deprecatedSessionsPostResponse();
    const body = await response.json();
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
    // The message tells the operator / client WHICH native path to use —
    // pinning the substring so a future copy-edit that drops the hint is a deliberate change.
    expect(body.message.toLowerCase()).toContain("native");
  });

  test("every call returns a freshly-constructed Response (no shared state, no caching)", () => {
    // Regression guard: a future "memoize the response" refactor would break
    // the contract that callers in index.ts (line ~4919-4924) can call this
    // in a hot path repeatedly without worrying about mutation.
    const a = deprecatedSessionsPostResponse();
    const b = deprecatedSessionsPostResponse();
    expect(a).not.toBe(b);
    expect(a.status).toBe(b.status);
  });

  test("response shape is stable across repeated calls (verifies the helper is deterministic / side-effect-free)", async () => {
    const a = await deprecatedSessionsPostResponse().json();
    const b = await deprecatedSessionsPostResponse().json();
    expect(a).toEqual(b);
  });

  test("used by /sessions GET handler — the helper's existence allows index.ts to share one Response for both /sessions POST and /sessions DELETE without a per-route copy of the body shape", async () => {
    // This is the *contractual* call site: src-tauri/src/index.ts calls it
    // for /sessions (GET|POST) AND /sessions/delete (POST). Pinning the
    // shape here is sufficient because the helper is the single source of
    // truth for the response body — the call sites in index.ts only swap
    // the path/method routing, not the body.
    //
    // The test below re-asserts the full body shape so any future edit that
    // drops a field is caught.
    const response = deprecatedSessionsPostResponse();
    const body = await response.json();
    expect(body).toEqual({
      error: "sessions_are_native",
      code: "deprecated_session_api",
      message: expect.any(String),
    });
    expect(Object.keys(body).sort()).toEqual(["code", "error", "message"]);
  });

  test("the message does NOT include the deprecated endpoint path (so a future /sessions-v2 redirect refactor does not need to touch the message)", () => {
    // Pinned by design: the message points operators at the *correct* path
    // (native Tauri), not the *wrong* path they're trying to use. If this
    // assertion starts failing, the message was changed to reference
    // /sessions — a deliberate change.
    const response = deprecatedSessionsPostResponse();
    return response.json().then((body: { message: string }) => {
      expect(body.message).not.toContain("/sessions");
    });
  });
});
