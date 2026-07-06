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

  test("evicts the oldest session affinity once maxSessions is exceeded", () => {
    // Regression guard: WorkspaceAffinityStore caps at `maxSessions` and
    // evicts the OLDEST entry (insertion-ordered) when a new one is inserted
    // past the cap. Re-resolving an existing session PROMOTES it to the back
    // of the eviction order (LRU-on-touch — see the doc comment on
    // WorkspaceAffinityStore). A future refactor that switched to
    // LRU-on-write or kept all sessions would change observable behavior
    // in production; pin both contracts here.
    const rootA = tempWorkspace();
    const rootB = tempWorkspace();
    const rootC = tempWorkspace();
    const store = new WorkspaceAffinityStore(2);

    store.resolve("session-A", `Use "${rootA}"`, [], "C:\\fallback");
    store.resolve("session-B", `Use "${rootB}"`, [], "C:\\fallback");
    store.resolve("session-C", `Use "${rootC}"`, [], "C:\\fallback");

    // At this point: cap=2, map = {session-B, session-C}; session-A was the
    // first-inserted and got evicted when session-C pushed the count past
    // the cap. Re-resolving session-A with an explicit path lands it back
    // in the map (and evicts the now-oldest entry, session-B).
    const freshA = tempWorkspace();
    expect(store.resolve("session-A", `Now use "${freshA}"`, [], "C:\\fallback")).toBe(freshA);

    // session-B was evicted to make room for the re-inserted session-A.
    // Re-resolving session-B with no explicit path and no history must
    // fall back to the fallback root.
    expect(store.resolve("session-B", "continue", [], "C:\\fallback")).toBe("C:\\fallback");
    // session-C is still in the cap.
    expect(store.resolve("session-C", "continue", [], "C:\\fallback")).toBe(rootC);
  });
});
