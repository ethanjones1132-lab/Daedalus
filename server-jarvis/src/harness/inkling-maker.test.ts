import { describe, expect, test } from "bun:test";
import { runInklingMaker, type HarnessMakerEvent, type HarnessMakerTool } from "./inkling-maker";

const read = (path: unknown) => ({ action: "tool_call", tool: "read_file", arguments: { path } });
const finish = { action: "finish", summary: "Done" };

function fakeMaker(replies: unknown[], fails: string[] = []) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const events: HarnessMakerEvent[] = [];
  const requests: Array<Record<string, any>> = [];
  const tools: HarnessMakerTool[] = [["read_file", "path"], ["shell", "command"]].map(([name, arg]) => ({
    definition: {
      name: name!, description: `Run ${name}`,
      parameters: { type: "object", properties: { [arg!]: { type: "string", description: arg! } }, required: [arg!] },
    },
    execute: async (args) => {
      calls.push([name!, args]);
      return { ok: !fails.includes(String(args.path)), output: "fake tool result" };
    },
  }));
  const signal = new AbortController().signal;
  const run = (round = 1) => runInklingMaker({
    prompt: "Fix the scratch project", backend: { base_url: "http://127.0.0.1:8080/v1", model: "Inkling-2-Mini-UD-IQ3_XXS.gguf" },
    signal, round, tools,
    recordEvent: (event) => { events.push(event); },
    request: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      if (!replies.length) throw new Error("Unexpected model request");
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(replies.shift()) } }] });
    },
  });
  const refusals = () => events.filter((event) => event.event_type === "maker_tool_refused").map((event) => event.payload);
  return { run, calls, events, requests, refusals };
}

describe("Inkling maker tool loop", () => {
  test("refuses the previous call with identical arguments and reports it to the model", async () => {
    const maker = fakeMaker([read("a.ts"), read("a.ts"), finish]);
    expect(await maker.run()).toMatchObject({ ok: true });
    expect(maker.calls).toEqual([["read_file", { path: "a.ts" }]]);
    expect(maker.refusals()).toEqual([{ round: 1, tool: "read_file", reason: "repeated_call" }]);
    expect(JSON.stringify(maker.requests[2]?.messages)).toContain("repeated_call");
  });

  test("refuses a tool after two failures in the run, even across rounds", async () => {
    const maker = fakeMaker([read("a.ts"), finish, read("b.ts"), read("c.ts"), finish], ["a.ts", "b.ts"]);
    expect(await maker.run()).toMatchObject({ ok: true });
    expect(await maker.run(2)).toMatchObject({ ok: true });
    expect(maker.calls).toEqual([["read_file", { path: "a.ts" }], ["read_file", { path: "b.ts" }]]);
    expect(maker.refusals()).toEqual([{ round: 2, tool: "read_file", reason: "dead_tool" }]);
  });

  test("refuses no-op shell probes without blocking commands that do real work", async () => {
    const shell = (command: string) => ({ action: "tool_call", tool: "shell", arguments: { command } });
    const maker = fakeMaker([shell("true"), shell("/bin/true;"), shell("exit 0"), shell("bun test && true"), finish]);
    expect(await maker.run()).toMatchObject({ ok: true });
    expect(maker.calls).toEqual([["shell", { command: "bun test && true" }]]);
    expect(maker.refusals()).toEqual(Array.from({ length: 3 }, () => ({ round: 1, tool: "shell", reason: "no_op" })));
  });

  test("dispatches ordinary calls with schema-constrained replies and phase-specific budgets", async () => {
    const maker = fakeMaker([read("a.ts"), read("b.ts"), finish]);
    expect(await maker.run()).toMatchObject({ ok: true, narrative: "Done" });
    expect(maker.calls).toEqual([["read_file", { path: "a.ts" }], ["read_file", { path: "b.ts" }]]);
    expect(maker.refusals()).toEqual([]);
    expect(maker.requests.map(({ max_tokens }) => max_tokens)).toEqual([3072, 1024, 1024]);
    expect(maker.requests.map(({ reasoning_budget_tokens }) => reasoning_budget_tokens)).toEqual([2560, 768, 768]);
    expect(maker.requests.map(({ chat_template_kwargs }) => chat_template_kwargs.reasoning_effort)).toEqual(["medium", "low", "low"]);
    const format = maker.requests[0]?.response_format;
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.anyOf[1].properties).toMatchObject({
      tool: { const: "read_file" }, arguments: { required: ["path"], additionalProperties: false },
    });
  });

  test("rejects invalid argument shapes before dispatch if a backend violates the schema", async () => {
    const maker = fakeMaker([read(42), read("a.ts"), finish]);
    expect(await maker.run()).toMatchObject({ ok: true });
    expect(maker.calls).toEqual([["read_file", { path: "a.ts" }]]);
    expect(maker.events).toContainEqual(expect.objectContaining({ event_type: "maker_round", payload: expect.objectContaining({ tool_calls: 2, valid_tool_calls: 1 }) }));
  });
});
