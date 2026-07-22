import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fingerprintFile, fingerprintBytes, hasContentDelta } from "./content-fingerprint";

describe("content fingerprints", () => {
  test("hashes exact bytes and distinguishes a content change", () => {
    const before = fingerprintBytes("same\n", "proof.txt");
    const after = fingerprintBytes("changed\n", "proof.txt");

    expect(before.exists).toBe(true);
    expect(before.bytes).toBe(5);
    expect(before.sha256).not.toBe(after.sha256);
    expect(hasContentDelta([{ before, after, changed: before.sha256 !== after.sha256, path: "proof.txt", toolName: "write_file" }])).toBe(true);
  });

  test("fingerprintFile reports missing and present files", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-fingerprint-test-"));
    try {
      const path = join(root, "proof.txt");
      const missing = await fingerprintFile(path);
      writeFileSync(path, "proof\n");
      const present = await fingerprintFile(path);

      expect(missing.exists).toBe(false);
      expect(present.exists).toBe(true);
      expect(present.bytes).toBe(6);
      expect(present.sha256).toHaveLength(64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
