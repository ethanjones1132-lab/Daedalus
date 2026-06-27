import { describe, expect, test } from "bun:test";
import { classifyToolError, healingHint, augmentErrorOutput } from "./tool-heal";

describe("classifyToolError", () => {
  test("detects file-not-found", () => {
    expect(classifyToolError("File not found: /tmp/x.ts")).toBe("not_found");
    expect(classifyToolError("Error: no such file or directory")).toBe("not_found");
  });
  test("detects not-read-yet (edit guard)", () => {
    expect(classifyToolError('Error: File "a.ts" has not been read yet in this conversation.')).toBe("not_read");
  });
  test("detects permission", () => {
    expect(classifyToolError("EACCES: permission denied, open '/etc/x'")).toBe("permission");
  });
  test("detects timeout", () => {
    expect(classifyToolError("operation timed out after 60s")).toBe("timeout");
  });
  test("detects parse errors", () => {
    expect(classifyToolError("Unexpected token } in JSON at position 4")).toBe("parse");
  });
  test("falls back to unknown", () => {
    expect(classifyToolError("the model said something weird")).toBe("unknown");
  });
  test("classifies a directory misuse and hints list_directory", () => {
    const output = `Error: "src" is a directory, not a file. Use list_directory to see its contents.`;
    expect(classifyToolError(output)).toBe("is_directory");
    const hint = healingHint("is_directory", 1);
    expect(hint).toContain("list_directory");
  });
});

describe("healingHint", () => {
  test("gives a targeted hint for known categories", () => {
    expect(healingHint("not_found", 1).toLowerCase()).toContain("glob");
    expect(healingHint("not_read", 1).toLowerCase()).toContain("read_file");
    expect(healingHint("unknown", 1)).toBe("");
  });
  test("escalates after repeated attempts", () => {
    const repeated = healingHint("not_found", 2).toLowerCase();
    expect(repeated).toContain("different");
  });
});

describe("augmentErrorOutput", () => {
  test("appends a Hint line for a known category", () => {
    const out = augmentErrorOutput("File not found: x.ts", 1);
    expect(out).toContain("File not found");
    expect(out).toContain("\nHint:");
  });
  test("does not double-append when a Hint already exists", () => {
    const withHint = "File not found: x.ts\nHint: already here";
    expect(augmentErrorOutput(withHint, 1)).toBe(withHint);
  });
  test("leaves unknown errors unchanged", () => {
    expect(augmentErrorOutput("weird error", 1)).toBe("weird error");
  });
});
