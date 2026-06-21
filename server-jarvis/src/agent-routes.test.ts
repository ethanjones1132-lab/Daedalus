import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLifecycleService } from "./agent-lifecycle";
import {
  handleActivateAgent,
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
    });

    expect(handleListAgents(lifecycle)).toEqual([
      { id: "coder", slug: "coder", status: "valid" },
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
    expect(handleActivateAgent(lifecycle, "coder")).toEqual({
      success: true,
      message: "Agent coder activated",
    });
    expect(handleScanAgents(lifecycle)).toEqual({ scanned: 1, valid: 1, invalid: 0 });
    expect(handleDeactivateAgent(lifecycle, "coder")).toEqual({
      success: true,
      message: "Agent coder deactivated",
    });
  });
});
