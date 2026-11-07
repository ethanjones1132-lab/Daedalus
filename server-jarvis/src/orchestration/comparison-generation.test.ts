import { describe, expect, test } from "bun:test";
import { applyComparisonGeneration } from "./comparison-generation";
import type { JarvisConfig } from "../config";

describe("applyComparisonGeneration", () => {
  test("leaves the body unchanged when the optional policy is absent", () => {
    const body = { max_tokens: 4_096, temperature: 0.2, top_p: 0.95 };

    applyComparisonGeneration(body, {} as Pick<JarvisConfig, "comparison_generation">);

    expect(body).toEqual({ max_tokens: 4_096, temperature: 0.2, top_p: 0.95 });
  });

  test("overrides earlier generation presets with the exact comparison policy", () => {
    const body = { max_tokens: 8_192, temperature: 0.3, top_p: 0.95 };
    const config = {
      comparison_generation: { max_tokens: 16, temperature: 0, top_p: 1 },
    } as Pick<JarvisConfig, "comparison_generation">;

    applyComparisonGeneration(body, config);

    expect(body).toEqual({ max_tokens: 16, temperature: 0, top_p: 1 });
  });

  test("applies the policy to Ollama options when the request uses them", () => {
    const body = { options: { num_predict: 8_192, temperature: 0.3, top_p: 0.95 } };
    const config = {
      comparison_generation: { max_tokens: 16, temperature: 0, top_p: 1 },
    } as Pick<JarvisConfig, "comparison_generation">;

    applyComparisonGeneration(body, config);

    expect(body.options).toEqual({ num_predict: 16, temperature: 0, top_p: 1 });
  });

  test.each([
    { max_tokens: 0, temperature: 0, top_p: 1 },
    { max_tokens: 1.5, temperature: 0, top_p: 1 },
    { max_tokens: 32_769, temperature: 0, top_p: 1 },
    { max_tokens: 16, temperature: Number.NaN, top_p: 1 },
    { max_tokens: 16, temperature: 2.01, top_p: 1 },
    { max_tokens: 16, temperature: 0, top_p: 0 },
    { max_tokens: 16, temperature: 0, top_p: 1.01 },
    { max_tokens: 16, temperature: 0 },
  ])("fails closed for invalid comparison settings %p", (comparison_generation) => {
    const body = { max_tokens: 4_096, temperature: 0.2, top_p: 0.95 };
    const config = { comparison_generation } as unknown as Pick<JarvisConfig, "comparison_generation">;

    expect(() => applyComparisonGeneration(body, config)).toThrow("comparison_generation");
    expect(body).toEqual({ max_tokens: 4_096, temperature: 0.2, top_p: 0.95 });
  });

  test("fails closed when the optional setting is present as null", () => {
    const config = { comparison_generation: null } as unknown as Pick<JarvisConfig, "comparison_generation">;

    expect(() => applyComparisonGeneration({}, config)).toThrow("comparison_generation");
  });
});
