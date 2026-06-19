import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetOllamaHealthCacheForTests,
  checkOllamaHealth,
  checkOllamaModelSupportsTools,
  listOllamaModels,
} from "./ollama";
import type { OllamaConfig } from "./config";

const originalFetch = globalThis.fetch;

function makeConfig(base_url = "http://empty.local:11434", model = "qwen3.5-9b:latest"): OllamaConfig {
  return {
    base_url,
    model,
    auto_pull: false,
    health_check_interval_ms: 10_000,
    options: {
      num_ctx: 32768,
      num_gpu: 999,
      num_thread: 8,
    },
  };
}

function mockOllamaTags() {
  (globalThis as any).fetch = async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith("http://empty.local:11434/api/tags")) {
      return Response.json({ models: [] });
    }
    if (url.startsWith("http://localhost:11434/api/tags")) {
      return Response.json({
        models: [
          {
            name: "qwen3.5-9b:latest",
            size: 5_394_098_326,
            digest: "digest-qwen",
            modified_at: "2026-06-03T12:25:38.957251763-04:00",
            details: { parameter_size: "9.0B", quantization_level: "Q4_K_S" },
          },
        ],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetOllamaH