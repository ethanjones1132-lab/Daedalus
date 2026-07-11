export type CredentialProvider = "openrouter" | "opencode_zen" | "opencode_go";
export type ProviderTestResult = { ok: boolean; latency_ms: number; error?: string };

export function providerLabel(provider: CredentialProvider): string {
  return provider === "openrouter" ? "OpenRouter API Key"
    : provider === "opencode_zen" ? "OpenCode Zen API Key"
    : "OpenCode Go API Key";
}

export function providerTestState(result?: ProviderTestResult): { label: string; variant: "default" | "success" | "error" } {
  if (!result) return { label: "Not tested", variant: "default" };
  if (result.ok) return { label: `Connected · ${result.latency_ms} ms`, variant: "success" };
  return { label: result.error || "Connection failed", variant: "error" };
}
