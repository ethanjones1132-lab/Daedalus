// DD-083: the child must record its own clock before its import graph runs.
//
// ESM hoists static imports, so the earliest code a child can run is the body
// of its entrypoint's first import, and only if that module imports nothing
// itself. These tests pin both halves of that contract: ./startup-mark emits
// the line when it is evaluated, and index.ts keeps it as the first import,
// ahead of every module that touches disk, config or the network.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// The shape scripts/probe-cold-start.ps1 and the existing startup-log readers
// work with: the `[Jarvis startup]` prefix plus key=value fields.
const PRE_IMPORT_LINE =
  /^\[Jarvis startup\] pre-import uptime=\d+(?:\.\d+)?s timeOrigin=\d+(?:\.\d+)?$/;

describe("pre-import startup mark", () => {
  test("emits the pre-import line when the module is evaluated", async () => {
    const captured: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      // Dynamic so the sink is captured before the module body runs.
      await import("./startup-mark");
    } finally {
      console.log = originalLog;
    }

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0]).toMatch(PRE_IMPORT_LINE);
  });

  test("imports nothing, so no other module body can run before the line", () => {
    const source = readFileSync(join(import.meta.dir, "startup-mark.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).toMatch(/^console\.log\(/m);
  });

  test("index.ts imports it before any other module", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const imports = [...source.matchAll(/^\s*import\s.*$/gm)].map((match) => match[0].trim());

    expect(imports[0]).toBe('import "./startup-mark";');

    // The post-import mark the probe subtracts against must stay, and the
    // pre-import line must not be duplicated into the entrypoint itself (where
    // it would run after the import graph).
    expect(source).toContain("[Jarvis startup] process entry uptime=");
    expect(source).not.toContain("[Jarvis startup] pre-import");
  });
});
