import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

/**
 * Phase-D fixture loading, bridged from the tier-2B Python suite.
 *
 * The task definitions live in `scripts/benchmark-tier2b/tasks.py` and are
 * consumed by both the Python benchmark harness and (here) the TypeScript
 * rollout runner. They are read via a one-shot Python dump rather than being
 * transcribed into TS, because two hand-maintained copies of 30-50 fixtures
 * would drift — and a drifted held-out split silently invalidates the entire
 * train/test separation the optimizer depends on.
 */

export type FixtureCategory = "A" | "B" | "C" | "D" | "E";

export interface FixtureTask {
  name: string;
  category: FixtureCategory;
  /** The one file the agent is expected to edit. */
  entry: string;
  /** Seed files, relative path -> contents. May include subdirectories. */
  files: Record<string, string>;
  spec: string;
  /** Graded test source. Written to `_t.py` at the workspace root. */
  test: string;
  /** Category B: seeded but off-limits to the agent. */
  hiddenFile?: string;
}

interface RawDump {
  tasks: Array<{
    name: string;
    category: FixtureCategory;
    entry: string;
    files: Record<string, string>;
    spec: string;
    test: string;
    hidden_file?: string;
  }>;
  held_out: string[];
  k: number;
}

function benchmarkDir(): string {
  // src/self-tuning/rollout -> repo root -> scripts/benchmark-tier2b
  return resolve(import.meta.dir, "..", "..", "..", "..", "scripts", "benchmark-tier2b");
}

/**
 * Dump `TASKS` / `HELD_OUT_NAMES` / `K` as JSON via the Python source of truth.
 * Synchronous and done once at module load — the fixture set is static for a
 * whole campaign, so there is nothing to gain from re-reading it per rollout.
 */
function loadDump(): RawDump {
  const script = [
    "import json, sys",
    "sys.path.insert(0, '.')",
    "from tasks import TASKS, K",
    "from held_out import HELD_OUT_NAMES",
    "print(json.dumps({",
    "  'tasks': TASKS,",
    "  'held_out': sorted(HELD_OUT_NAMES),",
    "  'k': K,",
    "}))",
  ].join("\n");
  const stdout = execFileSync("python", ["-c", script], {
    cwd: benchmarkDir(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout) as RawDump;
}

function normalize(raw: RawDump["tasks"][number]): FixtureTask {
  return {
    name: raw.name,
    category: raw.category,
    entry: raw.entry,
    files: raw.files,
    spec: raw.spec,
    test: raw.test,
    ...(raw.hidden_file ? { hiddenFile: raw.hidden_file } : {}),
  };
}

const dump = loadDump();
const heldOutNames = new Set(dump.held_out);
const allTasks: readonly FixtureTask[] = dump.tasks.map(normalize);

/**
 * Fixtures the optimizer may train on.
 *
 * The train/held-out separation is enforced structurally, not by convention:
 * these are two distinct exports, and the CMA-ES fitness function's only
 * caller passes `TRAINING_TASKS`. `HELD_OUT_TASKS` is reachable solely from
 * the held-out scorer, which runs once after the optimizer loop terminates.
 * There is no code path by which a held-out fixture reaches `ask()`/`tell()`.
 */
export const TRAINING_TASKS: readonly FixtureTask[] = allTasks.filter(
  (t) => !heldOutNames.has(t.name),
);

/** Fixtures reserved for final scoring. Never fed to the optimizer loop. */
export const HELD_OUT_TASKS: readonly FixtureTask[] = allTasks.filter((t) =>
  heldOutNames.has(t.name),
);

/** Samples per task — mirrors the tier-2B convention for variance reduction. */
export const FIXTURE_K = dump.k;

/**
 * Seed one fixture into a fresh temp workspace and return its path.
 *
 * The graded test is written to `_t.py` at the workspace root. That exact
 * name is load-bearing: `run-gate.ts`'s TEST_FILE regex only matches
 * `_t*.py` / `test_*.py` / `*_test.py`, and the check gate finds it via the
 * "adjacent_test" priority once the agent writes to `entry`. Any other name
 * silently degrades the run-gate tier to "synth" (runtime-authored, zero
 * reward credit) with no error — the rollout would look like it scored a
 * legitimate zero rather than like it was misconfigured.
 */
export function seedFixtureWorkspace(task: FixtureTask): string {
  const root = mkdtempSync(join(tmpdir(), `jarvis-rollout-${task.name}-`));
  for (const [relPath, contents] of Object.entries(task.files)) {
    const target = join(root, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  writeFileSync(join(root, "_t.py"), task.test, "utf8");
  return root;
}
