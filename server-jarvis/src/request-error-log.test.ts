// DD-080 (server half) regression suite: a failing health endpoint must leave
// evidence in the log.
//
// Reverting the entrypoint to its pre-DD-080 shape fails these cases:
// - the quiet /status, /health and /health/readiness paths were excluded from
//   the error log, so a 5xx on /health produced no line at all;
// - the catch returned the 500 without any line the caller could find;
// - nothing capped repeated failures, so a crash-looping probe could have grown
//   the log without bound.
//
// The wiring case at the end reads the entrypoint source because index.ts
// binds a real socket at import time and cannot be imported by a test.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  FAILURE_LOG_WINDOW_MS,
  createRequestErrorLogger,
  formatFailureLine,
  observeRequestFailure,
  requestFailureMessage,
} from "./request-error-log";

const QUIET_PATHS = ["/status", "/health", "/health/readiness"] as const;

function collect() {
  const lines: string[] = [];
  const logger = createRequestErrorLogger({ emit: (line) => lines.push(line) });
  return { lines, logger };
}

/** The exact response the entrypoint's catch block returns for a thrown error. */
function thrown500(message: string): Response {
  return Response.json({ error: message }, { status: 500 });
}

/** index.ts binds a real socket at import time, so wiring is pinned by source. */
function entrypointSource(): string {
  return readFileSync(join(import.meta.dir, "index.ts"), "utf8");
}

describe("a thrown error on a quiet health path", () => {
  test("/health 500 produces exactly one error line with method, path, status and message", async () => {
    const { lines, logger } = collect();
    const response = thrown500("ollama probe exploded");

    const returned = await observeRequestFailure({
      method: "GET",
      path: "/health",
      response,
      logger,
    });

    expect(returned).toBe(response);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("GET");
    expect(lines[0]).toContain("/health");
    expect(lines[0]).toContain("500");
    expect(lines[0]).toContain("ollama probe exploded");
    // Wiring, not just the observer: restoring the pre-DD-080 `if (!isNoisy)`
    // suppression in the entrypoint must fail this case, not only the
    // source tripwire below.
    expect(entrypointSource()).toContain("return observeRequestFailure({");
  });

  test("the observed response body and status are untouched", async () => {
    const { logger } = collect();
    const response = thrown500("boom");

    const returned = await observeRequestFailure({
      method: "GET",
      path: "/health",
      response,
      logger,
    });

    expect(returned.status).toBe(500);
    expect(await returned.json()).toEqual({ error: "boom" });
  });

  test("a non-JSON 5xx still logs, falling back to the status", async () => {
    const { lines, logger } = collect();

    await observeRequestFailure({
      method: "GET",
      path: "/health",
      response: new Response("upstream died", { status: 502 }),
      logger,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/health");
    expect(lines[0]).toContain("502");
    expect(lines[0]).toContain("HTTP 502");
    // The body was cloned for the peek, never consumed for the caller.
  });
});

describe("the quiet success path stays quiet", () => {
  test.each([...QUIET_PATHS])("%p 200 produces no line", async (path) => {
    const { lines, logger } = collect();
    const response = Response.json({ ok: true });

    const returned = await observeRequestFailure({
      method: "GET",
      path,
      response,
      logger,
    });

    expect(returned).toBe(response);
    expect(lines).toEqual([]);
  });

  test("a successful non-quiet request produces no line either", async () => {
    const { lines, logger } = collect();
    await observeRequestFailure({
      method: "GET",
      path: "/models",
      response: Response.json({ models: [] }),
      logger,
    });
    expect(lines).toEqual([]);
  });
});

describe("non-quiet failing paths", () => {
  test("a throwing route still logs its 500", async () => {
    const { lines, logger } = collect();

    await observeRequestFailure({
      method: "POST",
      path: "/chat",
      response: thrown500("session store unavailable"),
      logger,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("POST");
    expect(lines[0]).toContain("/chat");
    expect(lines[0]).toContain("500");
    expect(lines[0]).toContain("session store unavailable");
  });

  test("a returned 503 is logged like a thrown 500", async () => {
    const { lines, logger } = collect();

    await observeRequestFailure({
      method: "POST",
      path: "/agent/skills/promote",
      response: Response.json(
        { ok: false, error: "promotion_failed", detail: "disk full" },
        { status: 503 },
      ),
      logger,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("503");
    expect(lines[0]).toContain("promotion_failed: disk full");
  });
});

describe("rate limiting", () => {
  test("a crash loop logs once per window and reports the suppressed count", async () => {
    let now = 1_000;
    const lines: string[] = [];
    const logger = createRequestErrorLogger({
      emit: (line) => lines.push(line),
      now: () => now,
    });

    for (let i = 0; i < 5; i++) {
      await observeRequestFailure({
        method: "GET",
        path: "/health",
        response: thrown500("probe failed"),
        logger,
      });
      now += 1_000; // five failures in five seconds, all inside one window
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("suppressed=");
    expect(logger.suppressedCount("/health")).toBe(4);

    // Next window: exactly one more line, carrying the suppressed count.
    now += FAILURE_LOG_WINDOW_MS;
    await observeRequestFailure({
      method: "GET",
      path: "/health",
      response: thrown500("probe failed"),
      logger,
    });

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("suppressed=4");
    expect(logger.suppressedCount("/health")).toBe(0);
  });

  test("the window is per path, so one noisy endpoint cannot hide another", async () => {
    let now = 1_000;
    const lines: string[] = [];
    const logger = createRequestErrorLogger({
      emit: (line) => lines.push(line),
      now: () => now,
    });

    await observeRequestFailure({ method: "GET", path: "/health", response: thrown500("a"), logger });
    await observeRequestFailure({ method: "GET", path: "/status", response: thrown500("b"), logger });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("/health");
    expect(lines[1]).toContain("/status");
  });
});

describe("line format", () => {
  test("a multi-line error message stays on one log line", () => {
    const line = formatFailureLine(
      { method: "GET", path: "/health", status: 500, message: "line one\nline two", elapsedMs: 1.5 },
      0,
    );
    expect(line).toBe("[Jarvis API] GET /health -> 500 Error: line one ↵ line two (1.50ms)");
    expect(line).not.toContain("\n");
  });

  test("requestFailureMessage falls back for a body with no error field", async () => {
    expect(await requestFailureMessage(Response.json({ ok: false }, { status: 500 }))).toBe("HTTP 500");
  });
});

describe("entrypoint wiring", () => {
  const source = entrypointSource();

  test("baseFetch feeds every response to the failure observer", () => {
    expect(source).toMatch(/export async function baseFetch\(req: Request\): Promise<Response> \{[\s\S]*?return observeRequestFailure\(\{/);
  });

  test("the quiet-path log suppression is gone", () => {
    // The pre-DD-080 form: a 5xx on /health was silently skipped.
    expect(source).not.toContain("if (!isNoisy) console.error");
    expect(source).not.toContain("const isNoisy =");
  });

  test("the 500 body and status are unchanged", () => {
    expect(source).toContain(
      'return Response.json({ error: err.message || String(err) }, { status: 500 });',
    );
  });
});
