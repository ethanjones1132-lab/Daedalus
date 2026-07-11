import { describe, test, expect, beforeEach } from "bun:test";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerMetaBundle } from "./meta-bundle";
import { registerFilesystemBundle } from "./filesystem-bundle";
import { TodoStore } from "./todo-store";
import { defaultConfig } from "./config";

function ctx(todoStore: TodoStore) {
  const cfg = defaultConfig();
  cfg.tools.enabled = true;
  return makeExecutionContext("chat", cfg);
}

function call(name: string, args: Record<string, unknown>) {
  return { id: `t-${name}`, name, arguments: args };
}

describe("meta bundle", () => {
  let store: TodoStore;

  beforeEach(() => {
    store = new TodoStore({ dbPath: ":memory:" });
    store.clear();
  });

  test("todo_write acknowledges the number of items", async () => {
    const rt = createToolRuntime();
    registerMetaBundle(rt, { todoStore: store });
    const result = await rt.execute(call("todo_write", { todos: [{}, {}] }), ctx(store));
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("2 items");
  });

  test("todo_write persists and todo_list returns the same item", async () => {
    const rt = createToolRuntime();
    registerMetaBundle(rt, { todoStore: store });
    const write = await rt.execute(
      call("todo_write", { todos: [{ id: "t1", text: "verify deploy" }] }),
      ctx(store),
    );
    expect(write.is_error).toBe(false);

    const list = await rt.execute(call("todo_list", {}), ctx(store));
    expect(list.is_error).toBe(false);
    expect(list.output).toContain("verify deploy");
    expect(list.output).toContain("t1");
  });

  test("todo_write updates an existing todo by id", async () => {
    const rt = createToolRuntime();
    registerMetaBundle(rt, { todoStore: store });
    await rt.execute(
      call("todo_write", { todos: [{ id: "t2", text: "first", status: "pending" }] }),
      ctx(store),
    );
    await rt.execute(
      call("todo_write", { todos: [{ id: "t2", text: "first", status: "done" }] }),
      ctx(store),
    );
    const list = await rt.execute(call("todo_list", {}), ctx(store));
    expect(list.output).toContain("[done]");
    expect(list.output).not.toContain("[pending]");
  });

  test("todo_list is scoped to the execution context session_id", async () => {
    const rt = createToolRuntime();
    registerMetaBundle(rt, { todoStore: store });
    const cfg = defaultConfig();
    cfg.tools.enabled = true;

    const ctxA = makeExecutionContext("chat", cfg, { session_id: "sess-a" });
    const ctxB = makeExecutionContext("chat", cfg, { session_id: "sess-b" });

    await rt.execute(call("todo_write", { todos: [{ id: "a1", text: "task A" }] }), ctxA);
    await rt.execute(call("todo_write", { todos: [{ id: "b1", text: "task B" }] }), ctxB);

    const listA = await rt.execute(call("todo_list", {}), ctxA);
    expect(listA.output).toContain("task A");
    expect(listA.output).not.toContain("task B");

    const listB = await rt.execute(call("todo_list", {}), ctxB);
    expect(listB.output).toContain("task B");
    expect(listB.output).not.toContain("task A");
  });

  test("tools_enum lists the tools registered in the runtime", async () => {
    const rt = createToolRuntime();
    registerFilesystemBundle(rt);
    registerMetaBundle(rt, { todoStore: store });
    const result = await rt.execute(call("tools_enum", {}), ctx(store));
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("read_file");
    expect(result.output).toContain("todo_write");
    expect(result.output).toContain("todo_list");
    expect(result.output).toContain("tools_enum");
  });
});
