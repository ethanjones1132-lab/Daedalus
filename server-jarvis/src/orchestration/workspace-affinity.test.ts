import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorkspaceAffinityStore, findExistingWorkspacePath } from "./workspace-affinity";

const created: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-workspace-affinity-"));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("workspace affinity", () => {
  test("selects an explicitly named existing directory", () => {
    const root = tempWorkspace();
    expect(findExistingWorkspacePath(`Work in "${root}"`)).toBe(root);
  });

  test("uses the containing directory when the user names a file", () => {
    const root = tempWorkspace();
    const nested = join(root, "src");
    const file = join(nested, "app.ts");
    mkdirSync(nested);
    writeFileSync(file, "export {};\n");
    expect(findExistingWorkspacePath(`Read "${file}"`)).toBe(nested);
  });

  test("retains a selected workspace for continuation turns", () => {
    const root = tempWorkspace();
    const store = new WorkspaceAffinityStore();

    expect(store.resolve("session-1", `Use "${root}"`, [], "C:\\fallback")).toBe(root);
    expect(store.resolve("session-1", "continue please", [], "C:\\fallback")).toBe(root);
  });

  test("recovers workspace affinity from recent user history", () => {
    const root = tempWorkspace();
    const store = new WorkspaceAffinityStore();
    const history = [
      { role: "user", content: `The project is "${root}"` },
      { role: "assistant", content: "Understood." },
    ];

    expect(store.resolve("restored", "continue", history, "C:\\fallback")).toBe(root);
  });

  test("clear removes session affinity", () => {
    const root = tempWorkspace();
    const store = new WorkspaceAffinityStore();
    store.resolve("session-1", `Use "${root}"`, [], "C:\\fallback");
    store.clear("session-1");

    expect(store.resolve("session-1", "continue", [], "C:\\fallback")).toBe("C:\\fallback");
  });
});
