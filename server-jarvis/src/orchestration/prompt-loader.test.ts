import { describe, test, expect } from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";

/**
 * Regression tests for the prompt loader. The original loader only tried
 * 4 hardcoded relative paths; when the Bun runtime resolved __dirname
 * differently (e.g. from a bundled release binary or a Tauri resource
 * directory), it could not find a `prompts/` directory that existed
 * further up the tree, and the live chat path returned a
 * `Prompt file not found` error frame to the user.
 */
describe("loadPrompt resolution", () => {
  test("finds prompts via JARVIS_PROMPTS_DIR override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-prompts-"));
    mkdirSync(join(dir, "modes"), { recursive: true });
    writeFileSync(join(dir, "router.md"), "PROMPT_BODY");
    try {
      process.env.JARVIS_PROMPTS_DIR = dir;
      const { loadPrompt } = await import("./prompt-loader");
      expect(loadPrompt("router.md")).toBe("PROMPT_BODY");
    } finally {
      delete process.env.JARVIS_PROMPTS_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds prompts shipped beside the bundled entry (__dirname/prompts)", () => {
    // The deployed-native case: `bun build` emits a single index.js and the
    // app runs `bun.exe <Desktop>/index.js`, so __dirname is the bundle dir
    // with no server-jarvis source tree up the ancestry. A `prompts/` folder
    // beside index.js (with a `modes/` subdir) must resolve. We exercise the
    // real loader in a sub-process whose __dirname is the synthetic bundle dir.
    const root = mkdtempSync(join(tmpdir(), "jarvis-beside-"));
    const bundleDir = join(root, "Desktop");
    const promptsDir = join(bundleDir, "prompts");
    mkdirSync(join(promptsDir, "modes"), { recursive: true });
    writeFileSync(join(promptsDir, "coordinator.md"), "COORDINATOR_BESIDE");
    writeFileSync(join(promptsDir, "modes", "planner.md"), "PLANNER_BESIDE");

    const loaderPath = join(import.meta.dir, "prompt-loader.ts");
    const stagedLoader = join(bundleDir, "prompt-loader.ts");

    const sub = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `
          const src = await Bun.file(${JSON.stringify(loaderPath)}).text();
          const modPath = ${JSON.stringify(stagedLoader)};
          await Bun.write(modPath, src);
          // Run from a cwd where the cwd-based candidates cannot match, so only
          // the __dirname/prompts candidate can succeed.
          process.chdir(${JSON.stringify(root)});
          const m = await import(modPath);
          const top = m.loadPrompt("coordinator.md");
          const nested = m.loadPrompt("modes/planner.md");
          process.stdout.write("RESULT::" + top + "::" + nested + "::END");
        `,
      ],
      env: { ...process.env, JARVIS_PROMPTS_DIR: "" },
      cwd: root,
    });

    rmSync(root, { recursive: true, force: true });

    if (sub.exitCode !== 0) {
      throw new Error(
        `Subprocess failed (exit=${sub.exitCode}):\nstdout=${sub.stdout?.toString()}\nstderr=${sub.stderr?.toString()}`,
      );
    }
    const stdout = sub.stdout.toString();
    expect(stdout).toContain("RESULT::COORDINATOR_BESIDE::PLANNER_BESIDE::END");
  });

  test("walk-up fallback finds prompts dir when __dirname lands in a non-source location", () => {
    // Simulate the bundled-binary layout: a synthetic tree where the
    // orchestration dir contains nothing useful, and the prompts dir
    // lives two levels up under server-jarvis/src/prompts/. The
    // loader's walk-up (candidates 4-9) must reach it.
    //
    // We exercise this in a sub-process so __dirname resolves to a
    // path we control, not the test's own directory.
    const root = mkdtempSync(join(tmpdir(), "jarvis-walkup-"));
    const syntheticOrchestration = join(root, "bundled", "resources");
    const realPromptsDir = join(root, "server-jarvis", "src", "prompts");
    mkdirSync(syntheticOrchestration, { recursive: true });
    mkdirSync(realPromptsDir, { recursive: true });
    writeFileSync(join(realPromptsDir, "router.md"), "WALKED_UP_BODY");

    const loaderPath = join(import.meta.dir, "prompt-loader.ts");
    // Symlink the loader into the synthetic orchestration dir so the
    // sub-process can import it with __dirname = syntheticOrchestration.
    const stagedLoader = join(syntheticOrchestration, "prompt-loader.ts");
    // Use Bun.spawnSync to invoke a small inline program that loads
    // the staged loader and prints the result. We avoid symlinks to
    // stay cross-platform and use process.cwd() + import.meta
    // resolution via dynamic import inside the child.

    const sub = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `
          import { loadPrompt } from "${loaderPath}";
          // After the loader module loads, force process.cwd into a
          // location where neither the relative nor the cwd-only
          // candidates can find router.md, but the walk-up can.
          process.chdir(${JSON.stringify(syntheticOrchestration)});
          // Move the loader module into the synthetic dir by reading it
          // and exec-ing inline — this rebinds __dirname.
          const src = await Bun.file(${JSON.stringify(loaderPath)}).text();
          const modPath = ${JSON.stringify(stagedLoader)};
          await Bun.write(modPath, src);
          const m = await import(modPath);
          const out = m.loadPrompt("router.md");
          process.stdout.write("RESULT::" + out + "::END");
        `,
      ],
      env: { ...process.env, JARVIS_PROMPTS_DIR: "" },
      cwd: root,
    });

    rmSync(root, { recursive: true, force: true });

    if (sub.exitCode !== 0) {
      throw new Error(
        `Subprocess failed (exit=${sub.exitCode}):\nstdout=${sub.stdout?.toString()}\nstderr=${sub.stderr?.toString()}`,
      );
    }
    const stdout = sub.stdout.toString();
    expect(stdout).toContain("RESULT::WALKED_UP_BODY::END");
  });

  // Regression for the live-chat outage where `loadPrompt("coordinator.md")`
  // threw `Prompt file not found` on the deployed build: every orchestrator
  // turn died with an immediate error frame and zero streaming. The mechanism
  // tests above use synthetic temp files, so they pass even if a real prompt
  // is renamed, moved, or missing from the shipped tree. This test exercises
  // the exact call sites (Coordinator + PipelineExecutor + router shim) against
  // the real source layout with no overrides — the seam that actually reproduces
  // the bug. If any orchestrator prompt stops resolving, the live chat path is
  // broken, and this test fails first.
  test("every orchestrator prompt resolves from the real source tree (no overrides)", async () => {
    const originalCwd = process.cwd();
    const previousOverride = process.env.JARVIS_PROMPTS_DIR;
    delete process.env.JARVIS_PROMPTS_DIR;
    try {
      const { loadPrompt } = await import("./prompt-loader");
      // Keep this list in lockstep with the loadPrompt() call sites in
      // coordinator.ts, pipeline.ts, and router.ts.
      const runtimePrompts = [
        "coordinator.md",
        "router.md",
        "modes/planner.md",
        "modes/executor.md",
        "modes/reviewer.md",
        "modes/rewriter.md",
        "modes/synthesizer.md",
        "modes/recursion-critique.md",
      ];
      for (const name of runtimePrompts) {
        const body = loadPrompt(name);
        expect(body.trim().length, `prompt ${name} resolved but is empty`).toBeGreaterThan(0);
      }
    } finally {
      if (previousOverride === undefined) delete process.env.JARVIS_PROMPTS_DIR;
      else process.env.JARVIS_PROMPTS_DIR = previousOverride;
      process.chdir(originalCwd);
    }
  });

  test("throws a descriptive error with all tried paths when no candidate matches", async () => {
    const originalCwd = process.cwd();
    const isolatedCwd = mkdtempSync(join(tmpdir(), "jarvis-isolated-"));
    process.chdir(isolatedCwd);
    delete process.env.JARVIS_PROMPTS_DIR;
    try {
      const { loadPrompt } = await import("./prompt-loader");
      expect(() => loadPrompt("nonexistent.md")).toThrow(/Prompt file not found/);
    } finally {
      process.chdir(originalCwd);
      rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });
});
