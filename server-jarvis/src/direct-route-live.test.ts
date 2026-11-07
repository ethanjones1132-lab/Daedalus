import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Real owned Bun children, with a deterministic loopback HTTP fixture in place
// of a model. This proves dispatch/attribution, not model quality or latency.
const alias = "direct-route-live-fixture";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("isolated real Bun turns disclose Direct success/failure/cancellation and Orchestrated answers", async () => {
  let behavior = "success";
  let requests = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) {
      return Response.json({ data: [{ id: alias }] });
    }
    if (req.method !== "POST") return Response.json({ status: "ok" });
    const body = await req.json() as { model: string };
    expect(body.model).toBe(alias);
    requests++;
    if (behavior === "failure") return new Response("controlled fixture failure", { status: 500 });
    if (behavior === "stall") {
      await new Promise<void>((done) => {
        if (req.signal.aborted) done();
        else req.signal.addEventListener("abort", () => done(), { once: true });
      });
      return new Response(null, { status: 499 });
    }
    return new Response([
      { model: alias, choices: [{ delta: { content: "42" }, finish_reason: null }] },
      { model: alias, choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    for (const orchestrated of [false, true]) {
      behavior = "success";
      const requestsBeforeStartup = requests;
      const home = mkdtempSync(join(tmpdir(), "jarvis-direct-route-live-"));
      const configDir = join(home, ".openclaw", "jarvis");
      mkdirSync(configDir, { recursive: true });
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = probe.port!;
      probe.stop(true);
      writeFileSync(join(configDir, "config.json"), JSON.stringify({
        active_backend: "llama_cpp", jarvis_path: home,
        llama_cpp: { base_url: `http://127.0.0.1:${model.port}/v1`, model: alias },
        claude_cli: { enabled: false }, tools: { enabled: false },
        orchestrator: { enabled: orchestrated, allow_cloud_helpers: false, agents: [],
          conductor: { enabled: true, keep_warm: false, kv_backend: "llama_cpp",
            base_url: `http://127.0.0.1:${model.port}/v1`, model: alias,
            persist_sessions: false, kv_persist: false },
          conductor_learning: { enabled: false, trajectory_export: false },
          skill_distillation: { enabled: false }, session_memory: { enabled: false } },
      }));
      const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "index.ts")], {
        cwd: resolve(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
          HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
          LOCALAPPDATA: join(home, "AppData", "Local"), TEMP: home, TMP: home,
          JARVIS_SERVER_PORT: String(port), JARVIS_SERVER_HOST: "127.0.0.1" },
      });
      const output = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      const base = `http://127.0.0.1:${port}`;
      try {
        let ready = false;
        for (let tries = 0; tries < 120; tries++) {
          if (child.exitCode !== null) throw new Error(`owned Bun exited: ${await errors}`);
          try {
            const health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).json() as any;
            expect(health.bind_host).toBe("127.0.0.1");
            ready = health.ok === true;
            if (ready) break;
          } catch { /* startup only */ }
          await pause(50);
        }
        expect(ready).toBe(true);
        const config = await (await fetch(`${base}/config`)).json() as any;
        expect(config.orchestrator.enabled).toBe(orchestrated);
        expect(config.llama_cpp.model).toBe(alias);
        await pause(100);
        expect(requests).toBe(requestsBeforeStartup);
        const start = (session: string) => fetch(`${base}/chat/stream`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Hi", session_id: session, history: [],
            config: { ...config, max_tokens: 16, temperature: 0, top_p: 1 } }), signal: AbortSignal.timeout(12_000),
        });
        const frames = async (response: Response) => (await response.text()).split("\n")
          .filter((line) => line.startsWith("data: {"))
          .map((line) => JSON.parse(line.slice(6)));
        const success = await frames(await start(crypto.randomUUID()));
        const terminal = success.find((frame) => frame.type === "result");
        expect(terminal?.subtype).toBe("success");
        expect(terminal?.route?.answered_by).toMatchObject({ provider: "llama_cpp", model: alias });
        expect(terminal?.route?.left_machine).toBe(false);
        expect(terminal?.route?.attempts.length).toBeGreaterThan(0);
        if (orchestrated) continue;

        behavior = "failure";
        const failure = await frames(await start(crypto.randomUUID()));
        const failed = failure.find((frame) => frame.type === "error");
        expect(failed?.route?.attempts).toEqual(expect.arrayContaining([
          expect.objectContaining({ provider: "llama_cpp", model: alias, outcome: "http_error", answered: false }),
        ]));
        expect(failed?.route?.answered_by).toBeUndefined();

        behavior = "stall";
        const session = crypto.randomUUID();
        const before = requests;
        const response = start(session);
        for (let tries = 0; requests === before && tries < 100; tries++) await pause(20);
        expect(requests).toBeGreaterThan(before);
        await fetch(`${base}/chat/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session }) });
        const cancelled = (await frames(await response)).find((frame) => frame.type === "cancelled");
        expect(cancelled?.route?.attempts).toEqual(expect.arrayContaining([
          expect.objectContaining({ provider: "llama_cpp", model: alias, answered: false }),
        ]));
        expect(cancelled?.route?.answered_by).toBeUndefined();
      } finally {
        child.kill();
        await child.exited;
        await Promise.all([output, errors]);
        // Only the unique test-owned directory can be recursively removed.
        if (dirname(resolve(home)) !== resolve(tmpdir()) || !basename(home).startsWith("jarvis-direct-route-live-")) throw new Error("unexpected test directory");
        rmSync(home, { recursive: true, force: true });
      }
    }
  } finally { model.stop(true); }
}, 60_000);
