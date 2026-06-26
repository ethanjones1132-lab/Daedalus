export class OrchestratorJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorJsonError";
  }
}

export function extractJson<T>(text: string): T {
  try {
    return JSON.parse(text.trim()) as T;
  } catch {}

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const jsonStr = text.substring(start, end + 1);
    try {
      return JSON.parse(jsonStr) as T;
    } catch {}
  }
  throw new OrchestratorJsonError(`Failed to parse JSON from orchestrator output: ${text}`);
}
