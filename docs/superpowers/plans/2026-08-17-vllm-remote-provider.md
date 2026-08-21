# Remote vLLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any orchestrator stage route to a large model running on a remote GPU under vLLM, over the existing OpenAI-compatible HTTP path.

**Architecture:** vLLM ships an OpenAI-compatible `/v1/chat/completions` server, so this is a fourth `HttpProviderId` alongside openrouter/opencode_zen/opencode_go — not a protocol bridge. The 2026-04 `remote_glm_bridge` Python service existed because that codebase spoke Anthropic protocol; home-base already speaks OpenAI to three providers, so no translation layer is needed. Unlike the OpenCode providers, vLLM supports native tool calling, so the request builder must stop stripping `tools` for every non-OpenRouter provider.

**Tech Stack:** Bun, TypeScript, `bun:test`. No new dependencies.

**Out of scope:** provisioning the GPU box, installing vLLM, and the SSH tunnel. Those are ops, and `jarvis-foundry` already targets them. This plan assumes an endpoint reachable at a base URL.

---

## File Structure

| File | Responsibility |
|---|---|
| `server-jarvis/src/providers.ts` | Add `vllm` to the provider union, target resolution, and a new native-tools capability predicate. |
| `server-jarvis/src/config.ts` | `cfg.vllm` config block + defaults. |
| `server-jarvis/src/provider-availability.ts` | Availability gate + routable set. |
| `server-jarvis/src/orchestration/agent-pool.ts` | Widen `OrchestratorAgent["provider"]`. |
| `server-jarvis/src/openrouter.ts` | Stop deleting `tools` for providers that support them. |
| `server-jarvis/src/providers.test.ts` | Tests for target resolution + capability predicate. |

---

### Task 1: Provider identity and target resolution

**Files:**
- Modify: `server-jarvis/src/providers.ts:14`
- Test: `server-jarvis/src/providers.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server-jarvis/src/providers.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { resolveProviderTarget, providerChatUrl } from "./providers";
import type { JarvisConfig } from "./config";

function cfgWithVllm(over: Record<string, unknown> = {}): JarvisConfig {
  return {
    openrouter: { base_url: "", api_key: "", site_url: "", site_name: "" },
    vllm: {
      base_url: "http://127.0.0.1:8000/v1",
      api_key: "vllm-local-key-1234567890",
      first_token_timeout_ms: 120_000,
      ...over,
    },
  } as unknown as JarvisConfig;
}

describe("vllm provider target", () => {
  test("resolves base url, key and chat path", () => {
    const target = resolveProviderTarget(cfgWithVllm(), "vllm");
    expect(target.provider).toBe("vllm");
    expect(target.base_url).toBe("http://127.0.0.1:8000/v1");
    expect(target.api_key).toBe("vllm-local-key-1234567890");
    expect(target.chat_path).toBe("/chat/completions");
  });

  test("strips trailing slashes from the configured base url", () => {
    const target = resolveProviderTarget(cfgWithVllm({ base_url: "http://gpu.local:8000/v1//" }), "vllm");
    expect(target.base_url).toBe("http://gpu.local:8000/v1");
    expect(providerChatUrl(target)).toBe("http://gpu.local:8000/v1/chat/completions");
  });

  test("cold-start timeout defaults high when unset", () => {
    const target = resolveProviderTarget(cfgWithVllm({ first_token_timeout_ms: 0 }), "vllm");
    expect(target.first_token_timeout_ms).toBe(120_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/providers.test.ts`
Expected: FAIL — `UnroutableProviderError: Unroutable orchestrator provider "vllm"`.

- [ ] **Step 3: Add the provider to the union and resolver**

In `server-jarvis/src/providers.ts`, change the type on line 14:

```typescript
/** Providers that are reachable over the OpenAI-compatible HTTP path. */
export type HttpProviderId = "openrouter" | "opencode_zen" | "opencode_go" | "vllm";
```

Add this case to `resolveProviderTarget`, immediately before `default:`:

```typescript
    case "vllm":
      // Self-hosted vLLM speaks the OpenAI chat-completions protocol natively,
      // so it needs no translation layer — only its own endpoint and key.
      // The default timeout is deliberately far above the remote-provider 45s:
      // a cold vLLM worker loading weights can exceed a minute before the first
      // token, and a tighter watchdog would kill every first request after boot.
      return {
        provider: "vllm",
        base_url: (cfg.vllm?.base_url || "http://127.0.0.1:8000/v1").replace(/\/+$/, ""),
        api_key: cfg.vllm?.api_key || "",
        first_token_timeout_ms: cfg.vllm?.first_token_timeout_ms || 120_000,
        chat_path: "/chat/completions",
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/providers.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/providers.ts server-jarvis/src/providers.test.ts
git commit -m "feat(providers): add vllm as a fourth OpenAI-compatible provider"
```

---

### Task 2: Config block

**Files:**
- Modify: `server-jarvis/src/config.ts` (interface near the `opencode_go` block ~line 540, defaults ~line 540)
- Test: `server-jarvis/src/providers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server-jarvis/src/providers.test.ts`:

```typescript
import { loadConfig } from "./config";

describe("vllm config defaults", () => {
  test("ships a disabled-by-default vllm block", () => {
    const cfg = loadConfig();
    expect(cfg.vllm).toBeDefined();
    expect(cfg.vllm.base_url).toBe("");
    expect(cfg.vllm.api_key).toBe("");
    expect(cfg.vllm.first_token_timeout_ms).toBe(120_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/providers.test.ts`
Expected: FAIL — `expect(received).toBeDefined()` received `undefined`.

- [ ] **Step 3: Add the interface and defaults**

In `server-jarvis/src/config.ts`, add this interface next to the other provider interfaces:

```typescript
/**
 * Self-hosted vLLM endpoint. Blank base_url means "not configured" — the
 * provider is then unavailable and the pool never routes to it, exactly like
 * a missing API key on a remote provider. Not a shipped default for any other
 * install: this is per-machine infrastructure.
 */
export interface VllmConfig {
  base_url: string;
  api_key: string;
  first_token_timeout_ms: number;
}
```

Add `vllm: VllmConfig;` to the `JarvisConfig` interface, and add this to the defaults object beside `opencode_go`:

```typescript
    vllm: {
      base_url: "",
      api_key: "",
      first_token_timeout_ms: 120_000,
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/providers.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/config.ts server-jarvis/src/providers.test.ts
git commit -m "feat(config): add vllm provider config block"
```

---

### Task 3: Availability gate and routable set

**Files:**
- Modify: `server-jarvis/src/provider-availability.ts:11-28`, `:39`
- Modify: `server-jarvis/src/orchestration/agent-pool.ts:29`
- Test: `server-jarvis/src/provider-availability.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server-jarvis/src/provider-availability.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { isProviderAvailable } from "./provider-availability";
import type { JarvisConfig } from "./config";

function cfg(vllm: Record<string, unknown>): JarvisConfig {
  return {
    openrouter: { api_key: "" },
    claude_cli: { enabled: false },
    vllm,
  } as unknown as JarvisConfig;
}

describe("vllm availability", () => {
  test("unavailable when base_url is blank", () => {
    expect(isProviderAvailable(cfg({ base_url: "", api_key: "key-1234567890" }), "vllm")).toBe(false);
  });

  test("available with a base url even when the key is blank", () => {
    // vLLM may be launched without --api-key on a private tunnel. The endpoint
    // itself is the credential-equivalent here, so base_url is what gates it.
    expect(isProviderAvailable(cfg({ base_url: "http://127.0.0.1:8000/v1", api_key: "" }), "vllm")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/provider-availability.test.ts`
Expected: FAIL — TypeScript error, `"vllm"` is not assignable to `RoutedProvider`.

- [ ] **Step 3: Widen the union and add the gate**

In `server-jarvis/src/orchestration/agent-pool.ts:29`, widen the provider union:

```typescript
  provider: "openrouter" | "ollama" | "claude_cli" | "opencode_zen" | "opencode_go" | "vllm";
```

In `server-jarvis/src/provider-availability.ts`, add this case to `isProviderAvailable` before `case "ollama":`:

```typescript
    case "vllm":
      // Gated on the endpoint, not a key: vLLM behind a private tunnel is
      // commonly launched without --api-key, so an empty key is legitimate.
      return typeof cfg.vllm?.base_url === "string" && cfg.vllm.base_url.trim().length > 0;
```

In the same file, add `"vllm"` to the `ROUTABLE` set inside `routableOrchestratorAgents`:

```typescript
  const ROUTABLE = new Set(["openrouter", "opencode_zen", "opencode_go", "ollama", "vllm"]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/provider-availability.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/provider-availability.ts server-jarvis/src/orchestration/agent-pool.ts server-jarvis/src/provider-availability.test.ts
git commit -m "feat(pool): route vllm agents through provider availability"
```

---

### Task 4: Preserve native tools for vLLM

**Files:**
- Modify: `server-jarvis/src/providers.ts` (new export)
- Modify: `server-jarvis/src/openrouter.ts:900-921` (`buildAttemptBody`)
- Test: `server-jarvis/src/providers.test.ts`

This is the one place the new provider is not just another row in a switch. `buildAttemptBody` currently treats "not OpenRouter" as "cannot do native tools" and deletes `body.tools`. That is true of OpenCode Zen/Go and false of vLLM.

- [ ] **Step 1: Write the failing test**

Append to `server-jarvis/src/providers.test.ts`:

```typescript
import { providerSupportsNativeTools } from "./providers";

describe("native tool support by provider", () => {
  test("openrouter and vllm support native tools", () => {
    expect(providerSupportsNativeTools("openrouter")).toBe(true);
    expect(providerSupportsNativeTools("vllm")).toBe(true);
  });

  test("opencode providers use the text tool protocol", () => {
    expect(providerSupportsNativeTools("opencode_zen")).toBe(false);
    expect(providerSupportsNativeTools("opencode_go")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/providers.test.ts`
Expected: FAIL — `providerSupportsNativeTools is not a function`.

- [ ] **Step 3: Add the predicate and use it**

In `server-jarvis/src/providers.ts`, add:

```typescript
/**
 * Whether a provider accepts an OpenAI `tools` block on the request.
 *
 * OpenCode Zen/Go do not and must use the text tool protocol — sending
 * `tools` there produces a 400 on every model in the cascade. vLLM does,
 * so it must NOT be lumped in with them by a "not openrouter" test.
 */
export function providerSupportsNativeTools(provider: HttpProviderId): boolean {
  return provider === "openrouter" || provider === "vllm";
}
```

In `server-jarvis/src/openrouter.ts`, import it and restructure `buildAttemptBody`'s branch:

```typescript
  const body: Record<string, any> = { ...requestBody, model };
  if (provider === "openrouter") {
    await applyOpenRouterRequestConfig(body, cfg, model, body.messages ?? [], {
      requestedTemperature: requestBody.temperature,
      requestedTopP: requestBody.top_p,
    });
    if (!body.tools && Array.isArray(body.messages)) {
      body.messages = sanitizeToolMessages(body.messages);
    }
  } else if (providerSupportsNativeTools(provider)) {
    // vLLM: keep the tools block intact. Only sanitize tool-shaped messages
    // when we are not sending tools, mirroring the OpenRouter branch.
    if (!body.tools && Array.isArray(body.messages)) {
      body.messages = sanitizeToolMessages(body.messages);
    }
  } else {
    delete body.tools;
    delete body.tool_choice;
    if (Array.isArray(body.messages)) {
      body.messages = sanitizeToolMessages(body.messages);
    }
    if (provider === "opencode_go" && openCodeGoProtocolForModel(model) === "anthropic") {
      return buildAnthropicAttemptBody(body, model);
    }
  }
  return body;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server-jarvis && bun test src/providers.test.ts src/openrouter.test.ts`
Expected: PASS — 6 provider tests, and the existing openrouter suite unchanged.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/providers.ts server-jarvis/src/openrouter.ts server-jarvis/src/providers.test.ts
git commit -m "fix(providers): keep native tools for vllm instead of stripping them"
```

---

### Task 5: Health probe

**Files:**
- Create: `server-jarvis/src/vllm-health.ts`
- Test: `server-jarvis/src/vllm-health.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server-jarvis/src/vllm-health.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { checkVllmHealth } from "./vllm-health";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("checkVllmHealth", () => {
  test("reports reachable with served model ids", async () => {
    const fetchFn = async () => jsonResponse({ data: [{ id: "Qwen/Qwen3-32B-AWQ" }] });
    const health = await checkVllmHealth(
      { base_url: "http://gpu.local:8000/v1", api_key: "k", first_token_timeout_ms: 120_000 },
      { fetch: fetchFn as unknown as typeof fetch },
    );
    expect(health.reachable).toBe(true);
    expect(health.models).toEqual(["Qwen/Qwen3-32B-AWQ"]);
  });

  test("reports unreachable with a reason when the endpoint errors", async () => {
    const fetchFn = async () => { throw new Error("ECONNREFUSED"); };
    const health = await checkVllmHealth(
      { base_url: "http://gpu.local:8000/v1", api_key: "", first_token_timeout_ms: 120_000 },
      { fetch: fetchFn as unknown as typeof fetch },
    );
    expect(health.reachable).toBe(false);
    expect(health.error).toContain("ECONNREFUSED");
    expect(health.models).toEqual([]);
  });

  test("blank base url short-circuits without a request", async () => {
    let called = false;
    const fetchFn = async () => { called = true; return jsonResponse({ data: [] }); };
    const health = await checkVllmHealth(
      { base_url: "", api_key: "", first_token_timeout_ms: 120_000 },
      { fetch: fetchFn as unknown as typeof fetch },
    );
    expect(called).toBe(false);
    expect(health.reachable).toBe(false);
    expect(health.error).toBe("not configured");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/vllm-health.test.ts`
Expected: FAIL — cannot resolve module `./vllm-health`.

- [ ] **Step 3: Write the implementation**

Create `server-jarvis/src/vllm-health.ts`:

```typescript
// ═══════════════════════════════════════════════════════════════
// vLLM endpoint health — reachability + served model ids
// ═══════════════════════════════════════════════════════════════
// Mirrors checkOllamaHealth's shape so the /health surface can treat local
// and remote self-hosted inference the same way.

import type { VllmConfig } from "./config";

export interface VllmHealth {
  reachable: boolean;
  models: string[];
  latency_ms: number;
  error?: string;
}

export interface VllmHealthDeps {
  fetch?: typeof fetch;
}

const PROBE_TIMEOUT_MS = 5_000;

export async function checkVllmHealth(
  cfg: VllmConfig,
  deps: VllmHealthDeps = {},
): Promise<VllmHealth> {
  const base = (cfg.base_url || "").replace(/\/+$/, "");
  if (!base) {
    return { reachable: false, models: [], latency_ms: 0, error: "not configured" };
  }

  const fetchFn = deps.fetch ?? fetch;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
    const res = await fetchFn(`${base}/models`, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = (json.data ?? [])
      .map((m) => (typeof m.id === "string" ? m.id : ""))
      .filter((id): id is string => id.length > 0);
    return { reachable: true, models, latency_ms: Date.now() - started };
  } catch (e) {
    return {
      reachable: false,
      models: [],
      latency_ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/vllm-health.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/vllm-health.ts server-jarvis/src/vllm-health.test.ts
git commit -m "feat(vllm): endpoint health probe"
```

---

### Task 6: Full suite and manual verification

- [ ] **Step 1: Run the whole server test suite**

Run: `cd server-jarvis && bun test`
Expected: PASS. If anything fails, it will be a switch statement that now needs a `vllm` case — TypeScript exhaustiveness will point at the exact file.

- [ ] **Step 2: Point config at a real endpoint**

Edit `C:\Users\ethan\.openclaw\jarvis\config.json` and set:

```json
"vllm": {
  "base_url": "http://127.0.0.1:8000/v1",
  "api_key": "",
  "first_token_timeout_ms": 120000
}
```

Note: edit the live config, NOT `src/config.ts` — a personal endpoint must never become a shipped default. Same rule that governs the conductor model pin.

- [ ] **Step 3: Verify the probe against the running endpoint**

Run:

```bash
curl -s http://127.0.0.1:8000/v1/models
```

Expected: JSON with a `data` array naming the served model. If this fails, the tunnel or the vLLM process is the problem, not home-base.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(vllm): full suite green with the new provider"
```

---

## Self-Review

**Spec coverage:** provider identity (T1), config (T2), availability + pool routing (T3), native tools (T4), health (T5), verification (T6). Endpoint provisioning is explicitly out of scope.

**Types:** `HttpProviderId` gains `"vllm"` in T1 and is used by `providerSupportsNativeTools` in T4. `VllmConfig` is defined in T2 and consumed by T5. `OrchestratorAgent["provider"]` is widened in T3.

**Known risk:** widening `OrchestratorAgent["provider"]` may surface non-exhaustive switches elsewhere. That is the point — T6 step 1 is where they surface, and each is a one-line addition.
