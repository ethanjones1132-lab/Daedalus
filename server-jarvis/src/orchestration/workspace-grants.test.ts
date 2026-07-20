import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { extractRootGrants } from "./workspace-grants";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace root grants", () => {
  test("extracts absolute directories and maps file paths to their nearest existing directory", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-grants-"));
    roots.push(root);
    const nested = join(root, "nested folder");
    mkdirSync(nested);
    const file = join(nested, "source.ts");
    writeFileSync(file, "ok");

    expect(extractRootGrants(`Please inspect "${file}" and '${nested}'.`))
      .toEqual([resolve(nested)]);
  });

  test("walks a non-existent file path upward to the nearest existing directory", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-grants-parent-"));
    roots.push(root);
    const existing = join(root, "existing");
    mkdirSync(existing);

    expect(extractRootGrants(`Write ${join(existing, "future", "new.ts")}`))
      .toEqual([resolve(existing)]);
  });

  test("does not infer grants when the raw message contains no absolute path", () => {
    expect(extractRootGrants("The tool returned ../outside and src/index.ts; continue."))
      .toEqual([]);
  });
});
