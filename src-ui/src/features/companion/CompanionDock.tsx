import { Familiar } from './Familiar';

// PLACEHOLDER — replaced during the UI rebuild (Overview implementer).
export default function CompanionDock({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Familiar size={collapsed ? 36 : 40} />
    </div>
  );
}
