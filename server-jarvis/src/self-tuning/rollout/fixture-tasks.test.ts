import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import {
  loadFixtureK,
  loadHeldOutTasks,
  loadTrainingTasks,
  seedFixtureWorkspace,
} from "./fixture-tasks";

describe("fixture loading", () => {
  // The Bun server reaches this module through skill-store -> learning-eval
  // imports. A deployed bundle has neither the repo's benchmark directory nor
  // a guaranteed `python`, so the dump must not run at import time; on
  // 2026-10-06 it killed every server start with "spawnSync python ENOENT".
  test("importing the module does not run the Python fixture dump", () => {
    const modulePath = join(import.meta.dir, "fixture-tasks.ts");
    const result = Bun.spawnSync(
      [process.execPath, "-e", `await import(${JSON.stringify(modulePath)});`],
      { env: { PATH: "", SystemRoot: process.env.SystemRoot ?? "" } },
    );
    expect(result.stderr.toString()).not.toContain("python");
    expect(result.exitCode).toBe(0);
  });

  test("loads both splits from the Python source of truth", () => {
    expect(loadTrainingTasks().length).toBeGreaterThan(0);
    expect(loadHeldOutTasks().length).toBeGreaterThan(0);
    expect(loadFixtureK()).toBeGreaterThanOrEqual(1);
  });

  test("splits are disjoint — no fixture can be both trained on and held out", () => {
    const training = new Set(loadTrainingTasks().map((t) => t.name));
    for (const held of loadHeldOutTasks()) {
      expect(training.has(held.name), `${held.name} is in BOTH splits`).toBe(false);
    }
  });

  test("held-out set is non-trivial relative to the whole suite", () => {
    const total = loadTrainingTasks().length + loadHeldOutTasks().length;
    // Guards against a held_out.py edit silently emptying the held-out split,
    // which would make every "beats baseline" claim meaningless.
    expect(loadHeldOutTasks().length / total).toBeGreaterThan(0.05);
  });

  test("every task carries the fields a rollout needs", () => {
    for (const task of [...loadTrainingTasks(), ...loadHeldOutTasks()]) {
      expect(task.name.length, `${task.name}: empty name`).toBeGreaterThan(0);
      expect(task.entry.endsWith(".py"), `${task.name}: entry not a .py file`).toBe(true);
      expect(Object.keys(task.files).length, `${task.name}: no seed files`).toBeGreaterThan(0);
      expect(task.files[task.entry], `${task.name}: entry missing from files`).toBeDefined();
      expect(task.test.length, `${task.name}: empty test`).toBeGreaterThan(0);
      expect(task.spec.length, `${task.name}: empty spec`).toBeGreaterThan(0);
    }
  });
});

describe("seedFixtureWorkspace", () => {
  test("writes seed files, creates subdirectories, and lands the graded test at _t.py", () => {
    const withSubdir = [...loadTrainingTasks(), ...loadHeldOutTasks()].find((t) =>
      Object.keys(t.files).some((f) => f.includes("/")),
    );
    expect(withSubdir, "expected at least one fixture seeding a subdirectory").toBeDefined();

    const root = seedFixtureWorkspace(withSubdir!);
    try {
      for (const [rel, contents] of Object.entries(withSubdir!.files)) {
        const path = join(root, rel);
        expect(existsSync(path), `missing seeded file ${rel}`).toBe(true);
        expect(readFileSync(path, "utf8")).toBe(contents);
      }
      // The name is load-bearing for run-gate's adjacent_test discovery.
      const graded = join(root, "_t.py");
      expect(existsSync(graded)).toBe(true);
      expect(readFileSync(graded, "utf8")).toBe(withSubdir!.test);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("each call gets an isolated workspace", () => {
    const task = loadTrainingTasks()[0]!;
    const a = seedFixtureWorkspace(task);
    const b = seedFixtureWorkspace(task);
    try {
      expect(a).not.toBe(b);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
