import { describe, expect, test } from "bun:test";
import { detectDeferralStall, DEFERRAL_STALL_MAX_CHARS } from "./synthesizer-deferral";

describe("detectDeferralStall", () => {
  // Positive corpus — tonight's verbatim-style stalls + close variants.
  test("detects stand-by stall (tonight-style)", () => {
    expect(detectDeferralStall(
      "I'll have the full analysis ready in just a moment — stand by.",
    )).toBe(true);
  });

  test("detects give-me-a-moment stall", () => {
    expect(detectDeferralStall(
      "Give me a moment while I dig through the workspace.",
    )).toBe(true);
  });

  test("detects working-on-it stall", () => {
    expect(detectDeferralStall("Working on that now — hang tight.")).toBe(true);
  });

  test("detects I'll prepare stall", () => {
    expect(detectDeferralStall("I'll prepare a comprehensive summary shortly.")).toBe(true);
  });

  // Negative corpus — legit answers that happen to use "moment"/"shortly".
  test("rejects substantive answer with code fence", () => {
    expect(detectDeferralStall(
      "I'll have a look. Here's the fix:\n```ts\nconst x = 1;\n```",
    )).toBe(false);
  });

  test("rejects answer with file paths", () => {
    expect(detectDeferralStall(
      "In a moment of debugging I found src/index.ts is the culprit.",
    )).toBe(false);
  });

  test("rejects long answers even with promise language", () => {
    const long = "I'll have more later. " + "A".repeat(DEFERRAL_STALL_MAX_CHARS);
    expect(detectDeferralStall(long)).toBe(false);
  });

  test("rejects empty", () => {
    expect(detectDeferralStall("")).toBe(false);
  });

  test("rejects normal short answer without promise language", () => {
    expect(detectDeferralStall("The auth bug is fixed in login.ts line 42.")).toBe(false);
  });

  test("rejects bulleted short answer", () => {
    expect(detectDeferralStall(
      "Stand by? No — here are the findings:\n- bug in auth\n- fix applied",
    )).toBe(false);
  });
});
