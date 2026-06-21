// RECOVERY NOTE (2026-06-19):
//   The original Agents component was truncated in the recovered tree.
//   Replaced with a no-op stub so the build is green. A future pass
//   should port the real implementation back from the transcript logs.

import { PageTransition, SectionHeader, EmptyState } from '../ui';

export function AgentsView() {
  return (
    <PageTransition>
      <SectionHeader
        title="Agents"
        subtitle="Reconstruction pending — see RECOVERY_STATUS.md"
      />
      <EmptyState message="This view has not been recovered yet." />
    </PageTransition>
  );
}

export default AgentsView;
