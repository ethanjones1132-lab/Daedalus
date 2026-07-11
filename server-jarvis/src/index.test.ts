import { describe, expect, test } from "bun:test";
import { deprecatedSessionsPostResponse } from "./session-authority";

describe("session authority boundary", () => {
  test("legacy Bun /sessions POST cannot create a parallel session", async () => {
    const response = deprecatedSessionsPostResponse();
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: "sessions_are_native",
      code: "deprecated_session_api",
    });
  });
});

