// Apply the confirmed target, never a second optimistic inversion.
export function confirmPluginEnablement<T extends { id: string; enabled: boolean }>(
  plugins: T[],
  id: string,
  enabled: boolean,
): T[] {
  return plugins.map((plugin) => plugin.id === id ? { ...plugin, enabled } : plugin);
}
