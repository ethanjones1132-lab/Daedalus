import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { WriteEffectObservation } from "./content-fingerprint";
import { buildLiveRunRewardSnapshot } from "./live-reward-evidence";

function effect(path: string, changed: boolean): WriteEffectObservation {
  return {
    toolName: "edit_file",
    path,
    before: { path, exists: true, bytes: 3, sha256: "a".repeat(64) },
    after: {
      path,
      exists: true,
      bytes: 3,
      sha256: changed ? "b".repeat(64) : "a".repeat(64),
    },
    changed,
  };
}

describe("live reward evidence", () => {
  test("credits only changed fingerprint paths", () => {
    const snapshot = buildLiveRunRewardSnapshot({
      writeRequired: true,
      effects: [effect("src/changed.ts", true), effect("src/same.ts", false)],
      check: { tier: "existing", ran: true, passed: true },
    });
    expect(snapshot.writeEvidenceSource).toBe("fingerprints");
    expect(snapshot.changedPaths).toEqual(["src/changed.ts"]);
  });

  test("an observed empty ledger remains empty", () => {
    const snapshot = buildLiveRunRewardSnapshot({
      writeRequired: true,
      effects: [],
      check: { tier: "existing", ran: true, passed: true },
    });
    expect(snapshot.writeEvidenceSource).toBe("fingerprints");
    expect(snapshot.changedPaths).toEqual([]);
  });

  test("index uses the fingerprint-only live boundary", () => {
    const source = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
    expect(source).toContain("buildLiveRunRewardSnapshot({");
    expect(source).not.toContain("buildStoredRunRewardSnapshot({");
  });
});
