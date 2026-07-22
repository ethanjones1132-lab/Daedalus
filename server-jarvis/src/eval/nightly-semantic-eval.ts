import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadConfig, type JarvisConfig } from "../config";
import {
  diffSemanticBaseline,
  runSemanticEval,
  type SemanticBaseline,
  type SemanticReport,
} from "./semantic-harness";

export type NightlySemanticEvalStatus = "passed" | "regressed" | "baseline_missing" | "failed";

export interface NightlySemanticEvalArtifact {
  run_id: string;
  started_at: string;
  finished_at: string;
  status: NightlySemanticEvalStatus;
  git_sha?: string;
  baseline_path: string;
  report?: SemanticReport;
  baseline?: SemanticBaseline;
  regressions: string[];
  error?: string;
}

export interface NightlySemanticEvalResult extends NightlySemanticEvalArtifact {
  artifact_path: string;
  latest_path: string;
  alert_path?: string;
}

export interface NightlySemanticEvalOptions {
  config?: JarvisConfig;
  now?: Date;
  output_dir?: string;
  baseline_path?: string;
  git_sha?: string;
  run_eval?: (config: JarvisConfig) => Promise<SemanticReport>;
}

const DEFAULT_OUTPUT_DIR = join(homedir(), ".openclaw", "jarvis", "eval", "semantic");
const DEFAULT_BASELINE_PATH = join(import.meta.dir, "semantic-baseline.json");

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(temporary, path);
}

function readBaseline(path: string): { baseline?: SemanticBaseline; error?: string } {
  if (!existsSync(path)) return { error: `baseline missing at ${path}` };
  try {
    return { baseline: JSON.parse(readFileSync(path, "utf-8")) as SemanticBaseline };
  } catch (error) {
    return { error: `baseline unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function runIdFor(startedAt: string): string {
  return startedAt.replace(/[^0-9]/g, "").slice(0, 17);
}

/**
 * Run the opt-in live semantic suite, persist a complete result artifact, and
 * create a durable alert artifact whenever the baseline cannot be trusted or
 * a real regression is detected. The caller owns scheduling and can use the
 * non-zero CLI exit as its cron alert signal.
 */
export async function runNightlySemanticEval(
  options: NightlySemanticEvalOptions = {},
): Promise<NightlySemanticEvalResult> {
  const started = (options.now ?? new Date()).toISOString();
  const runId = runIdFor(started);
  const outputDir = options.output_dir ?? DEFAULT_OUTPUT_DIR;
  const runsDir = join(outputDir, "runs");
  const alertsDir = join(outputDir, "alerts");
  const baselinePath = options.baseline_path ?? DEFAULT_BASELINE_PATH;
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(alertsDir, { recursive: true });

  const baselineResult = readBaseline(baselinePath);
  let report: SemanticReport | undefined;
  let status: NightlySemanticEvalStatus = "baseline_missing";
  let regressions = baselineResult.error ? [baselineResult.error] : [];
  let error: string | undefined;

  try {
    report = await (options.run_eval ?? runSemanticEval)(options.config ?? loadConfig());
    if (baselineResult.baseline) {
      regressions = diffSemanticBaseline(report, baselineResult.baseline);
      status = regressions.length > 0 ? "regressed" : "passed";
    }
  } catch (caught) {
    status = "failed";
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    regressions = [error];
  }

  const finished = new Date().toISOString();
  const artifact: NightlySemanticEvalArtifact = {
    run_id: runId,
    started_at: started,
    finished_at: finished,
    status,
    git_sha: options.git_sha ?? process.env.JARVIS_GIT_SHA ?? undefined,
    baseline_path: baselinePath,
    report,
    baseline: baselineResult.baseline,
    regressions,
    error,
  };
  const artifactPath = join(runsDir, `${runId}.json`);
  const latestPath = join(outputDir, "latest.json");
  writeJsonAtomic(artifactPath, artifact);
  writeJsonAtomic(latestPath, artifact);

  let alertPath: string | undefined;
  if (status !== "passed") {
    alertPath = join(alertsDir, `${runId}.json`);
    writeJsonAtomic(alertPath, artifact);
    writeJsonAtomic(join(outputDir, "latest-alert.json"), artifact);
  }

  return { ...artifact, artifact_path: artifactPath, latest_path: latestPath, alert_path: alertPath };
}

if (import.meta.main) {
  if (process.env.JARVIS_EVAL_LIVE !== "1") {
    console.error("Refusing to run: this hits live model APIs and costs money. Set JARVIS_EVAL_LIVE=1 to proceed.");
    process.exit(1);
  }

  const result = await runNightlySemanticEval();
  console.log(
    `[NightlySemanticEval] ${result.status} run=${result.run_id} ` +
      `average=${result.report?.averageScore?.toFixed(3) ?? "n/a"} ` +
      `artifact=${result.artifact_path}`,
  );
  if (result.regressions.length > 0) {
    console.error(`[NightlySemanticEval] alert: ${result.regressions.join("; ")}`);
  }
  process.exit(result.status === "passed" ? 0 : 1);
}
