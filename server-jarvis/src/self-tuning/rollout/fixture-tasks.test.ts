import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import {
  FIXTURE_K,
  HELD_OUT_TASKS,
  TRAINING_TASKS,
  seedFixtureWorkspace,
} from "./fixture-tasks";

describe("fixture loading", () => {
  test("loads both splits from the Python source of truth", () => {
    expect(TRAINING_TASKS.length).toBeGreaterThan(0);
    expect(HELD_OUT_TASKS.length).toBeGreaterThan(0);
    expect(FIXTURE_K).toBeGreaterThanOrEqual(1);
  });

  test("splits are disjoint — no fixture can be both trained on and held out", () => {
    const training = new Set(TRAINING_TASKS.map((t) => t.name));
    for (const held of HELD_OUT_TASKS) {
      expect(training.has(held.name), `${held.name} is in BOTH splits`).toBe(false);
    }
  });

  test("held-out set is non-trivial relative to the whole suite", () => {
    const total = TRAINING_TASKS.length + HELD_OUT_TASKS.length;
    // Guards against a held_out.py edit silently emptying the held-out split,
    // which would make every "beats baseline" claim meaningless.
    expect(HELD_OUT_TASKS.length / total).toBeGreaterThan(0.05);
  });

  test("every task carries the fields a rollout needs", () => {
    for (const task of [...TRAINING_TASKS, ...HELD_OUT_TASKS]) {
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
    const withSubdir = [...TRAINING_TASKS, ...HELD_OUT_TASKS].find((t) =>
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
    const task = TRAINING_TASKS[0]!;
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
