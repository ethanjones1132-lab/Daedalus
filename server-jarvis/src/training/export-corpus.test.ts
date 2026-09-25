import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SelfTuningStore } from "../self-tuning/store";
import { main } from "./export-corpus";

async function withTempDir<T>(fn: (root: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "jarvis-corpus-cli-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("corpus export sidecar boundary", () => {
  test("invalid eval sidecar leaves an existing corpus untouched", async () => {
    await withTempDir(async (root) => {
      const sidecarPath = join(root, "eval.json");
      const outputPath = join(root, "corpus.jsonl");
      writeFileSync(outputPath, "existing corpus\n");
      writeFileSync(
        sidecarPath,
        JSON.stringify({ "run-valid": true, "run-invalid": "false" }),
      );

      let failure: unknown;
      try {
        await main(
          [`--eval-results=${sidecarPath}`, `--out=${outputPath}`],
          new SelfTuningStore(":memory:"),
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("eval results sidecar: invalid_value");
      expect(readFileSync(outputPath, "utf8")).toBe("existing corpus\n");
    });
  });

  test("invalid replan sidecar leaves an existing corpus untouched", async () => {
    await withTempDir(async (root) => {
      const sidecarPath = join(root, "replan.json");
      const outputPath = join(root, "corpus.jsonl");
      writeFileSync(outputPath, "existing corpus\n");
      writeFileSync(
        sidecarPath,
        JSON.stringify({ "run-valid": 1, "run-invalid": Number.POSITIVE_INFINITY }),
      );

      let failure: unknown;
      try {
        await main(
          [`--replan-counts=${sidecarPath}`, `--out=${outputPath}`],
          new SelfTuningStore(":memory:"),
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("replan counts sidecar: invalid_value");
      expect(readFileSync(outputPath, "utf8")).toBe("existing corpus\n");
    });
  });
});
