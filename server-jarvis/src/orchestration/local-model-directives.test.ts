import { describe, expect, test } from "bun:test";
import {
  LOCAL_MODEL_DIRECTIVES,
  directiveForModel,
  normalizeModelId,
} from "./local-model-directives";

describe("normalizeModelId", () => {
  test("lowercases and strips trailing :latest", () => {
    expect(normalizeModelId("Ornith-1.0-9b:latest")).toBe("ornith-1.0-9b");
    expect(normalizeModelId("  QWEN3.5-9B-HERETIC  ")).toBe("qwen3.5-9b-heretic");
  });

  test("leaves non-latest tags intact after lowercasing", () => {
    expect(normalizeModelId("qwen3.5:4b")).toBe("qwen3.5:4b");
  });
});

describe("directiveForModel", () => {
  test("returns a directive for known models with or without :latest", () => {
    const a = directiveForModel("ornith-1.0-9b:latest");
    const b = directiveForModel("ornith-1.0-9b");
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a!.length).toBeGreaterThan(20);
    expect(a!.length).toBeLessThanOrEqual(600);
  });

  test("is case-insensitive", () => {
    expect(directiveForModel("Qwythos9b-Conductor:latest")).toBe(
      LOCAL_MODEL_DIRECTIVES["qwythos9b-conductor"],
    );
  });

  test("unknown model → undefined", () => {
    expect(directiveForModel("totally-unknown-model:latest")).toBeUndefined();
    expect(directiveForModel("qwen3.5:4b")).toBeUndefined();
  });

  test("Heretic carries the verify-before-claim line", () => {
    const d = directiveForModel("qwen3.5-9b-heretic:latest");
    expect(d).toBeDefined();
    expect(d!).toContain("read its real output");
    expect(d!).toContain("not report success from reasoning or confidence alone");
  });

  test("every seeded directive is non-empty and within soft budget", () => {
    for (const [id, text] of Object.entries(LOCAL_MODEL_DIRECTIVES)) {
      expect(id).toBe(id.toLowerCase());
      expect(text.trim().length).toBeGreaterThan(20);
      expect(text.length).toBeLessThanOrEqual(600);
    }
  });
});
