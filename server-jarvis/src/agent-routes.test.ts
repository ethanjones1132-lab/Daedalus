import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLifecycleService, type ProjectionStore } from "./agent-lifecycle";
import {
  handleActivateAgent,
  handleAgentRequest,
  handleDeactivateAgent,
  handleGetAgent,
  handleListAgents,
  handleScanAgents,
} from "./agent-routes";

function makeAgentRoot(name: string) {
  const root = mkdtempSync(join(tmpdir(), `${name}-agents-`));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeSoul(root: string, slug: string, frontmatter: string) {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "soul.md"), `---\n${frontmatter}\n---\n\n# Instructions\n\nDo the thing.`, "utf-8");
}

describe("agent routes", () => {
  let fixture: ReturnType<typeof makeAgentRoot>;

  afterEach(() => {
    fixture?.cleanup();
  });

  test("list, get, activate, scan, and deactivate use lifecycle scan results", () => {
    fixture = makeAgentRoot("routes");
    writeSoul(fixture.root, "coder", `slug: coder\nname: Coder\n`);
    const lifecycle = createLifecycleService(fixture.root, {
      activate(slug) {
        return slug === "coder";
      },
      deactivate() {
        return true;
      },
    });

    expect(handleListAgents(lifecycle)).toMatchObject([
      { id: "coder", slug: "coder", status: "valid", active: false },
    ]);
    expect(handleGetAgent(lifecycle, "coder")).toMatchObject({
      id: "coder",
      slug: "coder",
      found: true,
      status: "valid",
      name: "Coder",
    });
    expect(handleGetAgent(lifecycle, "missing")).toMatchObject({
      id: "missing",
      found: false,
    });
    expect(handleActivateAgent(lifecycle, "coder")).toMatchObject({
      success: true,
      code: "activated",
      message: "Agent coder activated",
    });
    expect(handleScanAgents(lifecycle)).toEqual({ scanned: 1, valid: 1, invalid: 0 });
    expect(handleDeactivateAgent(lifecycle, "coder")).toMatchObject({
      success: true,
      code: "deactivated",
      message: "Agent coder deactivated",
    });
  });

  test("handleAgentRequest routes GET /agents through the mounted handler", async () => {
    fixture = makeAgentRoot("http");
    writeSoul(fixture.root, "coder", `slug: coder\nname: Coder\n`);
    const lifecycle = createLifecycleService(fixture.root);

    const response = await handleAgentRequest(
      new Request("http://local/agents", { method: "GET" }),
      lifecycle
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject([
      { id: "coder", slug: "coder", status: "valid", active: false },
    ]);
  });

  test("handleAgentRequest returns null for non-agent paths", async () => {
    fixture = makeAgentRoot("fallback");
    const lifecycle = createLifecycleService(fixture.root);
    const response = await handleAgentRequest(
      new Request("http://local/skills", { method: "GET" }),
      lifecycle
    );
    expect(response).toBeNull();
  });

  test("activation requires the displayed source hash and returns the persisted projection", async () => {
    fixture = makeAgentRoot("activation-route");
    writeSoul(fixture.root, "coder", `slug: coder\nname: Coder\n`);
    const lifecycle = createLifecycleService(fixture.root, {
      activate: (slug, entry) => ({ active: true, slug, source_hash: entry?.source_hash }),
      deactivate: () => ({ active: false }),
    } as unknown as ProjectionStore);
    const currentHash = lifecycle.scan().results[0].source_hash!;

    const stale = await handleAgentRequest(
      new Request("http://local/agents/coder/activate", {
        method: "POST",
        body: JSON.stringify({ expected_source_hash: "b".repeat(64) }),
        headers: { "content-type": "application/json" },
      }),
      lifecycle,
    );
    expect(stale?.status).toBe(409);
    expect(await stale?.json()).toMatchObject({ success: false, code: "source_changed" });

    const response = await handleAgentRequest(
      new Request("http://local/agents/coder/activate", {
        method: "POST",
        body: JSON.stringify({ expected_source_hash: currentHash }),
        headers: { "content-type": "application/json" },
      }),
      lifecycle,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ success: true, projection: { active: true } });
  });

  test("deactivation is routed through the lifecycle store and remains idempotent", async () => {
    fixture = makeAgentRoot("deactivation-route");
    const calls: string[] = [];
    const lifecycle = createLifecycleService(fixture.root, {
      activate: () => true,
      deactivate: (slug: string) => {
        calls.push(slug);
        return { active: false };
      },
    } as unknown as ProjectionStore);

    const first = await handleAgentRequest(
      new Request("http://local/agents/missing/deactivate", { method: "POST" }),
      lifecycle,
    );
    const second = await handleAgentRequest(
      new Request("http://local/agents/missing/deactivate", { method: "POST" }),
      lifecycle,
    );
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(calls).toEqual(["missing", "missing"]);
  });

  test("does not interpret the pool namespace as an Agent id", async () => {
    fixture = makeAgentRoot("pool-route");
    const lifecycle = createLifecycleService(fixture.root);
    const response = await handleAgentRequest(
      new Request("http://local/agents/pool", { method: "GET" }),
      lifecycle,
    );
    expect(response).toBeNull();
  });
});
