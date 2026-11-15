#!/usr/bin/env node
// Root-level UI typecheck: run the compiler `src-ui` already installed, offline.
//
//   npm run typecheck:ui             # -> tsc -b inside src-ui
//   npm run typecheck:ui -- --force  # extra flags are passed through to tsc
//
// Why a guard instead of `npx tsc -b src-ui`: npx silently downloads the
// compiler from the npm registry when it cannot resolve one locally, which
// turns a half-provisioned worktree into a network dependency and a slow,
// misleading failure. This script only ever runs a local file, and reports a
// missing compiler as an environment failure instead of repairing it.
//
// The compiler is the one pinned by src-ui/package.json (`typescript` ~5.7.0),
// resolved from <ui>/node_modules/typescript and run with src-ui as the working
// directory, so the output matches `cd src-ui && tsc -b` (what the verify floor
// and CI run).
//
// Test hooks (see README, "UI typecheck from the repo root"):
//   JARVIS_UI_DIR  UI project directory (default: <repo>/src-ui)
//   JARVIS_UI_TSC  compiler entry point
//                  (default: <ui>/node_modules/typescript/bin/tsc,
//                  falling back to <ui>/node_modules/typescript/lib/tsc.js)
//
// Exit codes: 0 compiler said clean; 1 compiler found type errors (tsc's own
// code, passed through); 2 the environment cannot run the compiler.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = path.resolve(repoRoot, process.env.JARVIS_UI_DIR || "src-ui");
const tsconfigPath = path.join(uiDir, "tsconfig.json");

const rel = (p) => {
  const r = path.relative(process.cwd(), p);
  return r === "" ? "." : r;
};

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function fail(lines) {
  for (const line of lines) console.error(`[typecheck:ui] ${line}`);
  process.exit(2);
}

// The installed compiler, in resolution order. bin/tsc is the entry the
// typescript package declares; lib/tsc.js is the module it forwards to.
const candidatePaths = process.env.JARVIS_UI_TSC
  ? [path.resolve(uiDir, process.env.JARVIS_UI_TSC)]
  : [
      path.join(uiDir, "node_modules", "typescript", "bin", "tsc"),
      path.join(uiDir, "node_modules", "typescript", "lib", "tsc.js"),
    ];

if (!isFile(tsconfigPath)) {
  fail([
    `no UI project at ${rel(tsconfigPath)}.`,
    "Point JARVIS_UI_DIR at the UI directory (it must contain tsconfig.json), or run this from the repo root.",
  ]);
}

const tscPath = candidatePaths.find(isFile);
if (!tscPath) {
  fail([
    `TypeScript compiler not found. Looked for:`,
    ...candidatePaths.map((p) => `  ${rel(p)}`),
    "src-ui pins `typescript` in src-ui/package.json; install the UI dependencies first:",
    "    cd src-ui && bun install        # or: cd src-ui && npm ci",
    "This command never downloads a compiler, so there is no registry fallback.",
    process.env.JARVIS_UI_TSC
      ? `JARVIS_UI_TSC is set to ${process.env.JARVIS_UI_TSC}; it must name an existing tsc entry point.`
      : "JARVIS_UI_TSC (compiler path) and JARVIS_UI_DIR (UI directory) override the resolution.",
  ]);
}

function compilerVersion() {
  try {
    const pkgPath = path.join(path.dirname(tscPath), "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const extraArgs = process.argv.slice(2);
const tscArgs = ["tsc", "-b", ...extraArgs].join(" ");
console.error(`[typecheck:ui] typescript ${compilerVersion()} (${rel(tscPath)}) -> ${tscArgs}`);

const run = spawnSync(process.execPath, [tscPath, "-b", ...extraArgs], {
  cwd: uiDir,
  stdio: "inherit",
});

if (run.error) {
  fail([
    `could not start the compiler at ${rel(tscPath)}: ${run.error.message}`,
    "This command runs node against a local file; check that the file is readable and not a broken symlink.",
  ]);
}

process.exit(run.status ?? 1);
