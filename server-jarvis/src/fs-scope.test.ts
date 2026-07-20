import { afterEach, describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, join, resolve } from "path";
import { expandHomePath, resolveAllowedRoots, toWslPath, safePath } from "./fs-scope";
import type { JarvisConfig } from "./config";

const tempRoots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `jarvis-${label}-`));
  tempRoots.push(root);
  return root;
}

function config(root: string, mode: "strict" | "permissive" | "off" = "strict"): JarvisConfig {
  return {
    jarvis_path: root,
    tools: { sandbox_mode: mode, allowed_roots: [], grant_session_roots: true },
  } as unknown as JarvisConfig;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fs-scope", () => {
  test("toWslPath converts a Windows drive path", () => {
    expect(toWslPath("C:/Users/ethan/x")).toBe("/mnt/c/Users/ethan/x");
  });

  test("toWslPath converts a backslash drive path", () => {
    expect(toWslPath("C:\\Users\\ethan\\x")).toBe("/mnt/c/Users/ethan/x");
  });

  test("toWslPath converts a \\\\wsl.localhost UNC path", () => {
    expect(toWslPath("\\\\wsl.localhost\\Ubuntu\\home\\ethan")).toBe("/home/ethan");
  });

  test("toWslPath passes a POSIX path through unchanged", () => {
    expect(toWslPath("/home/ethan/file.ts")).toBe("/home/ethan/file.ts");
  });

  test("expandHomePath expands the home token before path resolution", () => {
    expect(expandHomePath("~")).toBe(homedir());
    expect(expandHomePath("~/project")).toBe(join(homedir(), "project"));
    expect(expandHomePath("~\\project")).toBe(join(homedir(), "project"));
  });

  test("resolveAllowedRoots preserves deterministic order and deduplicates existing roots", () => {
    const workspaceOverride = tempRoot("override");
    const configured = tempRoot("configured");
    const granted = tempRoot("granted");
    const persistent = tempRoot("persistent");
    const cfg = config(configured);
    cfg.tools.allowed_roots = [persistent, configured, join(configured, "missing")];

    expect(resolveAllowedRoots(cfg, {
      workspaceOverride,
      sessionGrants: [granted, persistent, granted],
    })).toEqual([resolve(workspaceOverride), resolve(configured), resolve(granted), resolve(persistent)]);
  });

  test("safePath rejects an escape outside the workspace", () => {
    const cfg = config(tempRoot("escape"));
    expect(() => safePath("../../etc/passwd", cfg)).toThrow(/outside the workspace/);
  });

  // Note: these assert host-agnostically because the test runner may execute on
  // Windows (win32 path semantics) while production runs in WSL (posix). The
  // meaningful invariant is the resolved suffix, not the separator style.
  test("safePath resolves a relative path inside the workspace", () => {
    const root = tempRoot("relative");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "ok");
    const cfg = config(root);
    const r = safePath("src/index.ts", cfg).replace(/\\/g, "/");
    expect(r).toBe(resolve(root, "src/index.ts").replace(/\\/g, "/"));
  });

  test("safePath prefers an invocation workspace override over config.jarvis_path", () => {
    const configured = tempRoot("cfg");
    const workspaceOverride = tempRoot("turn");
    mkdirSync(join(workspaceOverride, "src"));
    writeFileSync(join(workspaceOverride, "src", "index.ts"), "ok");
    const r = safePath("src/index.ts", config(configured), workspaceOverride).replace(/\\/g, "/");
    expect(r).toBe(resolve(workspaceOverride, "src/index.ts").replace(/\\/g, "/"));
  });

  test("safePath chooses the first allowed root containing an existing relative read", () => {
    const workspace = tempRoot("read-workspace");
    const grant = tempRoot("read-grant");
    mkdirSync(join(grant, "src"));
    writeFileSync(join(grant, "src", "granted.ts"), "ok");

    expect(safePath("src/granted.ts", config(workspace), { sessionGrants: [grant] }))
      .toBe(resolve(grant, "src/granted.ts"));
  });

  test("safePath chooses the first allowed root whose candidate parent exists for writes", () => {
    const workspace = tempRoot("write-workspace");
    const grant = tempRoot("write-grant");
    mkdirSync(join(grant, "generated"));

    expect(safePath("generated/new.ts", config(workspace), { sessionGrants: [grant], forWrite: true }))
      .toBe(resolve(grant, "generated/new.ts"));
  });

  test("safePath deduplicates a repeated root basename only when that candidate exists", () => {
    const root = tempRoot("segment");
    writeFileSync(join(root, "README.md"), "ok");
    const repeated = `${basename(root)}/README.md`;
    expect(safePath(repeated, config(root))).toBe(resolve(root, "README.md"));
    expect(safePath(`${basename(root)}/missing.md`, config(root))).toBe(resolve(root, basename(root), "missing.md"));
  });

  test("safePath falls back to the first allowed root for a new path", () => {
    const workspace = tempRoot("fallback-workspace");
    const grant = tempRoot("fallback-grant");
    expect(safePath("unknown/new.ts", config(workspace), { sessionGrants: [grant] }))
      .toBe(resolve(workspace, "unknown/new.ts"));
  });

  test("safePath accepts absolute paths only inside an allowed root", () => {
    const workspace = tempRoot("absolute-workspace");
    const grant = tempRoot("absolute-grant");
    const outside = tempRoot("absolute-outside");
    const grantedFile = join(grant, "file.ts");
    writeFileSync(grantedFile, "ok");
    const cfg = config(workspace);

    expect(safePath(grantedFile, cfg, { sessionGrants: [grant] })).toBe(resolve(grantedFile));
    expect(() => safePath(join(outside, "file.ts"), cfg, { sessionGrants: [grant] }))
      .toThrow(new RegExp(`outside the workspace.*${basename(grant)}`, "s"));
  });

  test("safePath in permissive mode ALLOWS a path outside the workspace", () => {
    // permissive must be more lenient than strict: an out-of-workspace path is
    // returned (resolved), not rejected. Mirrors agent-tools.ts behavior.
    const perm = config(tempRoot("permissive"), "permissive");
    const r = safePath("../../etc/passwd", perm).replace(/\\/g, "/");
    expect(r.endsWith("etc/passwd")).toBe(true);
  });

  test("safePath with sandbox off returns the resolved absolute path", () => {
    const off = config(tempRoot("off"), "off");
    const r = safePath("/etc/hosts", off).replace(/\\/g, "/");
    expect(r.endsWith("etc/hosts")).toBe(true);
  });
});
