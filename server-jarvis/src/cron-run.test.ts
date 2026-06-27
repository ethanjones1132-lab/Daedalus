import { describe, expect, test } from "bun:test";
import { saveConfig, loadConfig, invalidateConfigCache } from "./config";

describe("cron + config server contracts", () => {
  test("saveConfig persists and reloads merged config", () => {
    invalidateConfigCache();
    const before = loadConfig();
    const saved = saveConfig({ system_prompt: `${before.system_prompt}\n# audit-test` });
    invalidateConfigCache();
    const reloaded = loadConfig();
    expect(reloaded.system_prompt).toContain("# audit-test");
    saveConfig({ system_prompt: before.system_prompt });
    invalidateConfigCache();
  });
});