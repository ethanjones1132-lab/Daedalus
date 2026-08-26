import { describe, expect, test, beforeEach } from "bun:test";
import { defaultConfig } from "../../config";
import {
  __resetLocalTargetCacheForTests,
  callOllamaChat,
  readOllamaLoadedContextLength,
  resolveLocalTarget,
  type LocalOllamaTarget,
} from "./ollama-local-transport";

const BASE = "http://ollama.test:11434";

function makeTarget(overrides: Partial<LocalOllamaTarget> = {}): LocalOllamaTarget {
  return {
    baseUrl: BASE,
    model: "qwen3.5:4b",
    supportsNativeTools: true,
    installedModels: ["qwen3.5:4b", "qwen3:8b"],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  __resetLocalTargetCacheForTests();
});

describe("resolveLocalTarget", () => {
  test("probes /api/tags and /api/show, resolves model + native tools", async () => {
    const urls: string[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({
          models: [{ name: "qwen3.5:4b" }, { name: "qwen3:8b" }],
        });
      }
      if (url.endsWith("/api/show")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.model).toBe("qwen3.5:4b");
        return jsonResponse({ capabilities: ["tools", "completion"] });
      }
      throw new Error(`unexpected url ${url}`);
    };

    const cfg = defaultConfig();
    cfg.ollama.base_url = `${BASE}/v1`;
    const target = await resolveLocalTarget(cfg, "qwen3.5:4b", { fetch: fetchFn as typeof fetch });
    expect(target.baseUrl).toBe(BASE);
    expect(target.model).toBe("qwen3.5:4b");
    expect(target.supportsNativeTools).toBe(true);
    expect(target.installedModels).toContain("qwen3.5:4b");
    expect(urls.some((u) => u.endsWith("/api/tags"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/api/show"))).toBe(true);
  });

  test("caches target for the TTL window", async () => {
    let tagsHits = 0;
    const fetchFn = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        tagsHits += 1;
        return jsonResponse({ models: [{ name: "qwen3.5:4b" }] });
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({ capabilities: ["tools"] });
      }
      throw new Error(url);
    };
    const cfg = defaultConfig();
    cfg.ollama.base_url = `${BASE}/v1`;
    const now = () => 1_000;
    await resolveLocalTarget(cfg, "qwen3.5:4b", { fetch: fetchFn as typeof fetch, now });
    await resolveLocalTarget(cfg, "qwen3.5:4b", { fetch: fetchFn as typeof fetch, now });
    expect(tagsHits).toBe(1);
  });
});

describe("callOllamaChat", () => {
  test("body shape: think:false, keep_alive, num_ctx/num_predict; tools when native", async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({
        message: { role: "assistant", content: "ok", tool_calls: [] },
        done_reason: "stop",
        prompt_eval_count: 100,
        eval_count: 5,
      });
    };

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "edit_file",
          description: "edit",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const result = await callOllamaChat(
      makeTarget(),
      [{ role: "user", content: "hi" }],
      {
        temperature: 0.1,
        top_p: 0.9,
        num_ctx: 16384,
        num_predict: 512,
        tools,
        useNativeTools: true,
      },
      { fetch: fetchFn as typeof fetch },
    );

    expect(captured).not.toBeNull();
    expect(captured!.stream).toBe(false);
    expect(captured!.think).toBe(false);
    expect(captured!.keep_alive).toBe("30m");
    const options = captured!.options as Record<string, number>;
    expect(options.num_ctx).toBe(16384);
    expect(options.num_predict).toBe(512);
    expect(options.temperature).toBe(0.1);
    expect(options.top_p).toBe(0.9);
    expect(Array.isArray(captured!.tools)).toBe(true);
    expect(result.content).toBe("ok");
    expect(result.prompt_eval_count).toBe(100);
  });

  test("when seed is set, request options block contains that seed", async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({
        message: { role: "assistant", content: "ok", tool_calls: [] },
      });
    };

    await callOllamaChat(
      makeTarget(),
      [{ role: "user", content: "hi" }],
      { seed: 42, temperature: 0.2 },
      { fetch: fetchFn as typeof fetch },
    );

    expect(captured).not.toBeNull();
    const options = captured!.options as Record<string, number>;
    expect(options.seed).toBe(42);
  });

  test("tools absent when text-protocol (useNativeTools false)", async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ message: { role: "assistant", content: "text only" } });
    };

    await callOllamaChat(
      makeTarget({ supportsNativeTools: false }),
      [{ role: "user", content: "hi" }],
      {
        tools: [
          {
            type: "function",
            function: {
              name: "edit_file",
              description: "edit",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        useNativeTools: false,
      },
      { fetch: fetchFn as typeof fetch },
    );

    expect(captured!.tools).toBeUndefined();
  });

  test("/api/chat object-form arguments normalize to ToolCall shape", async () => {
    const fetchFn = async () =>
      jsonResponse({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "edit_file",
                arguments: { path: "main.py", content: "x = 1" },
              },
            },
          ],
        },
      });

    const result = await callOllamaChat(
      makeTarget(),
      [{ role: "user", content: "edit" }],
      { useNativeTools: true, tools: [] },
      { fetch: fetchFn as typeof fetch },
    );

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]!.name).toBe("edit_file");
    expect(result.tool_calls[0]!.arguments).toEqual({ path: "main.py", content: "x = 1" });
    expect(result.tool_calls[0]!.id).toMatch(/^call_/);
  });

  test("string-form arguments also normalize", async () => {
    const fetchFn = async () =>
      jsonResponse({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_abc",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "a.py" }),
              },
            },
          ],
        },
      });

    const result = await callOllamaChat(
      makeTarget(),
      [{ role: "user", content: "read" }],
      {},
      { fetch: fetchFn as typeof fetch },
    );

    expect(result.tool_calls[0]!.id).toBe("call_abc");
    expect(result.tool_calls[0]!.name).toBe("read_file");
    expect(result.tool_calls[0]!.arguments).toEqual({ path: "a.py" });
  });

  test("empty content with non-empty thinking stays empty (no leak)", async () => {
    const fetchFn = async () =>
      jsonResponse({
        message: {
          role: "assistant",
          content: "",
          thinking: "I am reasoning about the problem for a long time...",
        },
      });

    const result = await callOllamaChat(
      makeTarget(),
      [{ role: "user", content: "hi" }],
      {},
      { fetch: fetchFn as typeof fetch },
    );

    expect(result.content).toBe("");
    expect(result.thinking).toContain("reasoning");
  });

  test("stageAbort aborts the request", async () => {
    const ctrl = new AbortController();
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    };

    const pending = callOllamaChat(
      makeTarget(),
      [{ role: "user", content: "hi" }],
      { stageAbort: ctrl.signal, timeoutMs: 60_000 },
      { fetch: fetchFn as typeof fetch },
    );
    ctrl.abort();
    await expect(pending).rejects.toThrow();
  });

  test("timeout aborts the request", async () => {
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    };

    await expect(
      callOllamaChat(
        makeTarget(),
        [{ role: "user", content: "hi" }],
        { timeoutMs: 20 },
        { fetch: fetchFn as typeof fetch },
      ),
    ).rejects.toThrow();
  });
});

describe("readOllamaLoadedContextLength", () => {
  test("returns max context_length from /api/ps", async () => {
    const fetchFn = async () =>
      jsonResponse({
        models: [
          { model: "qwen3.5:4b", context_length: 4096 },
          { model: "qwen3:8b", context_length: 16384 },
        ],
      });
    const n = await readOllamaLoadedContextLength(BASE, { fetch: fetchFn as typeof fetch });
    expect(n).toBe(16384);
  });

  test("returns null when no models loaded", async () => {
    const fetchFn = async () => jsonResponse({ models: [] });
    const n = await readOllamaLoadedContextLength(BASE, { fetch: fetchFn as typeof fetch });
    expect(n).toBeNull();
  });
});
