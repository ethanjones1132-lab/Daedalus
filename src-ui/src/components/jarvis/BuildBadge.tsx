// ═══════════════════════════════════════════════════════════════
// ── BuildBadge — always-visible build provenance + stale guard
// ═══════════════════════════════════════════════════════════════
//
// Shows the running binary's version + short git SHA, and marks it when the
// source tree has advanced past what this binary was built from (so a stale dev
// binary is obvious instead of silently misleading).
//
// Three states, not two: `get_build_info` answers `stale: false` when the source
// tree is not on this machine at all, which is "not checked" rather than
// "checked and current". A binary whose provenance cannot be checked therefore
// reads as `unverifiable` and never as a clean build. The badge is mounted in
// the sidebar and the header, so both share one observation (`useBuildProvenance`)
// and one re-check on window focus.

import { useBuildProvenance } from '../../hooks/useBuildProvenance';
import { buildProvenanceView } from './build-provenance';

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
      className="text-[10px] font-mono text-bone-faint inline-flex items-center gap-1 hover:text-bone/70"
    >
      {view.versionLabel}
      {view.shaLabel && <span className="opacity-50">{view.shaLabel}</span>}
      {view.marker && <span className={view.markerClass}>{view.marker}</span>}
    </button>
  );
}
