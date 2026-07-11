import { describe, expect, test } from "bun:test";
import { extractJson, OrchestratorJsonError } from "./json";

describe("OrchestratorJsonError", () => {
  test("is an Error subclass named OrchestratorJsonError", () => {
    const err = new OrchestratorJsonError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OrchestratorJsonError);
    expect(err.name).toBe("OrchestratorJsonError");
    expect(err.message).toBe("boom");
  });

  test("error message includes the original text that failed to parse", () => {
    // Operators can grep the error stream for the model output that produced it.
    const raw = "thinking... {\"oops\": } ...done";
    const err = new OrchestratorJsonError(`Failed to parse JSON from orchestrator output: ${raw}`);
    expect(err.message).toContain("Failed to parse JSON from orchestrator output:");
    expect(err.message).toContain(raw);
  });
});

describe("extractJson — direct parse path", () => {
  test("parses a clean JSON object verbatim", () => {
    const out = extractJson<{ a: number }>('{"a":1}');
    expect(out).toEqual({ a: 1 });
  });

  test("trims surrounding whitespace before parsing", () => {
    const out = extractJson<{ ok: boolean }>('   \n  {"ok":true}  \n');
    expect(out).toEqual({ ok: true });
  });

  test("parses a JSON array (any JSON, not just objects)", () => {
    // The function is generic over T — the caller decides the shape.
    const out = extractJson<number[]>("[1,2,3]");
    expect(out).toEqual([1, 2, 3]);
  });
});

describe("extractJson — surrounding-text recovery path", () => {
  test("recovers JSON embedded in prose after a `{` open brace", () => {
    // Common case: model emits a thinking preamble, then the JSON object.
    const out = extractJson<{ pipeline: string[] }>(
      'thinking step by step...\n{"pipeline":["synthesizer"]}\nfinal answer ready',
    );
    expect(out).toEqual({ pipeline: ["synthesizer"] });
  });

  test("recovers JSON with leading code-fence prefix and trailing prose", () => {
    // Models often wrap JSON in ```json ... ``` markdown fences.
    const out = extractJson<{ slug: string }>(
      '```json\n{"slug":"foo"}\n```\nAnd that is the answer.',
    );
    expect(out).toEqual({ slug: "foo" });
  });

  test("brute-force substring still throws when the inner content is not valid JSON", () => {
    // The implementation uses the first `{` and last `}` as the recovery
    // window, then attempts JSON.parse on that substring. Pin that this
    // recovery attempt is actually made — a malformed substring inside valid
    // braces still surfaces as OrchestratorJsonError, not a silent success.
    expect(() => extractJson('prefix noise {not-valid-json} trailing noise')).toThrow(OrchestratorJsonError);
  });

  test("recovers when the substring between first `{` and last `}` is valid JSON", () => {
    const out = extractJson<{ a: number; b: number }>('junk {"a":1,"b":2} junk');
    expect(out).toEqual({ a: 1, b: 2 });
  });

  test("recovers when the leading `{` is preceded by a single `{` (nested object as fragment)", () => {
    const out = extractJson<{ x: number }>('text {"x":7} more text');
    expect(out).toEqual({ x: 7 });
  });
});

describe("extractJson — failure path", () => {
  test("throws OrchestratorJsonError on garbage with no `{`", () => {
    expect(() => extractJson("totally not json")).toThrow(OrchestratorJsonError);
  });

  test("throws OrchestratorJsonError on garbage with a `{` but unparseable content", () => {
    expect(() => extractJson('thinking {not valid json')).toThrow(OrchestratorJsonError);
  });

  test("error message includes the original text for operator debugging", () => {
    const raw = "model said something incoherent";
    try {
      extractJson(raw);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestratorJsonError);
      expect((err as Error).message).toContain(raw);
    }
  });

  test("throws on empty string", () => {
    expect(() => extractJson("")).toThrow(OrchestratorJsonError);
  });

  test("throws on whitespace-only string", () => {
    // Empty after trim — no `{` found — falls through to throw.
    expect(() => extractJson("   \n\t  ")).toThrow(OrchestratorJsonError);
  });

  test("throws on a lone `{` (no closing brace)", () => {
    // The recovery path requires `end > start`; a lone `{` has no `}` so
    // the indexOf/lastIndexOf pair is `start=0, end=-1` and the if-guard
    // (`end > start`) skips recovery. Throws.
    expect(() => extractJson("{" + "more text after")).toThrow(OrchestratorJsonError);
  });

  test("throws on a lone `}` (no opening brace)", () => {
    // start=-1 so the guard `start !== -1` skips recovery. Throws.
    expect(() => extractJson("some text }")).toThrow(OrchestratorJsonError);
  });
});

describe("extractJson — generic typing", () => {
  test("T is a caller-side contract; runtime is untyped JSON", () => {
    // Pin that the function does NOT validate T at runtime — it's a typed
    // cast, not a schema check. A future refactor that adds runtime validation
    // would change this contract; pin the current "trust the caller" behavior.
    const out = extractJson<{ definitely_not_validated: number }>('{"unrelated_field":42}');
    expect(out).toEqual({ unrelated_field: 42 });
  });
});
