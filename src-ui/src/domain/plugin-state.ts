// The plugin toggle and the plugin header share one read vocabulary, and the header's
// count and its enabled pill are the shared tally's decisions rather than second
// implementations of them.
import { projectListTally, tallyNumber, type ListRead } from '../lib/list-tally';

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
  // null means the current read has not returned a list to count, so the count
  // inside the heading and the enabled pill beside it both stay out. A confirmed
  // empty read is a real 0, never null, so a genuine zero stays a zero.
  count: number | null;
  enabled: number | null;
}

// The header states a count only while a confirmed read is the list on screen:
// a read in flight claims nothing, and a failed read claims nothing even when a
// list it did not confirm is still held. This surface replaces its rows with the
// error state on a failed read, so the count has to go with them; the decision
// itself is the shared tally's, and the enabled figure is a second tally over
// the same rows rather than a second idea about the read.
export function projectPluginTally<T extends { enabled: boolean }>(
  plugins: T[],
  read: PluginListRead,
): PluginTally {
  const tally = projectListTally(plugins, read);
  // The pill's number comes from the same tally as the count, so the two are
  // absent together: there is no state in which this header prints `Plugins(3)`
  // and omits the enabled figure, or keeps `0 enabled` after a read took the
  // count away.
  return { count: tally.count, enabled: tallyNumber(plugins, tally, (plugin) => plugin.enabled) };
}
