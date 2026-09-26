// The plugin toggle and the plugin header share one read vocabulary, and the header's
// count is the shared tally's decision rather than a second implementation of it.
import { projectListTally, type ListRead } from '../../lib/list-tally';

// Apply the confirmed target, never a second optimistic inversion.
export function confirmPluginEnablement<T extends { id: string; enabled: boolean }>(
  plugins: T[],
  id: string,
  enabled: boolean,
): T[] {
  return plugins.map((plugin) => plugin.id === id ? { ...plugin, enabled } : plugin);
}

// The three read states are the shared tally's, not a private vocabulary: this
// surface established the rule and the rule now lives in one module.
export type PluginListRead = ListRead;

export interface PluginTally {
  // null means the current read has not returned a list to count. A confirmed
  // empty read is a real 0, never null, so a genuine zero stays a zero.
  count: number | null;
  enabled: number | null;
}

// The header states a count only while a confirmed read is the list on screen:
// a read in flight claims nothing, and a failed read claims nothing even when a
// list it did not confirm is still held. This surface replaces its rows with the
// error state on a failed read, so the count has to go with them; the decision
// itself is the shared tally's, and only the enabled pill is derived here.
export function projectPluginTally<T extends { enabled: boolean }>(
  plugins: T[],
  read: PluginListRead,
): PluginTally {
  const { count } = projectListTally(plugins, read);
  if (count === null) return { count: null, enabled: null };
  return { count, enabled: plugins.filter((plugin) => plugin.enabled).length };
}
