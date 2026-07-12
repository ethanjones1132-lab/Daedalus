import { describe, expect, test } from "bun:test";
import { smallestPeriod, detectDegenerateTail } from "./stream-degeneration";

describe("stream-degeneration", () => {
  test("smallestPeriod finds the repeating unit", () => {
    expect(smallestPeriod("abcabcabc")).toBe(3);
    expect(smallestPeriod("aaaa")).toBe(1);
    expect(smallestPeriod("abcdef")).toBe(6);
  });

  test("flags a phrase repeated many times", () => {
    const text = "Here is the diagnosis. " + "The gateway is missing. ".repeat(12);
    expect(detectDegenerateTail(text)).toBe(true);
  });

  test("does not flag normal prose", () => {
    const text =
      "The repository is an Expo application with TypeScript configuration. " +
      "It lacks a WebSocket transport, an authentication handshake, and message routing. " +
      "Each of these gaps has a distinct remediation path described below.";
    expect(detectDegenerateTail(text)).toBe(false);
  });

  test("does not flag legitimately repetitive short structures (markdown table rows)", () => {
    const table = Array.from({ length: 8 }, (_, i) => `| row${i} | value${i} |`).join("\n");
    expect(detectDegenerateTail(table)).toBe(false);
  });

  test("does not fire below the minimum buffer length", () => {
    expect(detectDegenerateTail("ha ha ha ha")).toBe(false);
  });
});
