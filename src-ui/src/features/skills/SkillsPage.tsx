import { EmptyState, Page, PageHeader } from '../../design';

// PLACEHOLDER — replaced during the UI rebuild. See docs/design/daedalus-ui.md.
export default function SkillsPage() {
  return (
    <Page>
      <PageHeader eyebrow="Build" title="Skills" />
      <EmptyState title="Under construction" description="This surface is being rebuilt on the Daedalus design system." />
    </Page>
  );
}
