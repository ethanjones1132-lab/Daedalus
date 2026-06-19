import { describe, expect, test } from "bun:test";
import { encode } from "gpt-tokenizer";
import { countTokens } from "./tokens";

describe("countTokens", () => {
  test("empty / null / undefined count as 0", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens(null)).toBe(0);
    expect(countTokens(undefined)).toBe(0);
  });

  test("counts within 25% of the raw BPE token count (plus safety margin)", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const raw = encode(text).length;
    const got = countTokens(text);
    // We apply a small safety multiplier, so got should be >= raw but not wildly larger.
    expect(got).toBeGreaterThanOrEqual(raw);
    expect(got).toBeLessThanOrEqual(Math.ceil(raw * 1.25));
  });

  test("code-heavy text counts higher than the naive length/4 heuristic", () => {
    // Code tends to tokenize denser than prose; the old len/4 under-counted it.
    const code = `function add(a: number, b: number): number {\n  return a + b;\n}\n`.repeat(15);
    const naive = Math.ceil(code.length / 4);
    expect(countTokens(code)).toBeGreaterThan(naive);
  });

  test("never throws on odd input", () => {
    expect(() => countTokens("🦊".repeat(100))).not.toThrow();
    expect(countTokens("🦊")).toBeGreaterThan(0);
  });
});
