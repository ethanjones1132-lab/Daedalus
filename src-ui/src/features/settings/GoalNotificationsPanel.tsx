import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertLine, Panel, StatusLine } from '../../design';
export default function GoalNotificationsPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const saving = useRef(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    void invoke<Record<string, string>>('get_all_settings').then(settings => {
      if (!current) return;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) { setFailed(true); return; }
      const value = settings.goal_notifications_enabled;
      if (value !== undefined && value !== 'true' && value !== 'false') { setFailed(true); return; }
      setEnabled((value ?? 'true') === 'true'); setFailed(false);
    }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [retry]);
  const toggle = async (next: boolean) => {
    if (saving.current) return;
    saving.current = true; setPending(true); setFailed(false);
    try {
      await invoke('set_setting', { key: 'goal_notifications_enabled', value: String(next) });
      setEnabled(next);
    } catch { setFailed(true); }
    finally { saving.current = false; setPending(false); }
  };
  return <Panel className="my-6 p-4"><label className="flex items-center gap-3"><input type="checkbox" aria-label="In-app Goal notifications" checked={enabled ?? false} disabled={enabled === null || pending} onChange={e => void toggle(e.target.checked)} /><span>In-app Goal notifications</span></label><p className="mt-2 text-xs text-ink-3">Show Goal-linked scheduled-run progress and verified completion inside Jarvis.</p>{enabled === null && !failed && <StatusLine>Loading notification preference…</StatusLine>}{failed && <AlertLine onRetry={() => setRetry(v => v + 1)}>Could not read or save the notification preference.</AlertLine>}</Panel>;
}
