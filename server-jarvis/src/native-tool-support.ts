/**
 * Per-model native-tool capability learned from live provider responses.
 * OpenCode Zen is probed optimistically; a provider's explicit unsupported
 * response permanently downgrades that model for the current process.
 */
const unsupportedNativeToolModels = new Set<string>();

function key(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}:${model.trim()}`;
}

export function supportsNativeToolsForProvider(provider: string, model: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider === "opencode_zen") {
    return !unsupportedNativeToolModels.has(key(normalizedProvider, model));
  }
  // OpenCode Go has mixed protocols (/chat/completions and Anthropic
  // /messages); retain its existing conservative text-tool behavior.
  return false;
}

export function markNativeToolProtocolUnsupported(provider: string, model: string): void {
  if (provider.trim().toLowerCase() === "opencode_zen") {
    unsupportedNativeToolModels.add(key(provider, model));
  }
}

export function __resetNativeToolSupportForTests(): void {
  unsupportedNativeToolModels.clear();
}
