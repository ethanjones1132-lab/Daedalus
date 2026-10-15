// Section-count guard.
//
// `SectionHeader` prints its count inside the heading as the view's own name —
// `Devices(0)` — whenever `typeof count === 'number'` (`components/ui/index.tsx`).
// That makes a count a headline claim about a read, not a decoration. Nine
// mounted surfaces kept their list in a `useState<T[]>([])` and passed
// `count={list.length}` from a header that sits *above and independently of* the
// read gate its own body implements, so an unanswered read and a failed one both
// printed a confident `0`. That is the reading which most strongly says "there is
// nothing here", produced by a read that returned nothing, and it is
// indistinguishable from a genuinely empty install. Every one of those bodies
// already withheld its `EmptyState` on a failed read — the body was honest and
// only the header was not.
//
// The `PluginsView` tally row fixed one surface and shipped the rule *in that
// one module*, so the class recurred twice more: first the nine `count={length}`
// headers, then the tally pills in the same headers' `action` slot. This is the
// rule, as a ratchet: every claim a header makes about a read — the parenthetical
// inside its name and every numbered pill beside it — is either routed through the
// one shared tally, is optional-chained off a value that is `null` until its read
// returns, or has a documented reason why it makes no claim. A new count or tally
// on a list no read has returned cannot ship until someone writes down what read is
// behind it — and a claim with no such read has no sentence to write.
//
// It reads the source as text rather than rendering anything: the rule spans
// files, and rendering the app needs Tauri IPC mocks. No Rust toolchain, no
// Tauri.

import { describe, expect, it } from 'vitest';
import {
  findCountSites,
  isOptionalRead,
  matchCountAllowlist,
  routesThroughSharedTally,
  type SectionCountAllowlistEntry,
} from './lib/section-count-guard';

// Vite `?raw` glob — every non-test source module as a string, so a new file
// with a count is scanned without touching this file.
const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Every claim a header makes about a read, with the evidence that the read behind
 * it can end. Three kinds are allowed:
 *
 * - `confirmed-read` — the number comes from `lib/list-tally.ts`, which states
 *   it only while a confirmed read is the list on screen: nothing for a read in
 *   flight, nothing for a read that failed with no rows on screen, and a real
 *   `0` for a confirmed empty one. Two slots qualify: the `count` prop inside the
 *   heading, and a numbered `Pill` in the `action` slot beside it.
 * - `optional-read` — the expression is optional-chained off a value that is
 *   `null` until its read returns, so the primitive receives `undefined` and
 *   prints no parenthetical at all until then.
 * - `no-claim` — the number is not a count of a read, and the entry says what it
 *   is instead. Nothing is on this list today; the kind exists so that a future
 *   display-only number has to be argued in prose rather than slipped in.
 */
const ALLOWLIST: SectionCountAllowlistEntry[] = [
  {
    file: './components/jarvis/DevicesView.tsx',
    text: 'count={sectionCount(devices, { loading, failed: error !== null })}',
    kind: 'confirmed-read',
    reason:
      'The Devices header, over the rows `get_devices` returned. The list starts empty, so before this change the header read `Devices(0)` beside both `Loading devices…` and `Could not load devices.` The body already withheld its `EmptyState` on a failed read and appended its own “Previously loaded … may be stale.” sentence, so the header was the only claim on that surface with nothing behind it.',
  },
  {
    file: './components/jarvis/HooksView.tsx',
    text: 'count={sectionCount(hooks, { loading, failed: error !== null })}',
    kind: 'confirmed-read',
    reason:
      'The Hooks header, over the rows `get_hooks` returned, and the same rule as its two siblings: a read in flight states nothing, a failed read with nothing on screen states nothing, and a confirmed empty read still states `(0)` so an empty install stays distinguishable from an unreachable one.',
  },
  {
    file: './components/jarvis/NodesView.tsx',
    text: 'count={sectionCount(nodes, { loading, failed: error !== null })}',
    kind: 'confirmed-read',
    reason:
      'The Nodes header, over the rows `get_nodes` returned. A distributed-compute list that reads as empty because the store was locked is the most misleading zero on the surface, because an operator with nodes expects rows and concludes they are gone rather than unread.',
  },
  {
    file: './components/jarvis/ApprovalsView.tsx',
    text: 'count={sectionCount(approvals, { loading, failed: error !== null })}',
    kind: 'confirmed-read',
    reason:
      'The Approvals header, over the queue `get_approvals` returned. This surface’s own copy already distinguishes the two failures — a stale warning when requests were retained, and a plain sentence when none were — and the count follows the same distinction instead of printing a zero above both.',
  },
  {
    file: './components/jarvis/ChannelsView.tsx',
    text: 'count={countProp(tally)}',
    kind: 'confirmed-read',
    reason:
      'The Channels header, over the rows `list_channels` returned. A failed read keeps the confirmed rows on screen under the surface’s own staleness warning, so the count of those rows is not in doubt and stays; a failed first read has no rows, and states nothing. The count and the two pills in the slot beside it now come from one tally, so the three numbers on that header cannot disagree about one read.',
  },
  {
    file: './components/jarvis/CommitmentsView.tsx',
    text: 'count={sectionCount(commitments, { loading, failed: error !== null })}',
    kind: 'confirmed-read',
    reason:
      'The Commitments header, over the rows `get_commitments` returned. The filter above it narrows what is listed, not what was read, so the count stays the read’s own number and the filter is a separate, visible act.',
  },
  {
    file: './components/jarvis/MemoryView.tsx',
    text: 'count={sectionCount(memories, { loading, failed: error !== null })}',
    kind: 'confirmed-read',
    reason:
      'The Memory header, over the rows `list_recent_memories` or a recall returned. This surface clears its list at the start of every read, so nothing on screen here can have come from an older read and the count is exactly what the newest one confirmed — including `(0)` for a confirmed empty recall.',
  },
  {
    file: './components/jarvis/SkillsView.tsx',
    text: 'count={countProp(tally)}',
    kind: 'confirmed-read',
    reason:
      'The Skills header, over the rows `list_skills` returned, and the largest list in the app: a failed read used to read as `Skills(0)` beside the surface’s own `Could not load skills.`, which is the reading that most strongly says this install has no skills at all. The `enabled` pill in the slot beside it is derived from the same tally, so a failed read takes both numbers away together rather than leaving `0 enabled` next to a count that claims nothing.',
  },
  {
    file: './components/jarvis/AgentsView.tsx',
    text: 'count={sectionCount(agents, { loading, failed: listError !== null })}',
    kind: 'confirmed-read',
    reason:
      'The Agents header, over the rows `list_agents` returned, and the one surface whose read failure is named `listError` rather than `error` because row-level operation failures share the same body. The count answers to that flag, so an operation failure cannot silently blank the number either.',
  },
  {
    file: './components/jarvis/CronView.tsx',
    text: 'count={sectionCount(jobs, { loading, failed: error !== null })}',
    kind: 'confirmed-read',
    reason:
      'The Cron Jobs header. This surface returns the whole page while its read is in flight, so the pending half of the rule is unreachable here by construction; the failed half is not, and a failed first read used to read as `Cron Jobs(0)` above the surface’s own alert.',
  },
  {
    file: './App.tsx',
    text: 'count={sectionCount(recent, { loading, failed: error })}',
    kind: 'confirmed-read',
    reason:
      'The Overview’s "Recent Sessions" header, over the five rows it renders from the shell’s own snapshot reducer. A read that returned the snapshot confirms them; the reducer holds the whole snapshot or `null`, so the count and the rows are the same fact. The five are the rows the header titles, not a claim about how many Sessions exist — which is also why the clamp it replaced was a display limit wearing a measurement’s typography.',
  },
  {
    file: './App.tsx',
    text: 'count={sectionCount(filtered, { loading, failed: listFailed })}',
    kind: 'confirmed-read',
    reason:
      'The Chat Feeds sidebar header, over the filter-matched rows it renders. The count follows the rows, so typing in the filter box narrows the number with the list rather than leaving a number that no longer describes what is on screen. The first read is the only one that sets `loading`, so a poll cannot blank a confirmed count.',
  },
  {
    file: './App.tsx',
    text: 'count={sessions?.length}',
    kind: 'optional-read',
    reason:
      'The Sessions view header. `sessions` is `null` until the reducer publishes a confirmed read and stays `null` after a failed one, so `sessions?.length` hands the primitive `undefined` and the header prints no parenthetical until a read has answered. Named because it is the shape this rule prefers, not an exemption from it.',
  },
  {
    file: './components/jarvis/ActionRegistryView.tsx',
    text: 'count={summary?.active}',
    kind: 'optional-read',
    reason:
      'The Action Registry header, over the summary record rather than a list. `summary` is derived from `snapshot?.summary`, and the snapshot is `null` until `get_action_registry_summary` has answered, so the count is absent for a pending read and for a failed one alike.',
  },
  {
    file: './components/jarvis/PluginsView.tsx',
    text: 'count={countProp(tally)}',
    kind: 'confirmed-read',
    reason:
      'The Plugins header, the surface that established the rule: `projectPluginTally` returns `count: null` for anything that is not a confirmed read, and its count now comes from the same shared tally every other header uses, so the two cannot drift apart.',
  },
  {
    file: './components/jarvis/SkillsView.tsx',
    text: '{enabledCount} enabled',
    kind: 'confirmed-read',
    reason:
      'The Skills `enabled` pill, the second half of the sentence its count starts. `list_skills` is the only read behind it, `tallyNumber` derives the number from the same tally the count prints, and the `tallyTone` threshold is the `> 0 ? success : default` this pill already used. An unanswered or failed read states no number at all here — a `0 enabled` beside `Could not load skills.` reads as a measured claim that this install has nothing enabled, which is the strongest thing a pill can say and the one thing a read that returned nothing cannot support.',
  },
  {
    file: './components/jarvis/ChannelsView.tsx',
    text: '{connectedCount} connected',
    kind: 'confirmed-read',
    reason:
      'The Channels `connected` pill, counted from the same `list_channels` rows the count beside it prints. The number is a stored login flag rather than a live socket, which the line under the header already says in words, so the pill’s job is only to answer for the read: nothing while a read is unanswered, nothing once one has failed with no rows on screen, and the real figure — including a real `0` — once a read has confirmed the list.',
  },
  {
    file: './components/jarvis/ChannelsView.tsx',
    text: '{verifiedCount} delivery verified',
    kind: 'confirmed-read',
    reason:
      'The Channels `delivery verified` pill, the strongest claim in that slot: only a probe that delivered a message adds a channel to it, so `0 delivery verified` reads as "nothing has been proven to deliver" rather than as "no channel exists". It is counted over the same confirmed `list_channels` rows as the two numbers beside it, which is why it disappears with them on a read that failed and why a confirmed zero stays stated.',
  },
  {
    file: './components/jarvis/ControlCenterView.tsx',
    text: 'count={sectionCount(logLines, { loading: logResource.loading, failed: logResource.error })}',
    kind: 'confirmed-read',
    reason:
      'The Server log header, over the lines `GET /diagnostics/log` returned. This surface is the one place a count answers a read over HTTP rather than a Tauri command, because the log is a file the Bun server owns and `SystemStore.logs` is written by nothing — so the flag pair is the same two booleans every other site passes, and the count is absent while the read is unanswered and absent after a failed first read. The case the rule exists for is the empty one: a file that could not be opened is answered as a failed read, so `Server log(0)` can only ever mean a file that was read and held no lines.',
  },
  {
    file: './components/jarvis/PluginsView.tsx',
    text: '{tally.enabled} enabled',
    kind: 'confirmed-read',
    reason:
      'The Plugins `enabled` pill, the surface that already gated it by hand (`tally.enabled === null ? undefined : …`) and therefore the one the shared tally was modelled on. Its number now comes from `tallyNumber` rather than from a second `filter` inside this module, and its tone from `tallyTone`, so the pill and the count it sits beside are two readings of one decision instead of two implementations of one idea.',
  },
];

describe('section-count guard', () => {
  it('finds every count prop in the UI source, so the allowlist cannot pass vacuously', () => {
    const sites = findCountSites(sources);
    expect(sites.length).toBeGreaterThan(0);
    // The shell's Sessions header is the anchor: if the scan ever stopped
    // finding a real prop, every other case here would be measuring nothing.
    expect(
      sites.some((site) => site.text.includes('count={sessions?.length}')),
      'the scan should still find the Sessions header',
    ).toBe(true);
  });

  it('finds every tally pill in a header’s action slot, so that half cannot pass vacuously', () => {
    const slots = findCountSites(sources).filter((site) => site.slot === 'action');
    // A tally pill is the other half of the sentence a count starts, and it
    // lives outside the heading, so the count scan alone never saw any of these.
    // Four is the whole inventory: two in Channels, one in Skills, one in
    // Plugins. A fifth claim in a header is the case the guard exists for, so
    // this number is the count, not a lower bound.
    expect(slots).toHaveLength(4);
    for (const unit of ['{connectedCount} connected', '{verifiedCount} delivery verified', '{enabledCount} enabled', '{tally.enabled} enabled']) {
      expect(
        slots.some((site) => site.text.includes(unit)),
        `the scan should find the \`${unit}\` pill`,
      ).toBe(true);
    }
  });

  it('allows no claim that a documented read does not account for', () => {
    const sites = findCountSites(sources);
    const { undocumented, unused } = matchCountAllowlist(sites, ALLOWLIST);
    expect(
      undocumented.map((site) => `${site.file}:${site.line} [${site.slot}]: ${site.text}`),
      'header claims with no documented read behind them — route the number through `sectionCount`, `countProp`, `tallyNumber` or `tallyTone` from lib/list-tally.ts, optional-chain it off a value that is null until its read returns, or add an entry above saying what read is behind it',
    ).toEqual([]);
    expect(
      unused.map((entry) => `${entry.file}: ${entry.text}`),
      'allowlist entries that match no site — the claim moved or was deleted, so the entry is now a claim about nothing',
    ).toEqual([]);
  });

  it('keeps every claimed count honest in terms of the read that ends it', () => {
    const sites = findCountSites(sources);
    for (const entry of ALLOWLIST) {
      const site = sites.find((candidate) => candidate.file === entry.file && candidate.text.includes(entry.text));
      if (!site) continue; // reported as an unused entry above
      if (entry.kind === 'confirmed-read') {
        expect(
          routesThroughSharedTally(site.text),
          `${entry.file}: a confirmed-read entry must route through lib/list-tally.ts, and this line does not: ${site.text}`,
        ).toBe(true);
      }
      if (entry.kind === 'optional-read') {
        expect(
          isOptionalRead(site.text),
          `${entry.file}: an optional-read entry must be optional-chained off a value that is null until its read returns, and this line is not: ${site.text}`,
        ).toBe(true);
      }
    }
  });

  it('documents every entry as a real sentence, because the reason is the guard', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, `${entry.file}: ${entry.text}`).toBeGreaterThan(60);
    }
  });

  it('has no display-only count to allow, so a new one has to be argued', () => {
    // A `no-claim` entry is the one kind that can hide a real number behind
    // prose, so the class is pinned to empty rather than left to grow quietly.
    expect(ALLOWLIST.filter((entry) => entry.kind === 'no-claim')).toEqual([]);
  });
});
