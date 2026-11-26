import { expect, test } from "bun:test";
import type { HarnessScriptApi } from "./script-api";
import { runScript } from "./sandbox";

const unused = (): never => { throw new Error("unexpected harness API call"); };
const api: HarnessScriptApi = {
  list: () => [], describe: () => null, state: unused, attach: unused, switch: unused, spawn: unused, request: unused,
};

test("script sees only the harness capability and normal JavaScript builtins", async () => {
  expect(await runScript(`
    const unavailable = [typeof require, typeof process, typeof fetch, typeof Bun, typeof WebSocket, typeof Deno];
    return { unavailable, catalogue: harness.list() };
  `, api)).toEqual({ ok: true, value: { unavailable: Array(6).fill("undefined"), catalogue: [] } });
});

test("an infinite loop is killed at the CPU cap", async () => {
  const result = await runScript("while (true) {}", api, { cpu_ms: 30 });
  expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/CPU.*cap.*30/) });
  expect(await runScript("harness.list().length", api)).toEqual({ ok: true, value: 0 });
});

test("unbounded allocation hits the memory cap before the CPU cap", async () => {
  const result = await runScript(`
    const growth = [];
    while (true) growth.push({ value: 123 });
  `, api, { cpu_ms: 1_000, mem_mb: 2 });
  expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/memory.*cap.*2/i) });
  expect(await runScript("return 7;", api)).toEqual({ ok: true, value: 7 });
});

test("the watchdog returns control when allocation stalls inside WASM", async () => {
  const result = await runScript(`
    const growth = [];
    while (true) growth.push(new Array(16_384).fill(123));
  `, api, { cpu_ms: 100, mem_mb: 2 });
  expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/memory.*cap.*2/i) });
  expect(await runScript("return 7;", api)).toEqual({ ok: true, value: 7 });
}, 4_000);

test("TypeScript runs with fresh globals on every invocation", async () => {
  expect(await runScript(`
    (globalThis as Record<string, unknown>).previous = 1;
    const count: number = 2;
    return count + 3;
  `, api)).toEqual({ ok: true, value: 5 });
  expect(await runScript("typeof globalThis.previous", api)).toEqual({ ok: true, value: "undefined" });
});
