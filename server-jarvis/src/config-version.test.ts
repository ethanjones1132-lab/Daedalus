import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import jarvisPackage from "../package.json";
import { CONFIG_SCHEMA_VERSION, defaultConfig } from "./config";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}

describe("config schema marker", () => {
  test("is the app version, not a hand-typed literal", () => {
    // The marker is derived from package.json rather than written out, so
    // a config file always names the build that wrote it and the value can
    // never drift from the app version.
    expect(CONFIG_SCHEMA_VERSION).toBe(jarvisPackage.version);
    expect(defaultConfig().version).toBe(jarvisPackage.version);
  });

  test("the native side derives the same marker from the crate version", () => {
    // The Rust default used to be a hardcoded "3.1.0" while the Bun side
    // said "3.0.0" and the app was 1.0.0 - so the version a user's config
    // file ended up with depended on which side wrote last. The native
    // side now reads CARGO_PKG_VERSION.
    const types = readRepoFile("src-tauri/src/jarvis/types.rs");
    expect(types).toContain('env!("CARGO_PKG_VERSION")');
    expect(types).not.toMatch(/version:\s*"[0-9]+\.[0-9]+\.[0-9]+"/);
  });

  test("the crate version and the package version are the same version", () => {
    // The marker is derived on both sides from a different file, so this
    // is where the two can still diverge. The release build's version
    // check covers the same ground for every other declaration site.
    const cargo = readRepoFile("src-tauri/Cargo.toml");
    const packageVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
    expect(packageVersion).toBe(jarvisPackage.version);
  });
});
