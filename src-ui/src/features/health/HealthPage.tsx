import { EmptyState, Page, PageHeader } from '../../design';

// PLACEHOLDER — replaced during the UI rebuild. See docs/design/daedalus-ui.md.
export default function HealthPage() {
  return (
    <Page>
      <PageHeader eyebrow="System" title="Health" />
      <EmptyState title="Under construction" description="This surface is being rebuilt on the Daedalus design system." />
    </Page>
  );
}
