import { describe, expect, test } from "bun:test";
import { DeadToolTracker } from "./dead-tool-suppression";

describe("DeadToolTracker", () => {
  test("suppresses a tool after 2 structural failures", () => {
    const t = new DeadToolTracker();
    expect(t.isSuppressed("glob")).toBe(false);
    t.record("glob", true, "Executable not found in $PATH: rg");
    expect(t.isSuppressed("glob")).toBe(false);
    t.record("glob", true, "Executable not found in $PATH: rg");
    expect(t.isSuppressed("glob")).toBe(true);
  });

  test("a success resets the structural-failure count", () => {
    const t = new DeadToolTracker();
    t.record("grep", true, "Executable not found in $PATH: rg");
    t.record("grep", false, "3 matches");
    t.record("grep", true, "Executable not found in $PATH: rg");
    expect(t.isSuppressed("grep")).toBe(false);
  });

  test("recoverable errors do not count toward suppression", () => {
    const t = new DeadToolTracker();
    t.record("read_file", true, "old_string not found");
    t.record("read_file", true, "File not found: x");
    expect(t.isSuppressed("read_file")).toBe(false);
  });

  test("redirect note names an alternative for a suppressed search tool", () => {
    const t = new DeadToolTracker();
    t.record("glob", true, "Executable not found in $PATH: rg");
    t.record("glob", true, "Executable not found in $PATH: rg");
    expect(t.redirectNote("glob")).toContain("list_directory");
  });
});
