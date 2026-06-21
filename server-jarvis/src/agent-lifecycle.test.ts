import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLifecycleService } from "./agent-lifecycle";

function makeAgentRoot(name: string) {
  const root = mkdtempSync(join(tmpdir(), `${name}-agents-`));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeSoul(root: string, slug: string, frontmatter: string, body = "# Instructions\n\nDo the thing.") {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "soul.md"), `---\n${frontmatter}\n---\n\n${body}`, "utf-8");
}

describe("agent lifecycle", () => {
  let fixture: ReturnType<typeof makeAgentRoot>;

  afterEach(() => {
    fixture?.cleanup();
  });

  test("scan discovers valid soul.md files and reports provenance metadata", () => {
    fixture = makeAgentRoot("valid");
    writeSoul(fixture.root, "coder", `slug: coder\nname: Coder\nversion: "1.0.0"\ntools:\n  - Bash\n  - Read\n`);

    const service = createLifecycleService(fixture.root);
    const result = service.scan();

    expect(result.agents_root).toBe(fixture.root);
    expect(result.scanned).toBe(1);
    expect(result.valid).toBe(1);
    expect(result.invalid).toBe(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      slug: "coder",
      status: "valid",
      source_path: join(fixture.root, "coder", "soul.md"),
      name: "Coder",
      version: "1.0.0",
      tools: ["Bash", "Read"],
    });
    expect(result.results[0].source_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("scan marks invalid soul.md files without crashing the runtime", () => {
    fixture = makeAgentRoot("invalid");
    writeSoul(fixture.root, "broken", `slug: broken\nname: Broken\nactive: true\n`);

    const service = createLifecycleService(fixture.root);
    const result = service.scan();

    expect(result.scanned).toBe(1);
    expect(result.valid).toBe(0);
    expect(result.invalid).toBe(1);
    expect(result.results[0]).toMatchObject({
      slug: "broken",
      status: "invalid",
    });
    expect(result.results[0].errors?.map((e) => e.code)).toContain("RUNTIME_STATE_FIELD");
  });

  test("scan reports slug collisions as invalid", () => {
    fixture = makeAgentRoot("collision");
    writeSoul(fixture.root, "alpha", `slug: shared\nname: Alpha\n`);
    writeSoul(fixture.root, "beta", `slug: shared\nname: Beta\n`);

    const service = createLifecycleService(fixture.root);
    const result = service.scan();

    expect(result.scanned).toBe(2);
    expect(result.valid).toBe(0);
    expect(result.invalid).toBe(2);
    expect(result.results.map((r) => r.status)).toEqual(["collision", "collision"]);
    expect(result.results.map((r) => r.slug)).toEqual(["shared", "shared"]);
  });

  test("activate delegates to a projection store when provided", () => {
    fixture = makeAgentRoot("activate");
    writeSoul(fixture.root, "coder", `slug: coder\nname: Coder\n`);
    const activated: string[] = [];
    const service = createLifecycleService(fixture.root, {
      activate(slug) {
        activated.push(slug);
        return slug === "coder";
      },
    });

    expect(service.activate("coder")).toBe(true);
    expect(activated).toEqual(["coder"]);
  });
});
