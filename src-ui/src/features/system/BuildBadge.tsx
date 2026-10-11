// ═══════════════════════════════════════════════════════════════
// ── BuildBadge — build provenance in the titlebar, with a stale guard
// ═══════════════════════════════════════════════════════════════
//
// Shows the running binary's version + short git SHA, and marks it when the
// source tree has advanced past what this binary was built from (so a stale dev
// binary is obvious instead of silently misleading).
//
// Three states, not two: `get_build_info` answers `stale: false` when the source
// tree is not on this machine at all, which is "not checked" rather than
// "checked and current". A binary whose provenance cannot be checked therefore
// reads as `unverifiable` and never as a clean build. The badge is mounted once
// (titlebar); the Health page's provenance panel reads the same shared store
// (`useBuildProvenance`), so both show one observation and one re-check on
// window focus.

import { useBuildProvenance } from '../../hooks/useBuildProvenance';
import { buildProvenanceView } from '../../domain/build-provenance';
import { cn } from '../../design';

export default function BuildBadge() {
  const { snapshot, recheck } = useBuildProvenance();
  const view = buildProvenanceView(snapshot);

  return (
    <button
      type="button"
      onClick={recheck}
      aria-busy={view.checking}
      aria-label={view.sentence}
      title={view.title}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-sunken px-2 font-mono text-[10.5px] text-ink-3',
        'transition-colors hover:border-line-strong hover:text-ink-2',
        view.checking && 'd-pulse',
      )}
    >
      <span className="text-ink-2">{view.versionLabel}</span>
      {view.shaLabel && <span className="text-ink-4">{view.shaLabel}</span>}
      {view.marker && (
        <span className={cn('font-medium', view.state === 'stale' ? 'text-warn' : 'text-accent')}>{view.marker}</span>
      )}
    </button>
  );
}
