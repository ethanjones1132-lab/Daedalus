import { describe, expect, test } from "bun:test";
import { redactShadowText, runShadowRoute } from "./shadow-router";

describe("offline shadow router", () => {
  test("never changes the primary response and sends redacted no-tool input", async () => {
    let received: any;
    const result = await runShadowRoute(
      { answer: "primary answer", model: "primary" },
      async (request) => {
        received = request;
        return { answer: "candidate answer", model: "candidate" };
      },
      { message: "Email me at user@example.com with sk-secret-token-123456" },
      { request_id: "shadow-1" },
    );
    expect(result.user_visible).toBe("primary answer");
    expect(result.comparison).toMatchObject({ request_id: "shadow-1", candidate_answer: "candidate answer", tools_executed: 0, redacted: true });
    expect(received.message).not.toContain("user@example.com");
    expect(received.message).not.toContain("sk-secret-token-123456");
    expect(received.tools).toEqual([]);
    expect(received.mode).toBe("shadow");
  });

  test("contains candidate failures and enforces a bounded timeout", async () => {
    const result = await runShadowRoute(
      { answer: "primary" },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { answer: "late" };
      },
      { message: "hello" },
      { timeout_ms: 1 },
    );
    expect(result.user_visible).toBe("primary");
    expect(result.comparison.candidate_error).toBe("shadow_timeout");
  });

  test("redacts common credential text", () => {
    expect(redactShadowText("Bearer abc123 and 555-867-5309")).toContain("REDACTED");
  });
});
