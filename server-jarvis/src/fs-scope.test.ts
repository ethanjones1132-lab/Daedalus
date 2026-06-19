import { describe, test, expect } from "bun:test";
import { toWslPath, safePath } from "./fs-scope";
import type { JarvisConfig } from "./config";

const cfg = {
  jarvis_path: "/home/ethan/ws",
  tools: { sandbox_mode: "workspace" },
} as unknown as JarvisConfig;

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

  test("safePath rejects an escape outside the workspace", () => {
    expect(() => safePath("../../etc/passwd", cfg)).toThrow(/outside the workspace/);
  });

  test("safePath resolves a relative path inside the workspace", () => {
    expect(safePath("src/index.ts", cfg)).toBe("/home/ethan/ws/src/index.ts");
  });

  test("safePath with sandbox off returns the absolute path", () => {
    const off = { ...cfg, tools: { sandbox_mode: "off" } } as unknown as JarvisConfig;
    expect(safePath("/etc/hosts", off)).toBe("/etc/hosts");
  });
});
