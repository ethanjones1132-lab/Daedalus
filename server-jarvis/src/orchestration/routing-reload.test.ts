import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, normalizeConfig, saveConfig, type JarvisConfig } from "../config";
import { routingDescriptorFingerprint } from "./routing-descriptor";
import { reloadNativeRoutingConfig } from "./routing-reload";

const tempDirs: string[] = [];

function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-routing-reload-"));
  tempDirs.push(dir);
  return join(dir, "config.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Native-authorized routing reload", () => {
  test("reloads a SQLite-projected Automatic reset from disk without rewriting unknown fields", () => {
    const configFile = tempConfigPath();
    const initial = normalizeConfig({
      orchestrator: {
        stage_models: { executor: { provider: "ollama", model: "pinned/model:tag" } },
        fallback_chains: { executor: [{ provider: "ollama", model: "fallback/model" }] },
      },
      unknown_future_section: { nested: ["preserve", { value: 7 }] },
    } as Partial<JarvisConfig>);
    writeFileSync(configFile, JSON.stringify(initial), "utf8");

    saveConfig({ orchestrator: {
      stage_models: { executor: "automatic" },
      fallback_chains: { executor: "automatic" },
    } }, { configFile, currentConfig: initial });
    const projected = readFileSync(configFile, "utf8");
    const acknowledgement = reloadNativeRoutingConfig({ configFile, env: {} });
    const reloaded = loadConfig({ configFile });

    expect(reloaded.orchestrator.stage_models?.executor).toBe("automatic");
    expect(reloaded.orchestrator.fallback_chains?.executor).toBe("automatic");
    expect((reloaded as unknown as Record<string, unknown>).unknown_future_section)
      .toEqual({ nested: ["preserve", { value: 7 }] });
    expect(acknowledgement.routing_fingerprint).toBe(routingDescriptorFingerprint(reloaded, {}));
    expect(readFileSync(configFile, "utf8")).toBe(projected);
  });
});
