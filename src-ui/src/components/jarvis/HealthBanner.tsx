// RECOVERY NOTE (2026-06-19):
//   The original HealthBanner component was truncated in the recovered tree.
//   Replaced with a no-op stub so the build is green. A future pass
//   should port the real implementation back from the transcript logs
//   under C:/Projects/_recovery/from-transcripts-all/.

import { PageTransition, SectionHeader, EmptyState } from '../ui';

export default function HealthBanner() {
  return (
    <PageTransition>
      <SectionHeader
        title="Health"
        subtitle="Reconstruction pending — see RECOVERY_STATUS.md"
      />
      <EmptyState message="Health banner will be restored in a follow-up pass." />
    </PageTransition>
  );
}
