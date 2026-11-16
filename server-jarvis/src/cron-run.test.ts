import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InvalidConfigError, invalidateConfigCache, loadConfig, saveConfig } from "./config";

/**
 * DD-085: this contract must never read or write the owner's real Jarvis
 * config (`CONFIG_FILE` / `~/.openclaw/jarvis/config.json`). Every load and
 * save below goes through the explicit `configFile` seam into a per-test temp
 * directory, and the module-level cache is dropped afterwards so a temp-file
 * config cannot leak into other tests in this process.
 */
function withTempConfig(run: (configFile: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cron-run-config-"));
  const configFile = join(dir, "config.json");
  try {
    run(configFile);
  } finally {
    // Clearing the cache keeps the temp config out of default `loadConfig()`
    // calls elsewhere; it only drops memory, it never touches a config file.
    invalidateConfigCache();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

const OPENROUTER_KEY_ENV = ["OPENROUTER_API_KEY", "OPENROUTER_KEY"] as const;

/**
 * `normalizeConfig` hydrates an empty/short `openrouter.api_key` from the
 * environment, so the refusal case clears those names for its duration to keep
 * the strict-validation contract independent of the box's shell env.
 */
function withoutOpenRouterEnv(run: () => void): void {
  const saved = OPENROUTER_KEY_ENV.map((name) => [name, process.env[name]] as const);
  for (const name of OPENROUTER_KEY_ENV) delete process.env[name];
  try {
    run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("cron + config server contracts", () => {
  test("saveConfig persists and reloads merged config", () => {
    withTempConfig((configFile) => {
      // No file exists yet, so these are code defaults — not the owner's config.
      const before = loadConfig({ configFile });
      expect(existsSync(configFile)).toBe(false);

      const saved = saveConfig(
        { system_prompt: `${before.system_prompt}\n# audit-test` },
        { currentConfig: before, configFile },
      );
      expect(saved.system_prompt).toContain("# audit-test");

      const onDisk = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(onDisk.system_prompt).toContain("# audit-test");

      invalidateConfigCache();
      const reloaded = loadConfig({ configFile });
      expect(reloaded.system_prompt).toContain("# audit-test");

      saveConfig({ system_prompt: before.system_prompt }, { currentConfig: reloaded, configFile });
      invalidateConfigCache();
      const restored = loadConfig({ configFile });
      expect(restored.system_prompt).toBe(before.system_prompt);
    });
  });

  test("saveConfig still refuses an openrouter backend without an API key", () => {
    withoutOpenRouterEnv(() => {
      withTempConfig((configFile) => {
        const before = loadConfig({ configFile });

        let thrown: unknown;
        try {
          saveConfig(
            { active_backend: "openrouter", openrouter: { api_key: "" } } as any,
            { currentConfig: before, configFile },
          );
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(InvalidConfigError);
        const errors = (thrown as InvalidConfigError).validation.errors;
        expect(errors.some((error) => error.includes("OpenRouter API key"))).toBe(true);
        // A refused save persists nothing, not even to the temp file.
        expect(existsSync(configFile)).toBe(false);
      });
    });
  });
});
