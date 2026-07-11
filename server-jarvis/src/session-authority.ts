/** Canonical session authority boundary shared by the HTTP adapter and tests. */
export interface SessionRunRecord {
  session_id: string;
  run_id: string;
  outcome: "success" | "partial" | "failed" | "timed_out" | "cancelled";
  selected_model?: string;
  token_count?: number;
  tool_count?: number;
  cancelled_reason?: string;
  partial_output?: string;
}

export function deprecatedSessionsPostResponse(): Response {
  return Response.json(
    {
      error: "sessions_are_native",
      code: "deprecated_session_api",
      message: "Create sessions through the native Tauri session command.",
    },
    { status: 410 },
  );
}

