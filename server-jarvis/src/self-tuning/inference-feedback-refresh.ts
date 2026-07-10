import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inferenceFeedbackPath, loadInferenceFeedback, type FeedbackApplyResult } from "./inference-feedback";
import { selfTuningDbPath } from "./store";

export const INFERENCE_FEEDBACK_CRON_JOB_ID = "jarvis-system-inference-feedback";

export interface InferenceFeedbackCommandPaths {
  python: string;
  dbPath: string;
  reportsPath: string;
  policyPath: string;
}

export function buildInferenceFeedbackCommand(
  options: InferenceFeedbackCommandPaths & { scriptPath: string },
): string[] {
  return [
    options.python,
    options.scriptPath,
    "--db", options.dbPath,
    "--output-dir", options.reportsPath,
    "--policy-out", options.policyPath,
    "--format", "json",
  ];
}

export function findInferenceMetricsScript(): string | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const configured = process.env.JARVIS_INFERENCE_METRICS_SCRIPT;
  const candidates = [
    configured,
    // Deployed Desktop runtime: index.js and the packaged script are siblings.
    join(moduleDir, "automate_inference_metrics.py"),
    // Source runtime: server-jarvis/src/self-tuning -> repository root.
    resolve(moduleDir, "..", "..", "..", "automate_inference_metrics.py"),
    resolve(process.cwd(), "automate_inference_metrics.py"),
    resolve(process.cwd(), "..", "automate_inference_metrics.py"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate));
}

type CommandResult = { exitCode: number; stdout: string; stderr: string };

async function runCommand(command: string[]): Promise<CommandResult> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export async function refreshInferenceFeedback(options: {
  scriptPath?: string;
  runCommand?: (command: string[]) => Promise<CommandResult>;
  loadPolicy?: (path: string) => FeedbackApplyResult;
  paths?: Partial<InferenceFeedbackCommandPaths>;
} = {}): Promise<{ success: boolean; output: string; applied?: number; ignored?: number; error?: string }> {
  const scriptPath = options.scriptPath ?? findInferenceMetricsScript();
  if (!scriptPath) {
    return { success: false, output: "", error: "automate_inference_metrics.py not found in runtime assets" };
  }
  const jarvisRoot = join(homedir(), ".openclaw", "jarvis");
  const paths: InferenceFeedbackCommandPaths = {
    python: options.paths?.python ?? process.env.JARVIS_PYTHON_BIN ?? "python",
    dbPath: options.paths?.dbPath ?? selfTuningDbPath(),
    reportsPath: options.paths?.reportsPath ?? join(jarvisRoot, "reports", "inference"),
    policyPath: options.paths?.policyPath ?? inferenceFeedbackPath(),
  };
  try {
    const result = await (options.runCommand ?? runCommand)(
      buildInferenceFeedbackCommand({ ...paths, scriptPath }),
    );
    if (result.exitCode !== 0) {
      return {
        success: false,
        output: result.stdout.trim(),
        error: (result.stderr || `metrics process exited ${result.exitCode}`).trim().slice(0, 2_000),
      };
    }
    const applied = (options.loadPolicy ?? loadInferenceFeedback)(paths.policyPath);
    if (applied.reason) {
      return {
        success: false,
        output: result.stdout.trim(),
        error: `generated inference policy was not applied: ${applied.reason}`,
      };
    }
    return {
      success: true,
      output: result.stdout.trim(),
      applied: applied.applied,
      ignored: applied.ignored,
    };
  } catch (error) {
    return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
  }
}
