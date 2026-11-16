import { test, expect, describe, beforeEach } from "bun:test";
import { createApprovalRegistry } from "./approval-registry";

function details(callId: string, overrides: Record<string, unknown> = {}) {
  return {
    call_id: callId,
    tool_name: "test_tool",
    arguments: { path: "/tmp" },
    policy_source: "tool_requires_approval",
    ...overrides,
  };
}

describe("approval-registry", () => {
  test("resolves to true when approved", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    const p = reg.request(details("call-1"));
    expect(reg.resolve("call-1", true)).toBe(true);
    expect(await p).toBe(true);
  });

  test("resolves to false when rejected", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    const p = reg.request(details("call-2"));
    reg.resolve("call-2", false);
    expect(await p).toBe(false);
  });

  test("auto-denies after timeout", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    const p = reg.request(details("call-3"), 20);
    expect(await p).toBe(false);
  });

  test("caller abort clears a pending approval without waiting for timeout", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    const controller = new AbortController();
    const pending = reg.request({ ...details("call-abort"), signal: controller.signal });

    controller.abort("client disconnected");

    expect(await pending).toBe(false);
    expect(reg.pending()).toBe(0);
    expect(reg.getRecord("call-abort")?.status).toBe("expired");
  });

  test("resolve clears the pending entry", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    const p = reg.request(details("call-4"));
    expect(reg.pending()).toBe(1);
    reg.resolve("call-4", true);
    await p;
    expect(reg.pending()).toBe(0);
  });

  test("resolve on unknown id returns false", () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    expect(reg.resolve("nope", true)).toBe(false);
  });

  test("second resolve is a no-op", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    const p = reg.request(details("call-5"));
    expect(reg.resolve("call-5", true)).toBe(true);
    expect(reg.resolve("call-5", false)).toBe(false);
    expect(await p).toBe(true);
  });

  // ── Durable audit record tests ─────────────────────────────────────────────

  test("request creates a durable approval record", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    reg.request(details("call-6", { tool_name: "shell_execute", arguments: { command: "echo ok" } }));
    const record = reg.getRecord("call-6");
    expect(record).toBeDefined();
    expect(record?.request_id).toBe("call-6");
    expect(record?.tool_name).toBe("shell_execute");
    expect(record?.arg_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(record?.policy_source).toBe("tool_requires_approval");
    expect(record?.status).toBe("pending");
    expect(record?.session_id).toBeNull();
  });

  test("durable record includes session and surface when provided", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    reg.request(details("call-7", { session_id: "sess-1", surface: "chat" }));
    const record = reg.getRecord("call-7");
    expect(record?.session_id).toBe("sess-1");
    expect(record?.surface).toBe("chat");
  });

  test("approve updates the durable record to approved", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    const p = reg.request(details("call-8"));
    reg.resolve("call-8", true);
    await p;
    const record = reg.getRecord("call-8");
    expect(record?.status).toBe("approved");
    expect(record?.resolution).toBe("approved");
    expect(record?.resolved_at).toBeTruthy();
  });

  test("reject updates the durable record to rejected", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    const p = reg.request(details("call-9"));
    reg.resolve("call-9", false);
    await p;
    const record = reg.getRecord("call-9");
    expect(record?.status).toBe("rejected");
    expect(record?.resolution).toBe("rejected");
  });

  test("timeout updates the durable record to expired", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    await reg.request(details("call-10"), 20);
    const record = reg.getRecord("call-10");
    expect(record?.status).toBe("expired");
    expect(record?.resolution).toBe("expired");
  });

  test("argument hash is stable for the same arguments", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    reg.request(details("call-11a", { arguments: { b: 2, a: 1 } }));
    reg.request(details("call-11b", { arguments: { a: 1, b: 2 } }));
    const a = reg.getRecord("call-11a")!;
    const b = reg.getRecord("call-11b")!;
    expect(a.arg_hash).toBe(b.arg_hash);
  });

  // ── Audit-key namespacing ─────────────────────────────────────────────────
  // Call ids are unique per turn, not globally. A later turn that reuses an id
  // must get its own durable row instead of colliding on the PRIMARY KEY.

  test("re-requesting a still-pending call id rejects instead of inserting a second row", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    const first = reg.request(details("call-dup"));
    await expect(reg.request(details("call-dup"))).rejects.toThrow(/already pending/i);
    expect(reg.pending()).toBe(1);
    reg.resolve("call-dup", true);
    expect(await first).toBe(true);
    expect(reg.pending()).toBe(0);
  });

  test("a call id reused after its first request settled gets its own durable row", async () => {
    const reg = createApprovalRegistry({ dbPath: ":memory:" });
    const first = reg.request(details("call-reuse"));
    reg.resolve("call-reuse", true);
    expect(await first).toBe(true);

    // Same id, later turn. This must not throw a PRIMARY KEY conflict.
    const second = reg.request(details("call-reuse"));
    expect(reg.pending()).toBe(1);
    reg.resolve("call-reuse", false);
    expect(await second).toBe(false);

    // The decision lands on the newest row; the earlier row keeps its own.
    const record = reg.getRecord("call-reuse")!;
    expect(record.request_id).toMatch(/^call-reuse/);
    expect(record.request_id).not.toBe("call-reuse");
    expect(record.status).toBe("rejected");
    expect(record.resolution).toBe("rejected");
  });
});
