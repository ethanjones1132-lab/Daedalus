export const MAX_CRON_OUTPUT_LENGTH = 500;

export type CronExecutionStatus = "success" | "failed" | "cancelled" | "timeout";

export interface CronExecutionEvidence {
  run_id: string;
  status: CronExecutionStatus;
  started_at: string;
  finished_at: string;
  acceptance_result?: string;
  error_code?: string;
}

export interface CronRunResponse {
  success: boolean;
  output: string;
  error?: string;
  execution_evidence?: CronExecutionEvidence;
}

export interface CronTerminalOutcome {
  success: boolean;
  output: string;
  error?: string;
  status: CronExecutionStatus;
  error_code?: string;
}

export interface CronTerminalAccumulator {
  observe(frame: unknown): void;
  settle(): CronTerminalOutcome;
}

export interface CronStreamOptions {
  surface: "cron";
  systemPromptOverride?: string;
}

export interface CronProjectionValidation {
  ok: boolean;
  entry?: { instructions?: string };
  code?: string;
  message?: string;
}

export interface CronFeedbackResult {
  success: boolean;
  output: string;
  applied?: number;
  error?: string;
}

export interface CronInferenceDependencies {
  stream: (prompt: string, sessionId: string, options: CronStreamOptions) => Promise<Response>;
  validateProjection: (snapshot: unknown) => CronProjectionValidation;
  refreshInferenceFeedback: () => Promise<CronFeedbackResult>;
  feedbackJobId: string;
  now?: () => string;
  uuid?: () => string;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function statusForCode(code: string): CronExecutionStatus {
  const normalized = code.toLowerCase();
  return normalized.includes("timeout") || normalized.endsWith("deadline_exceeded") ? "timeout" : "failed";
}

class CronTerminalAccumulatorImpl implements CronTerminalAccumulator {
  private streamed = "";
  private terminal: CronTerminalOutcome | undefined;

  observe(frame: unknown): void {
    if (this.terminal) return;
    if (typeof frame === "string") return;
    const event = recordValue(frame);
    if (!event) return;

    if (event.type === "stream_event") {
      const delta = recordValue(event.delta);
      const text = stringValue(delta?.text);
      if (text) this.streamed = `${this.streamed}${text}`.slice(0, MAX_CRON_OUTPUT_LENGTH);
      return;
    }

    if (event.type === "result") {
      const resultText = stringValue(event.result) ?? stringValue(event.content) ?? "";
      const isError = event.is_error === true;
      const subtype = stringValue(event.subtype);
      const code = stringValue(event.code);

      if (isError) {
        this.terminal = {
          success: false,
          output: resultText || this.streamed,
          error: "Inference failed",
          status: statusForCode(code ?? "inference_failed"),
          error_code: code ?? "inference_failed",
        };
        return;
      }

      if (subtype === "partial") {
        const errorCode = code ?? "inference_partial";
        this.terminal = {
          success: false,
          output: resultText || this.streamed,
          error: "Inference returned a partial result",
          status: statusForCode(errorCode),
          error_code: errorCode,
        };
        return;
      }

      if (subtype === "error") {
        const errorCode = code ?? "inference_failed";
        this.terminal = {
          success: false,
          output: resultText || this.streamed,
          error: "Inference failed",
          status: statusForCode(errorCode),
          error_code: errorCode,
        };
        return;
      }

      if (subtype && subtype !== "success") {
        const errorCode = code ?? "inference_failed";
        this.terminal = {
          success: false,
          output: resultText || this.streamed,
          error: "Inference returned an invalid terminal result",
          status: statusForCode(errorCode),
          error_code: errorCode,
        };
        return;
      }

      this.terminal = {
        success: true,
        output: resultText || this.streamed,
        status: "success",
      };
      return;
    }

    if (event.type === "error") {
      const errorCode = stringValue(event.code) ?? "inference_failed";
      this.terminal = {
        success: false,
        output: this.streamed,
        error: stringValue(event.error) ?? "Inference failed",
        status: statusForCode(errorCode),
        error_code: errorCode,
      };
      return;
    }

    if (event.type === "cancelled") {
      this.terminal = {
        success: false,
        output: this.streamed,
        error: "cancelled",
        status: "cancelled",
        error_code: "cancelled",
      };
    }
  }

  settle(): CronTerminalOutcome {
    if (this.terminal) return this.terminal;
    this.terminal = {
      success: false,
      output: this.streamed,
      error: "The Jarvis stream ended without a terminal outcome.",
      status: "failed",
      error_code: "stream_ended_without_outcome",
    };
    return this.terminal;
  }
}

export function createCronTerminalAccumulator(): CronTerminalAccumulator {
  return new CronTerminalAccumulatorImpl();
}

export async function drainCronStreamJarvisResponse(
  response: Response,
  accumulator: CronTerminalAccumulator = createCronTerminalAccumulator(),
): Promise<CronTerminalOutcome> {
  const reader = response.body?.getReader();
  if (!reader) {
    return {
      success: false,
      output: "",
      error: "No response body",
      status: "failed",
      error_code: "inference_failed",
    };
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trimStart();
    if (!payload || payload === "[DONE]") return;
    try {
      accumulator.observe(JSON.parse(payload));
    } catch {
      return;
    }
  };

  const consumeBufferedLines = (flush: boolean): void => {
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
    if (flush && buffer) {
      const finalLine = buffer;
      buffer = "";
      consumeLine(finalLine);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consumeBufferedLines(false);
    }
    buffer += decoder.decode();
    consumeBufferedLines(true);
    return accumulator.settle();
  } finally {
    reader.releaseLock();
  }
}

function responseFromOutcome(
  outcome: CronTerminalOutcome,
  runId: string,
  startedAt: string,
  finishedAt: string,
): CronRunResponse {
  const evidence: CronExecutionEvidence = {
    run_id: runId,
    status: outcome.status,
    started_at: startedAt,
    finished_at: finishedAt,
  };
  const output = outcome.success ? outcome.output : outcome.output.slice(0, MAX_CRON_OUTPUT_LENGTH);

  if (outcome.success) {
    evidence.acceptance_result = output.slice(0, MAX_CRON_OUTPUT_LENGTH);
  } else {
    const error = outcome.error ?? outcome.status;
    evidence.error_code = outcome.error_code ?? outcome.status;
    evidence.acceptance_result = error;
  }

  return {
    success: outcome.success,
    output,
    ...(outcome.error ? { error: outcome.error } : {}),
    execution_evidence: evidence,
  };
}

export async function runCronInference(
  body: Record<string, unknown>,
  dependencies: CronInferenceDependencies,
): Promise<CronRunResponse> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const uuid = dependencies.uuid ?? (() => crypto.randomUUID());
  const runId = uuid();
  const startedAt = now();

  if (String(body.job_id ?? "") === dependencies.feedbackJobId) {
    const refreshed = await dependencies.refreshInferenceFeedback();
    const finishedAt = now();
    const status: CronExecutionStatus = refreshed.success ? "success" : "failed";
    return {
      success: refreshed.success,
      output: refreshed.output || (refreshed.success
        ? `Applied ${refreshed.applied ?? 0} inference feedback adjustment(s).`
        : ""),
      error: refreshed.error,
      execution_evidence: {
        run_id: runId,
        status,
        started_at: startedAt,
        finished_at: finishedAt,
        acceptance_result: refreshed.output || status,
        error_code: refreshed.error ? "refresh_failed" : undefined,
      },
    };
  }

  const prompt = String(body.prompt ?? "");
  if (!prompt.trim()) {
    return {
      success: false,
      output: "",
      error: "prompt required",
      execution_evidence: {
        run_id: runId,
        status: "failed",
        started_at: startedAt,
        finished_at: now(),
        acceptance_result: "prompt required",
        error_code: "missing_prompt",
      },
    };
  }

  const sessionId = String(body.session_id ?? `cron_${uuid()}`);
  const projectionValue = body.projection_snapshot;
  let canonicalInstructions: string | undefined;
  if (projectionValue !== undefined && projectionValue !== null) {
    if (typeof projectionValue !== "object" || typeof (projectionValue as { slug?: unknown }).slug !== "string") {
      return {
        success: false,
        output: "",
        error: "invalid projection snapshot",
        execution_evidence: {
          run_id: runId,
          status: "failed",
          started_at: startedAt,
          finished_at: now(),
          acceptance_result: "invalid projection snapshot",
          error_code: "projection_invalid",
        },
      };
    }
    const validation = dependencies.validateProjection(projectionValue);
    if (!validation.ok) {
      const message = validation.message ?? "invalid projection snapshot";
      return {
        success: false,
        output: "",
        error: message,
        execution_evidence: {
          run_id: runId,
          status: "failed",
          started_at: startedAt,
          finished_at: now(),
          acceptance_result: message,
          error_code: validation.code ?? "projection_invalid",
        },
      };
    }
    canonicalInstructions = validation.entry?.instructions;
  }

  try {
    const response = await dependencies.stream(prompt, sessionId, {
      surface: "cron",
      systemPromptOverride: canonicalInstructions,
    });
    const outcome = await drainCronStreamJarvisResponse(response);
    return responseFromOutcome(outcome, runId, startedAt, now());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = message || "Cron inference failed";
    return responseFromOutcome({
      success: false,
      output: "",
      error: safeMessage,
      status: "failed",
      error_code: "exception",
    }, runId, startedAt, now());
  }
}

export async function handleCronRunRequest(
  body: Record<string, unknown>,
  dependencies: CronInferenceDependencies,
): Promise<Response> {
  return Response.json(await runCronInference(body, dependencies));
}
