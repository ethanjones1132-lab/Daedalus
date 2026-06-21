// RECOVERY NOTE (2026-06-19):
//   The original GatewayView component was truncated in the recovered tree.
//   Replaced with a no-op stub so the build is green. A future pass
//   should port the real implementation back from the transcript logs
//   under C:/Projects/_recovery/from-transcripts-all/.

import { PageTransition, SectionHeader, EmptyState } from '../ui';

export default function GatewayView() {
  return (
    <PageTransition>
      <SectionHeader
        title="Gateway"
        subtitle="Reconstruction pending — see RECOVERY_STATUS.md"
      />
      <EmptyState message="This view has not been recovered yet. The Rust backend for this surface is live; the front-end binding will be restored in a follow-up pass." />
    </PageTransition>
  );
}
