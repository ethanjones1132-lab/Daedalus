// ═══════════════════════════════════════════════════════════════
// ── BuildBadge — always-visible build provenance + stale guard
// ═══════════════════════════════════════════════════════════════
//
// Shows the running binary's version + short git SHA, and a loud ⚠ marker
// when the source tree has advanced past what this binary was built from
// (so a stale dev binary is obvious instead of silently misleading).

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { BuildInfo } from './types';

export default function BuildBadge() {
  const [info, setInfo] = useState<BuildInfo | null>(null);

  useEffect(() => {
    invoke<BuildInfo>('get_build_info')
      .then(setInfo)
      .catch(() => {
        /* command unavailable (older binary) — leave the fallback showing */
      });
  }, []);

  if (!info) {
    return <span className="text-[10px] font-mono text-bone-faint">v…</span>;
  }

  const sha = info.git_short && info.git_short !== 'unknown' ? info.git_short : '';
  const title = [
    `version ${info.version}`,
    sha && `commit ${info.git_sha}`,
    info.dirty && 'built from a dirty working tree',
    info.build_time && `built ${info.build_time}`,
    info.stale && `STALE — source is now ${info.source_sha?.slice(0, 9) ?? '?'}; rebuild to match`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span
      className="text-[10px] font-mono text-bone-faint inline-flex items-center gap-1"
      title={title}
    >
      v{info.version}
      {sha && (
        <span className="opacity-50">
          ·{sha}
          {info.dirty ? '*' : ''}
        </span>
      )}
      {info.stale && (
        <span className="text-amber-400" title="Running a stale build — rebuild to match source">
          ⚠ stale
        </span>
      )}
    </span>
  );
}
