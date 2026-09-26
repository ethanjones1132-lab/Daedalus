// Apply the confirmed target, never a second optimistic inversion.
export function confirmPluginEnablement<T extends { id: string; enabled: boolean }>(
  plugins: T[],
  id: string,
  enabled: boolean,
): T[] {
  return plugins.map((plugin) => plugin.id === id ? { ...plugin, enabled } : plugin);
}

export type PluginListRead = 'pending' | 'confirmed' | 'failed';

export interface PluginTally {
  // null means the current read has not returned a list to count. A confirmed
  // empty read is a real 0, never null, so a genuine zero stays a zero.
  count: number | null;
  enabled: number | null;
}

// The header states a count only while a confirmed read is the list on screen:
// a read in flight claims nothing, and a failed read claims nothing even when a
// list it did not confirm is still held.
export function projectPluginTally<T extends { enabled: boolean }>(
  plugins: T[],
  read: PluginListRead,
): PluginTally {
  if (read !== 'confirmed') return { count: null, enabled: null };
  return { count: plugins.length, enabled: plugins.filter((plugin) => plugin.enabled).length };
}
