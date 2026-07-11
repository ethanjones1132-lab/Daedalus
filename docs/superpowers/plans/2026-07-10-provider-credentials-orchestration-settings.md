# Provider Credentials and Orchestration Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenRouter, OpenCode Zen, and OpenCode Go credentials independently configurable and verifiably active at runtime, and expose a durable master switch for the Jarvis orchestration runtime.

**Architecture:** Keep SQLite `settings` as the Native surface's canonical configuration store. Extend the Rust and UI schemas to represent the two OpenCode provider records and the orchestration-enabled flag, then project that complete state into Bun's shared `config.json`. After every native save, explicitly reload Bun's in-memory configuration and compare redacted fingerprints, so a successfully saved key is proved active in the running Bun server rather than merely displayed in the UI.

**Tech Stack:** Rust/Tauri 2 + `rusqlite` + `reqwest`; Bun + TypeScript; React 19 + Vite + Vitest; existing `server-jarvis` provider routing and orchestration pipeline.

## Global Constraints

- SQLite `settings` remains the canonical store; do not make the Bun HTTP route a competing write authority.
- Keep all credentials out of logs, toast text, SSE payloads, and response bodies; expose only `configured` booleans and deterministic truncated SHA-256 fingerprints.
- Preserve existing `opencode_zen`, `opencode_go`, and nested `orchestrator` data during migration and every subsequent save.
- `orchestrator.enabled = false` affects only newly started Session turns; do not interrupt an in-flight orchestration pipeline.
- Provider tests must use each provider's own configured base URL and `Authorization` header. An OpenCode test must never fall through to the OpenRouter key.
- Runtime proof must identify the serving Bun build through the existing `/health` provenance fields before a desktop deployment is called complete.

---

## Traced fault and file map

The current Bun schema already owns `opencode_zen`, `opencode_go`, and `orchestrator`, while the Native-surface `JarvisConfig` and React `JarvisConfig` omit all three. `jarvis_save_config` therefore serializes an older subset into the SQLite-to-file projection. In addition, Bun keeps `loadConfig()` in a five-second cache, so the current native save path has no positive proof that a running server has reread the new key.

| File | Responsibility after this work |
| --- | --- |
| `src-tauri/src/jarvis/types.rs` | Native config types for OpenCode Zen, OpenCode Go, and a forward-compatible orchestration record. |
| `src-tauri/src/commands/settings.rs` | SQLite load/persist of the new top-level JSON records. |
| `src-tauri/src/commands/jarvis_commands.rs` | Save result, Bun reload handshake, and provider-test command forwarding. |
| `src-tauri/Cargo.toml` | SHA-256 implementation used only for redacted key fingerprints. |
| `server-jarvis/src/config.ts` | Explicit cache reload and a secret-safe runtime configuration evidence payload. |
| `server-jarvis/src/provider-health.ts` | Provider-specific `/models` health probe with normalized, non-secret errors. |
| `server-jarvis/src/orchestration/runtime-mode.ts` | Single testable gate for whether a new Session turn may enter orchestration. |
| `server-jarvis/src/index.ts` | `/config/reload`, `/providers/test`, and use of the shared orchestration gate. |
| `src-ui/src/components/jarvis/types.ts` | Complete UI config contract for the new fields. |
| `src-ui/src/components/jarvis/JarvisView.tsx` | Provider credential inputs, independent tests, save/runtime-sync status, and orchestration toggle. |

## Interfaces established by this plan

```ts
// server-jarvis/src/config.ts
export type CredentialProvider = "openrouter" | "opencode_zen" | "opencode_go";

export interface CredentialEvidence {
  configured: boolean;
  fingerprint: string | null;
}

export interface RuntimeConfigEvidence {
  config_path: string;
  credentials: Record<CredentialProvider, CredentialEvidence>;
  orchestration_enabled: boolean;
}

export function reloadConfigFromDisk(): JarvisConfig;
export function runtimeConfigEvidence(cfg?: JarvisConfig): RuntimeConfigEvidence;
```

```rust
// src-tauri/src/commands/jarvis_commands.rs
#[derive(Serialize)]
pub struct ConfigSaveResult {
    pub persisted: bool,
    pub runtime_synced: bool,
    pub runtime: Option<serde_json::Value>,
    pub warning: Option<String>,
}

// Existing command changes its success payload from null to ConfigSaveResult.
pub async fn jarvis_save_config(
    config: JarvisConfig,
    state: State<'_, JarvisState>,
    db: State<'_, crate::db::AppDb>,
) -> Result<ConfigSaveResult, String>;
pub async fn jarvis_test_provider(provider: String, config: Option<Value>) -> Result<Value, String>;
```

```ts
// src-ui/src/components/jarvis/types.ts
type OpenCodeProviderConfig = { base_url: string; api_key: string };
type OrchestratorConfig = { enabled: boolean; [key: string]: unknown };
```

### Task 1: Extend the canonical Native-surface configuration contract

**Files:**
- Modify: `src-tauri/src/jarvis/types.rs`
- Modify: `src-tauri/src/commands/settings.rs`
- Modify: `src-ui/src/components/jarvis/types.ts`
- Modify: `src-ui/src/components/jarvis/SettingsView.tsx`
- Test: `src-tauri/src/commands/settings.rs`

**Consumes:** Bun's existing `OpenCodeProviderConfig` defaults and `OrchestratorConfig` shape from `server-jarvis/src/config.ts`.

**Produces:** A SQLite round-trip that preserves both OpenCode key slots and every nested Bun-owned orchestration field while letting the UI control `orchestrator.enabled`.

- [ ] **Step 1: Write the failing SQLite round-trip test before adding fields.**

  Add this test to the existing `#[cfg(test)] mod tests` in `src-tauri/src/commands/settings.rs`:

  ```rust
  #[test]
  fn persist_round_trips_opencode_credentials_and_orchestrator_payload() {
      let db = mem_db();
      let mut cfg = JarvisConfig::default();
      cfg.opencode_zen.api_key = "zen-secret-123".to_string();
      cfg.opencode_go.api_key = "go-secret-456".to_string();
      cfg.orchestrator.enabled = false;
      cfg.orchestrator.extra.insert(
          "conductor".to_string(),
          serde_json::json!({ "enabled": true, "model": "gemma" }),
      );

      persist_jarvis_config(&db, &cfg).expect("persist config");
      let loaded = load_jarvis_config(&db).expect("load config");

      assert_eq!(loaded.opencode_zen.api_key, "zen-secret-123");
      assert_eq!(loaded.opencode_go.api_key, "go-secret-456");
      assert!(!loaded.orchestrator.enabled);
      assert_eq!(
          loaded.orchestrator.extra.get("conductor"),
          Some(&serde_json::json!({ "enabled": true, "model": "gemma" })),
      );
  }
  ```

- [ ] **Step 2: Run the targeted test and confirm it fails to compile because the fields do not exist.**

  Run:

  ```powershell
  cargo test persist_round_trips_opencode_credentials_and_orchestrator_payload --manifest-path src-tauri/Cargo.toml
  ```

  Expected: compilation errors naming missing `opencode_zen`, `opencode_go`, and `orchestrator` fields.

- [ ] **Step 3: Add forward-compatible Rust types and defaults.**

  In `src-tauri/src/jarvis/types.rs`, add the following before `JarvisConfig`, then add the three fields to `JarvisConfig` immediately after `openrouter` and `companion` respectively:

  ```rust
  #[derive(Debug, Serialize, Deserialize, Clone)]
  pub struct OpenCodeProviderConfig {
      #[serde(default)]
      pub base_url: String,
      #[serde(default)]
      pub api_key: String,
  }

  impl OpenCodeProviderConfig {
      fn zen_default() -> Self {
          Self { base_url: "https://opencode.ai/zen/v1".to_string(), api_key: String::new() }
      }

      fn go_default() -> Self {
          Self { base_url: "https://opencode.ai/zen/go/v1".to_string(), api_key: String::new() }
      }
  }

  #[derive(Debug, Serialize, Deserialize, Clone)]
  pub struct OrchestratorConfig {
      #[serde(default = "default_orchestrator_enabled")]
      pub enabled: bool,
      #[serde(flatten)]
      pub extra: serde_json::Map<String, serde_json::Value>,
  }

  fn default_orchestrator_enabled() -> bool { true }

  impl Default for OrchestratorConfig {
      fn default() -> Self { Self { enabled: true, extra: serde_json::Map::new() } }
  }
  ```

  Add these `JarvisConfig` fields and matching default values:

  ```rust
  pub opencode_zen: OpenCodeProviderConfig,
  pub opencode_go: OpenCodeProviderConfig,
  // ... after companion
  pub orchestrator: OrchestratorConfig,

  // JarvisConfig::default()
  opencode_zen: OpenCodeProviderConfig::zen_default(),
  opencode_go: OpenCodeProviderConfig::go_default(),
  orchestrator: OrchestratorConfig::default(),
  ```

  `#[serde(flatten)]` is intentional: Bun remains the owner of detailed conductor, pool, and learning settings. The Native surface stores and re-projects those unknown fields without duplicating the fast-moving server schema.

- [ ] **Step 4: Load and persist all three new records in SQLite.**

  In `src-tauri/src/commands/settings.rs`:

  1. Add `"opencode_zen"`, `"opencode_go"`, and `"orchestrator"` to `KNOWN_SETTING_KEYS`.
  2. After the existing `openrouter` loader, deserialize `opencode_zen` and `opencode_go` as `OpenCodeProviderConfig`.
  3. After the existing `companion` loader, deserialize `orchestrator` as `OrchestratorConfig`.
  4. Add these entries to the `pairs` vector in `persist_jarvis_config_conn`:

  ```rust
  (
      "opencode_zen",
      serde_json::to_string(&config.opencode_zen).map_err(|e| e.to_string())?,
  ),
  (
      "opencode_go",
      serde_json::to_string(&config.opencode_go).map_err(|e| e.to_string())?,
  ),
  (
      "orchestrator",
      serde_json::to_string(&config.orchestrator).map_err(|e| e.to_string())?,
  ),
  ```

  Preserve the existing `crate::jarvis::save_jarvis_config(&config)` deep projection; after this task its overlay contains the new top-level records, while its recursive merge continues preserving Bun-only nested fields.

- [ ] **Step 5: Make the UI compile against the same shape.**

  In `src-ui/src/components/jarvis/types.ts`, add `opencode_zen`, `opencode_go`, and `orchestrator` to `JarvisConfig`:

  ```ts
  opencode_zen: { base_url: string; api_key: string };
  opencode_go: { base_url: string; api_key: string };
  orchestrator: { enabled: boolean; [key: string]: unknown };
  ```

  Add `opencode_zen` and `opencode_go` to the `KNOWN_SETTING_KEYS` set in `SettingsView.tsx` so the raw settings surface does not reject the newly canonical records.

- [ ] **Step 6: Run the Native and UI contract checks.**

  Run:

  ```powershell
  cargo test persist_round_trips_opencode_credentials_and_orchestrator_payload --manifest-path src-tauri/Cargo.toml
  Set-Location src-ui; bun run build
  ```

  Expected: the Rust test passes and `tsc -b && vite build` completes without a missing-field error.

- [ ] **Step 7: Commit the independently valid configuration-contract slice.**

  ```powershell
  git add src-tauri/src/jarvis/types.rs src-tauri/src/commands/settings.rs src-ui/src/components/jarvis/types.ts src-ui/src/components/jarvis/SettingsView.tsx
  git commit -m "feat: persist OpenCode and orchestration settings"
  ```

### Task 2: Add Bun runtime reload and secret-safe configuration evidence

**Files:**
- Modify: `server-jarvis/src/config.ts`
- Modify: `server-jarvis/src/config-regression.test.ts`
- Modify: `server-jarvis/src/index.ts`

**Consumes:** The shared config file written by the Native-surface projection.

**Produces:** `POST /config/reload` returns the configuration Bun actually loaded, without returning a secret, and invalidates the five-second cache immediately.

- [ ] **Step 1: Write failing tests for fingerprinting and forced reload.**

  Add to `server-jarvis/src/config-regression.test.ts`:

  ```ts
  import { credentialFingerprint, runtimeConfigEvidence } from "./config";

  test("credential evidence never returns raw key text", () => {
    const cfg = defaultConfig();
    cfg.openrouter.api_key = "sk-or-v1-secret-value";
    cfg.opencode_zen.api_key = "zen-secret-value";
    cfg.opencode_go.api_key = "go-secret-value";
    cfg.orchestrator.enabled = false;

    const evidence = runtimeConfigEvidence(cfg);
    expect(evidence.credentials.openrouter).toEqual({ configured: true, fingerprint: credentialFingerprint("sk-or-v1-secret-value") });
    expect(JSON.stringify(evidence)).not.toContain("secret-value");
    expect(evidence.orchestration_enabled).toBe(false);
  });

  test("credentialFingerprint is stable, truncated, and blank-safe", () => {
    expect(credentialFingerprint("")).toBeNull();
    expect(credentialFingerprint("same-key")).toBe(credentialFingerprint("same-key"));
    expect(credentialFingerprint("same-key")).toHaveLength(12);
    expect(credentialFingerprint("same-key")).not.toBe(credentialFingerprint("other-key"));
  });
  ```

- [ ] **Step 2: Run the focused Bun test and confirm the exports are missing.**

  Run:

  ```powershell
  Set-Location server-jarvis; bun test src/config-regression.test.ts
  ```

  Expected: FAIL with missing exports from `./config`.

- [ ] **Step 3: Implement evidence and a cache-bypassing reload in `config.ts`.**

  Add `createHash` import and these exported definitions after `invalidateConfigCache`:

  ```ts
  import { createHash } from "crypto";

  export type CredentialProvider = "openrouter" | "opencode_zen" | "opencode_go";

  export interface CredentialEvidence {
    configured: boolean;
    fingerprint: string | null;
  }

  export interface RuntimeConfigEvidence {
    config_path: string;
    credentials: Record<CredentialProvider, CredentialEvidence>;
    orchestration_enabled: boolean;
  }

  export function credentialFingerprint(secret: string): string | null {
    if (!secret.trim()) return null;
    return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 12);
  }

  export function runtimeConfigEvidence(cfg: JarvisConfig = loadConfig()): RuntimeConfigEvidence {
    const evidence = (secret: string): CredentialEvidence => ({
      configured: secret.trim().length > 0,
      fingerprint: credentialFingerprint(secret),
    });
    return {
      config_path: CONFIG_FILE,
      credentials: {
        openrouter: evidence(cfg.openrouter.api_key),
        opencode_zen: evidence(cfg.opencode_zen.api_key),
        opencode_go: evidence(cfg.opencode_go.api_key),
      },
      orchestration_enabled: cfg.orchestrator.enabled === true,
    };
  }

  export function reloadConfigFromDisk(): JarvisConfig {
    invalidateConfigCache();
    return loadConfig();
  }
  ```

  Never put the full `JarvisConfig` in this endpoint's response because it includes all three credentials.

- [ ] **Step 4: Add the loopback reload route.**

  Update the `server-jarvis/src/index.ts` config imports to include `reloadConfigFromDisk` and `runtimeConfigEvidence`. Immediately before the existing `GET /config` branch, add:

  ```ts
  if (path === "/config/reload" && req.method === "POST") {
    const cfg = reloadConfigFromDisk();
    return Response.json({ ok: true, runtime: runtimeConfigEvidence(cfg) });
  }
  ```

  Leave `GET /config` unchanged for this task; the desktop UI must use the safe reload response, not a config payload containing key text.

- [ ] **Step 5: Run the Bun tests and typecheck.**

  Run:

  ```powershell
  Set-Location server-jarvis
  bun test src/config-regression.test.ts
  bun run typecheck
  ```

  Expected: all focused tests pass and TypeScript emits no errors.

- [ ] **Step 6: Commit the runtime-evidence slice.**

  ```powershell
  git add server-jarvis/src/config.ts server-jarvis/src/config-regression.test.ts server-jarvis/src/index.ts
  git commit -m "feat: prove active runtime configuration safely"
  ```

### Task 3: Implement provider-specific connection tests

**Files:**
- Create: `server-jarvis/src/provider-health.ts`
- Create: `server-jarvis/src/provider-health.test.ts`
- Modify: `server-jarvis/src/index.ts`
- Modify: `src-tauri/src/commands/recovery_stubs.rs`
- Modify: `src-tauri/src/lib.rs`

**Consumes:** `resolveProviderTarget` and `providerHeaders` from `server-jarvis/src/providers.ts`.

**Produces:** A single provider probe that validates OpenRouter, Zen, or Go independently and maps failures to actionable, provider-specific messages.

- [ ] **Step 1: Write failing Bun tests for target selection and sanitized status errors.**

  Create `server-jarvis/src/provider-health.test.ts`:

  ```ts
  import { afterEach, describe, expect, test } from "bun:test";
  import { defaultConfig } from "./config";
  import { checkHttpProviderHealth } from "./provider-health";

  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  describe("checkHttpProviderHealth", () => {
    test("tests OpenCode Go with its own endpoint and key", async () => {
      const cfg = defaultConfig();
      cfg.opencode_go.api_key = "go-key";
      cfg.opencode_go.base_url = "https://go.example/v1";
      let seenUrl = "";
      let seenAuth = "";
      globalThis.fetch = (async (url, init) => {
        seenUrl = String(url);
        seenAuth = String((init?.headers as Record<string, string>).Authorization);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch;

      await expect(checkHttpProviderHealth(cfg, "opencode_go")).resolves.toMatchObject({ ok: true });
      expect(seenUrl).toBe("https://go.example/v1/models");
      expect(seenAuth).toBe("Bearer go-key");
    });

    test("does not leak a rejected key", async () => {
      const cfg = defaultConfig();
      cfg.opencode_zen.api_key = "zen-key-never-display";
      globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;

      const result = await checkHttpProviderHealth(cfg, "opencode_zen");
      expect(result).toMatchObject({ ok: false, error: "OpenCode Zen rejected this API key (401)." });
      expect(JSON.stringify(result)).not.toContain("zen-key-never-display");
    });
  });
  ```

- [ ] **Step 2: Run the test and confirm the provider-health module is absent.**

  Run:

  ```powershell
  Set-Location server-jarvis; bun test src/provider-health.test.ts
  ```

  Expected: FAIL with `Cannot find module './provider-health'`.

- [ ] **Step 3: Implement the provider probe.**

  Create `server-jarvis/src/provider-health.ts`:

  ```ts
  import type { JarvisConfig } from "./config";
  import { providerHeaders, resolveProviderTarget, type HttpProviderId } from "./providers";

  export interface ProviderHealth {
    ok: boolean;
    latency_ms: number;
    error?: string;
  }

  const providerName: Record<HttpProviderId, string> = {
    openrouter: "OpenRouter",
    opencode_zen: "OpenCode Zen",
    opencode_go: "OpenCode Go",
  };

  export async function checkHttpProviderHealth(cfg: JarvisConfig, provider: HttpProviderId): Promise<ProviderHealth> {
    const target = resolveProviderTarget(cfg, provider);
    const name = providerName[target.provider];
    if (!target.api_key.trim()) return { ok: false, latency_ms: 0, error: `${name} API key is not configured.` };
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${target.base_url}/models`, {
        method: "GET",
        headers: providerHeaders(cfg, target),
        signal: controller.signal,
      });
      if (response.ok) return { ok: true, latency_ms: Date.now() - startedAt };
      const error = response.status === 401 ? `${name} rejected this API key (401).`
        : response.status === 403 ? `${name} denied access for this API key (403).`
        : response.status === 429 ? `${name} rate limited this request (429).`
        : `${name} returned HTTP ${response.status}.`;
      return { ok: false, latency_ms: Date.now() - startedAt, error };
    } catch (error) {
      return { ok: false, latency_ms: Date.now() - startedAt, error: `${name} connection failed: ${error instanceof Error ? error.message : "unknown error"}` };
    } finally {
      clearTimeout(timeout);
    }
  }
  ```

- [ ] **Step 4: Expose a provider test route and Native-surface proxy.**

  In `server-jarvis/src/index.ts`, import `checkHttpProviderHealth` and `HttpProviderId`. Immediately before `/test`, add:

  ```ts
  if (path === "/providers/test" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { provider?: string; config?: Partial<JarvisConfig> };
    const provider = body.provider;
    if (provider !== "openrouter" && provider !== "opencode_zen" && provider !== "opencode_go") {
      return Response.json({ ok: false, latency_ms: 0, error: "Unknown HTTP provider." }, { status: 400 });
    }
    return Response.json(await checkHttpProviderHealth(resolveConfig(body.config), provider as HttpProviderId));
  }
  ```

  Add `jarvis_test_provider` in `src-tauri/src/commands/recovery_stubs.rs`. It must validate the same three string values, POST `{ provider, config }` to `"/providers/test"` using the existing `bun_base()` and `http_client()` helpers, and return the server JSON unchanged. Register the command in `src-tauri/src/lib.rs` next to `jarvis_test_connection`.

- [ ] **Step 5: Run focused tests and compile the command surface.**

  Run:

  ```powershell
  Set-Location server-jarvis; bun test src/provider-health.test.ts
  Set-Location ..; cargo test --lib --manifest-path src-tauri/Cargo.toml
  ```

  Expected: the Go endpoint/key assertion and the redaction assertion pass; Rust command registration compiles.

- [ ] **Step 6: Commit the provider-test slice.**

  ```powershell
  git add server-jarvis/src/provider-health.ts server-jarvis/src/provider-health.test.ts server-jarvis/src/index.ts src-tauri/src/commands/recovery_stubs.rs src-tauri/src/lib.rs
  git commit -m "feat: test provider credentials independently"
  ```

### Task 4: Make orchestration mode an explicit, tested runtime boundary

**Files:**
- Create: `server-jarvis/src/orchestration/runtime-mode.ts`
- Create: `server-jarvis/src/orchestration/runtime-mode.test.ts`
- Modify: `server-jarvis/src/index.ts`

**Consumes:** `JarvisConfig.orchestrator.enabled` persisted by Task 1.

**Produces:** A single predicate used by all chat-path decisions, proving that disabled mode takes the direct inference path for new turns.

- [ ] **Step 1: Write the failing predicate test.**

  Create `server-jarvis/src/orchestration/runtime-mode.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { defaultConfig } from "../config";
  import { isOrchestrationEnabled } from "./runtime-mode";

  describe("isOrchestrationEnabled", () => {
    test("defaults to enabled for the established Jarvis runtime", () => {
      expect(isOrchestrationEnabled(defaultConfig())).toBe(true);
    });

    test("disables orchestration only when the persisted master flag is false", () => {
      const cfg = defaultConfig();
      cfg.orchestrator.enabled = false;
      expect(isOrchestrationEnabled(cfg)).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run the test and confirm the gate does not yet exist.**

  Run:

  ```powershell
  Set-Location server-jarvis; bun test src/orchestration/runtime-mode.test.ts
  ```

  Expected: FAIL with `Cannot find module './runtime-mode'`.

- [ ] **Step 3: Implement and use the one orchestration gate.**

  Create `server-jarvis/src/orchestration/runtime-mode.ts`:

  ```ts
  import type { JarvisConfig } from "../config";

  export function isOrchestrationEnabled(cfg: Pick<JarvisConfig, "orchestrator">): boolean {
    return cfg.orchestrator?.enabled === true;
  }
  ```

  In `server-jarvis/src/index.ts`, import this function and replace both chat-path checks:

  ```ts
  if (cfg.orchestrator?.enabled) {
  ```

  and

  ```ts
  if (stageLabel && cfg.orchestrator?.enabled) {
  ```

  with `isOrchestrationEnabled(cfg)`. Do not alter the existing code after the orchestration block: its current fall-through remains the direct selected-inference-backend path.

- [ ] **Step 4: Run focused orchestration tests and the full server suite.**

  Run:

  ```powershell
  Set-Location server-jarvis
  bun test src/orchestration/runtime-mode.test.ts
  bun test
  ```

  Expected: all tests pass; no existing conductor or pipeline test is changed merely to accommodate disabled mode.

- [ ] **Step 5: Commit the runtime-toggle slice.**

  ```powershell
  git add server-jarvis/src/orchestration/runtime-mode.ts server-jarvis/src/orchestration/runtime-mode.test.ts server-jarvis/src/index.ts
  git commit -m "feat: gate orchestration with persisted runtime setting"
  ```

### Task 5: Synchronize the live Bun server after a Native config save

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/commands/jarvis_commands.rs`
- Test: `src-tauri/src/commands/jarvis_commands.rs`
- Modify: `src-ui/src/components/jarvis/JarvisView.tsx`

**Consumes:** The safe `/config/reload` response from Task 2 and the complete persisted config from Task 1.

**Produces:** A save operation that succeeds only after SQLite/file persistence, then reports whether the currently serving Bun runtime loaded matching credentials and orchestration state.

- [ ] **Step 1: Write failing Rust unit tests for secret fingerprint comparison.**

  In the existing `status_check_tests` module in `src-tauri/src/commands/jarvis_commands.rs`, add pure helper tests:

  ```rust
  #[test]
  fn runtime_fingerprint_match_requires_each_configured_provider_to_match() {
      let expected = serde_json::json!({
          "openrouter": "aaaa11111111",
          "opencode_zen": "bbbb22222222",
          "opencode_go": "cccc33333333"
      });
      let runtime = serde_json::json!({
          "credentials": {
              "openrouter": { "configured": true, "fingerprint": "aaaa11111111" },
              "opencode_zen": { "configured": true, "fingerprint": "bbbb22222222" },
              "opencode_go": { "configured": true, "fingerprint": "cccc33333333" }
          },
          "orchestration_enabled": false
      });
      assert!(runtime_matches_expected(&expected, false, &runtime));
      assert!(!runtime_matches_expected(&expected, true, &runtime));
  }
  ```

- [ ] **Step 2: Run the focused test and confirm its helper is absent.**

  Run:

  ```powershell
  cargo test runtime_fingerprint_match_requires_each_configured_provider_to_match --manifest-path src-tauri/Cargo.toml
  ```

  Expected: FAIL because `runtime_matches_expected` is undefined.

- [ ] **Step 3: Add only the required hashing dependency and pure comparison helpers.**

  Add to `src-tauri/Cargo.toml`:

  ```toml
  sha2 = "0.10"
  ```

  In `jarvis_commands.rs`, add `sha2::{Digest, Sha256}` and implement:

  ```rust
  fn fingerprint(secret: &str) -> Option<String> {
      if secret.trim().is_empty() { return None; }
      let digest = Sha256::digest(secret.as_bytes());
      Some(format!("{:x}", digest)[..12].to_string())
  }

  fn expected_fingerprints(config: &JarvisConfig) -> serde_json::Value {
      serde_json::json!({
          "openrouter": fingerprint(&config.openrouter.api_key),
          "opencode_zen": fingerprint(&config.opencode_zen.api_key),
          "opencode_go": fingerprint(&config.opencode_go.api_key),
      })
  }
  ```

  Implement `runtime_matches_expected(expected, orchestration_enabled, runtime)` by comparing each `credentials.<provider>.fingerprint` to the optional expected fingerprint and comparing `orchestration_enabled`. A missing expected key must match `configured: false` and `fingerprint: null`; never treat a missing runtime field as a match.

- [ ] **Step 4: Change `jarvis_save_config` to return live-sync evidence.**

  After `persist_jarvis_config`, updating `JarvisState`, and `reconcile_backend_services`, attempt to start/reuse the Bun server with `crate::ensure_jarvis_server_started().await`. Then POST to `http://127.0.0.1:19877/config/reload` with a three-second request timeout.

  Return this structure:

  ```rust
  Ok(ConfigSaveResult {
      persisted: true,
      runtime_synced: runtime_matches_expected(
          &expected_fingerprints(&config),
          config.orchestrator.enabled,
          &runtime_payload,
      ),
      runtime: Some(runtime_payload),
      warning: None,
  })
  ```

  If server start, loopback connection, JSON decoding, or comparison fails, return `persisted: true`, `runtime_synced: false`, `runtime: None`, and a generic warning such as `"Configuration was saved, but the Bun runtime did not confirm the reload."`. Do not return the failing key, request body, or raw URL in that warning. Persistence failures remain `Err(...)` and must not update in-memory state.

- [ ] **Step 5: Consume the result in the UI save handler.**

  In `ConfigPanel` inside `JarvisView.tsx`, change the save invocation to `invoke<ConfigSaveResult>(...)`. On `persisted && runtime_synced`, show the existing saved state plus `Runtime confirmed`. When `persisted && !runtime_synced`, keep the saved state and render the returned generic warning with a visible `Retry runtime sync` button that calls `jarvis_save_config` again with the unchanged `localConfig`.

  Define only this response type near the panel:

  ```ts
  type ConfigSaveResult = {
    persisted: boolean;
    runtime_synced: boolean;
    runtime: { config_path: string; credentials: Record<string, { configured: boolean; fingerprint: string | null }>; orchestration_enabled: boolean } | null;
    warning: string | null;
  };
  ```

- [ ] **Step 6: Run Native tests, then build the UI.**

  Run:

  ```powershell
  cargo test --lib --manifest-path src-tauri/Cargo.toml
  Set-Location src-ui; bun run build
  ```

  Expected: Rust verifies matching and mismatching fingerprints; UI compiles against the non-secret response.

- [ ] **Step 7: Commit the synchronization slice.**

  ```powershell
  git add src-tauri/Cargo.toml src-tauri/src/commands/jarvis_commands.rs src-ui/src/components/jarvis/JarvisView.tsx
  git commit -m "feat: confirm config reload in Bun runtime"
  ```

### Task 6: Build the settings UX for three independent credentials and orchestration control

**Files:**
- Modify: `src-ui/src/components/jarvis/JarvisView.tsx`
- Create: `src-ui/src/components/jarvis/provider-settings.ts`
- Create: `src-ui/src/components/jarvis/provider-settings.test.ts`

**Consumes:** The complete `JarvisConfig`, `jarvis_test_provider`, and `ConfigSaveResult` from prior tasks.

**Produces:** A clear configuration view where each provider key has independent input/reveal/test state and the orchestration master switch describes its runtime effect.

- [ ] **Step 1: Write pure UI-helper tests before wiring JSX.**

  Create `src-ui/src/components/jarvis/provider-settings.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";
  import { providerLabel, providerTestState } from "./provider-settings";

  describe("provider settings helpers", () => {
    it("labels each stored credential independently", () => {
      expect(providerLabel("openrouter")).toBe("OpenRouter API Key");
      expect(providerLabel("opencode_zen")).toBe("OpenCode Zen API Key");
      expect(providerLabel("opencode_go")).toBe("OpenCode Go API Key");
    });

    it("does not claim success until the provider response is ok", () => {
      expect(providerTestState(undefined)).toEqual({ label: "Not tested", variant: "default" });
      expect(providerTestState({ ok: true, latency_ms: 18 })).toEqual({ label: "Connected · 18 ms", variant: "success" });
      expect(providerTestState({ ok: false, latency_ms: 0, error: "denied" })).toEqual({ label: "denied", variant: "error" });
    });
  });
  ```

- [ ] **Step 2: Run the focused Vitest file and confirm it fails.**

  Run:

  ```powershell
  Set-Location src-ui; bun test src/components/jarvis/provider-settings.test.ts
  ```

  Expected: FAIL because `provider-settings.ts` does not exist.

- [ ] **Step 3: Implement the UI helpers.**

  Create `provider-settings.ts`:

  ```ts
  export type CredentialProvider = "openrouter" | "opencode_zen" | "opencode_go";
  export type ProviderTestResult = { ok: boolean; latency_ms: number; error?: string };

  export function providerLabel(provider: CredentialProvider): string {
    return provider === "openrouter" ? "OpenRouter API Key"
      : provider === "opencode_zen" ? "OpenCode Zen API Key"
      : "OpenCode Go API Key";
  }

  export function providerTestState(result?: ProviderTestResult): { label: string; variant: "default" | "success" | "error" } {
    if (!result) return { label: "Not tested", variant: "default" };
    if (result.ok) return { label: `Connected · ${result.latency_ms} ms`, variant: "success" };
    return { label: result.error || "Connection failed", variant: "error" };
  }
  ```

- [ ] **Step 4: Replace the OpenRouter-only key card with three independent credential cards.**

  In `ConfigPanel`:

  1. Replace `showApiKey: boolean` with `visibleKeys: Record<CredentialProvider, boolean>` and `providerTests: Partial<Record<CredentialProvider, ProviderTestResult>>`.
  2. Render cards for `openrouter`, `opencode_zen`, and `opencode_go` unconditionally; OpenCode keys must remain configurable even when OpenRouter is not the selected direct inference backend.
  3. Bind OpenRouter to `localConfig.openrouter.api_key`, Zen to `localConfig.opencode_zen.api_key`, and Go to `localConfig.opencode_go.api_key`.
  4. Give every card a `Show`/`Hide` button whose accessible name contains the provider label, a `Test connection` button, and the `providerTestState` result. Disable only that card's button while its own test is running.
  5. On test, call:

     ```ts
     const result = await invoke<ProviderTestResult>("jarvis_test_provider", {
       provider,
       config: localConfig,
     });
     ```

     The current unsaved `localConfig` is deliberate: a user can prove a newly pasted key before saving it. Do not include the key in any thrown error, toast, or `console.error` statement.

- [ ] **Step 5: Add the orchestration runtime control.**

  Add a separate `GlassCard` before model selection:

  ```tsx
  <input
    id="orchestration-enabled"
    type="checkbox"
    checked={localConfig.orchestrator.enabled}
    onChange={(event) => updateField("orchestrator", {
      ...localConfig.orchestrator,
      enabled: event.target.checked,
    })}
  />
  <label htmlFor="orchestration-enabled">Enable orchestration runtime</label>
  <p>When disabled, new Session turns use the selected inference backend directly. Active turns are unchanged.</p>
  ```

  The control changes only local state until Save. Never treat `conductor.enabled` as the master control; it chooses the coordinator implementation inside an enabled orchestration runtime.

- [ ] **Step 6: Run UI unit tests and the production build.**

  Run:

  ```powershell
  Set-Location src-ui
  bun test src/components/jarvis/provider-settings.test.ts
  bun run build
  ```

  Expected: labels and status states pass; the UI builds without a TypeScript mismatch against `JarvisConfig`.

- [ ] **Step 7: Commit the settings UX slice.**

  ```powershell
  git add src-ui/src/components/jarvis/JarvisView.tsx src-ui/src/components/jarvis/provider-settings.ts src-ui/src/components/jarvis/provider-settings.test.ts
  git commit -m "feat: configure provider keys and orchestration in settings"
  ```

### Task 7: Verify the full native-to-runtime path and deliver the actual desktop runtime

**Files:**
- Create: none.
- Modify: none.
- Verify: `server-jarvis`, `src-ui`, `src-tauri`, `scripts/build-and-deploy.ps1`, deployed `Jarvis.exe`, deployed `index.js`.

**Consumes:** All prior completed tasks.

**Produces:** Evidence that the shipped desktop application saves, reloads, and uses the intended credential/configuration state.

- [ ] **Step 1: Run the complete automated suite from the dirty implementation tree.**

  Run:

  ```powershell
  Set-Location server-jarvis; bun test; bun run typecheck
  Set-Location ..\src-ui; bun test; bun run build
  Set-Location ..\src-tauri; CARGO_INCREMENTAL=0 cargo test --workspace
  ```

  Expected: all suites are green. Treat any unrelated-looking regression as a real release blocker until its cause is understood.

- [ ] **Step 2: Build and deploy the complete runtime triplet from the current working tree.**

  Run:

  ```powershell
  Set-Location C:\Projects\home-base-recovered
  powershell -ExecutionPolicy Bypass -File .\scripts\build-and-deploy.ps1 -RestartServer
  ```

  Expected: the script refreshes `Jarvis.exe`, `home-base.exe`, `index.js`, and `prompts/` together in `C:\Users\ethan\OneDrive\Desktop`; `/health` responds on `127.0.0.1:19877`.

- [ ] **Step 3: Prove the serving bundle is current before UI smoke testing.**

  Run:

  ```powershell
  $listener = Get-NetTCPConnection -LocalPort 19877 -State Listen | Select-Object -First 1
  Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" | Select-Object ProcessId, Name, CommandLine
  Invoke-RestMethod http://127.0.0.1:19877/health
  Invoke-RestMethod -Method Post http://127.0.0.1:19877/config/reload
  ```

  Expected: the process command line points to the freshly deployed `index.js` (or the current repo bundle in a development smoke), `/health.git_sha` matches the deployed build manifest, and `/config/reload` contains only redacted credential evidence.

- [ ] **Step 4: Perform the desktop smoke flow using real, user-supplied credentials.**

  1. Launch the deployed `Jarvis.exe`.
  2. Open Configuration and enter the new OpenRouter key; click Save and require `Runtime confirmed`.
  3. Click OpenRouter `Test connection`; require a provider-specific success or an actionable non-secret error.
  4. Independently enter/test OpenCode Zen and OpenCode Go keys. Confirm each result names its provider and the test for Go cannot change Zen's result.
  5. Turn orchestration off, save, start a new Session turn, and confirm it yields no `orchestrator_stage` SSE events.
  6. Turn orchestration on, save, start a new Session turn, and confirm the existing pipeline-stage indication returns.
  7. Restart Jarvis, reload Configuration, and confirm all three cards show configured state without revealing any key.

- [ ] **Step 5: Record only sanitized evidence and create the integration commit.**

  Include `/health` build provenance, boolean configured states, short fingerprints, test statuses, and the orchestration on/off behavior in the commit message or release note. Do not save full keys, copied config files, or screenshots that reveal a key.

  ```powershell
  git status --short
  git add src-tauri server-jarvis src-ui docs/superpowers/plans/2026-07-10-provider-credentials-orchestration-settings.md
  git commit -m "feat: complete provider credential runtime controls"
  ```

## Plan self-review

- **Spec coverage:** Task 1 fixes the missing Native-surface persistence, Task 2 proves the running Bun configuration, Task 3 tests OpenRouter/Zen/Go independently, Task 4 makes the orchestration boundary explicit, Task 5 exposes all controls in settings, and Task 7 validates the real deployed runtime.
- **No credential leakage:** Every planned server/UI response uses `configured`, status, or a 12-character SHA-256 fingerprint. No endpoint returns a `JarvisConfig` payload for the save/reload flow.
- **Migration safety:** Existing file-only OpenCode and orchestrator data is preserved by the Rust `#[serde(flatten)]` map and the existing deep projection, then becomes SQLite-backed the next time the config is saved.
- **Type consistency:** The provider identifiers are exactly `openrouter`, `opencode_zen`, and `opencode_go` in Bun endpoints, Tauri command forwarding, and UI state. The master toggle is exactly `orchestrator.enabled` throughout.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-provider-credentials-orchestration-settings.md`.

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task with review gates.
2. **Inline Execution** — execute the tasks in this session with checkpoints.
