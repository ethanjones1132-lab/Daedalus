import { test, expect, describe } from "bun:test";
import { createApprovalRegistry } from "./approval-registry";

describe("approval-registry", () => {
  test("resolves to true when approved", async () => {
    const reg = createApprovalRegistry();
    const p = reg.request("call-1");
    expect(reg.resolve("call-1", true)).toBe(true);
    expect(await p).toBe(true);
  });

  test("resolves to false when rejected", async () => {
    const reg = createApprovalRegistry();
    const p = reg.request("call-2");
    reg.resolve("call-2", false);
    expect(await p).toBe(false);
  });

  test("auto-denies after timeout", async () => {
    const reg = createApprovalRegistry();
    const p = reg.request("call-3", 20);
    expect(await p).toBe(false);
  });

  test("resolve clears the pending entry", async () => {
    const reg = createApprovalRegistry();
    const p = reg.request("call-4");
    expect(reg.pending()).toBe(1);
    reg.resolve("call-4", true);
    await p;
    expect(reg.pending()).toBe(0);
  });

  test("resolve on unknown id returns false", () => {
    const reg = createApprovalRegistry();
    expect(reg.resolve("nope", true)).toBe(false);
  });

  test("second resolve is a no-op", async () => {
    const reg = createApprovalRegistry();
    const p = reg.request("call-5");
    expect(reg.resolve("call-5", true)).toBe(true);
    expect(reg.resolve("call-5", false)).toBe(false);
    expect(await p).toBe(true);
  });
});
