import { useId, useState, type ReactNode } from 'react';
import { Tabs } from '../../design';
/** Advanced native controls mount only after explicit selection. */
export function FeatureModes({ label, primary, advanced }: { label: string; primary: ReactNode; advanced: ReactNode }) {
  const [mode, setMode] = useState<'browse' | 'controls'>('browse');
  const id = useId();
  return <div className="flex h-full min-h-0 flex-col"><Tabs className="shrink-0 px-6" aria-label={`${label} mode`} idBase={id} items={[{ id: 'browse', label: 'Overview' }, { id: 'controls', label }]} value={mode} onChange={setMode} /><div className="min-h-0 flex-1" role="tabpanel" id={`${id}-panel-${mode}`} aria-labelledby={`${id}-tab-${mode}`}>{mode === 'browse' ? primary : <div className="h-full overflow-auto p-6">{advanced}</div>}</div></div>;
}
