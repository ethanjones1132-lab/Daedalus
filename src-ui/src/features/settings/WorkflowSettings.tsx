import { lazy, Suspense, useState } from 'react';
import { Disclosure, Panel, StatusLine } from '../../design';
const GoalNotificationsPanel = lazy(() => import('./GoalNotificationsPanel'));
const TrustedManifestsPanel = lazy(() => import('./TrustedManifestsPanel'));
/** Authority reads begin only after the operator opens these settings. */
export default function WorkflowSettings() {
  const [open, setOpen] = useState(false);
  return <Panel className="p-4"><Disclosure summary="Workflow controls" open={open} onOpenChange={setOpen}>{open && <Suspense fallback={<StatusLine>Loading workflow controls…</StatusLine>}><GoalNotificationsPanel /><TrustedManifestsPanel /></Suspense>}</Disclosure></Panel>;
}
