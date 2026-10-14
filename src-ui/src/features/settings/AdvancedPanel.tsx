import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RefreshCw } from 'lucide-react';
import {
  AlertLine,
  Badge,
  Button,
  Disclosure,
  EmptyState,
  Input,
  SearchInput,
  StatusLine,
  Textarea,
  cn,
  useToast,
} from '../../design';
import { SettingsPanel } from './ConfigPanels';

/**
 * Keys `set_setting` is allowed to write from this editor. Anything else in
 * the settings table (for example `theme`, which Appearance owns) is listed
 * read-only and a save for it is rejected.
 */
export const KNOWN_SETTING_KEYS = new Set([
  'version', 'active_backend', 'ollama', 'openrouter', 'llama_cpp', 'opencode_zen', 'opencode_go', 'claude_cli', 'tools',
  'reasoning', 'web_search', 'companion', 'orchestrator', 'system_prompt', 'mode',
  'prizepicks_prompt', 'temperature', 'surface_temperatures', 'max_tokens',
  'top_p', 'top_k', 'bridge_port', 'bridge_enabled', 'jarvis_path', 'compaction',
  'profiles', 'active_profile', 'api_sports_key', 'agents_root', 'goal_notifications_enabled',
]);

type Load = 'idle' | 'loading' | 'ready' | 'failed';

/** The raw key/value settings table (get_all_settings / set_setting), loaded when first opened. */
export function AdvancedPanel() {
  const { success, error: toastError } = useToast();
  const [opened, setOpened] = useState(false);
  const [load, setLoad] = useState<Load>('idle');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const request = useRef(0);

  const reload = useCallback(async () => {
    const requestId = ++request.current;
    setLoad('loading');
    try {
      const s = await invoke<Record<string, string>>('get_all_settings');
      if (request.current !== requestId) return;
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('Unexpected settings payload');
      setSettings(s);
      setEditing(s);
      setDirty(new Set());
      setLoad('ready');
    } catch {
      if (request.current !== requestId) return;
      setLoad('failed');
    }
  }, []);

  useEffect(() => {
    if (opened) void reload();
  }, [opened, reload]);

  const handleChange = (key: string, value: string) => {
    setEditing((prev) => ({ ...prev, [key]: value }));
    setDirty((prev) => {
      const next = new Set(prev);
      if (value !== settings[key]) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const saveKey = async (key: string) => {
    if (!KNOWN_SETTING_KEYS.has(key)) {
      toastError(`Unknown setting key: ${key}`, 'Save rejected');
      return;
    }
    if (saving.has(key)) return;
    const value = editing[key];
    setSaving((prev) => new Set(prev).add(key));
    try {
      await invoke('set_setting', { key, value });
      setSettings((prev) => ({ ...prev, [key]: value }));
      setDirty((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
      success(`Saved ${key}`);
    } catch {
      toastError('The setting was not written. Your edit is still in the field.', `Failed to save ${key}`);
    } finally {
      setSaving((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
    }
  };

  const needle = filter.toLowerCase();
  const keys = Object.keys(editing)
    .filter((k) => !filter || k.toLowerCase().includes(needle) || (editing[k] ?? '').toLowerCase().includes(needle))
    .sort();

  return (
    <SettingsPanel
      id="advanced"
      title="Advanced"
      description="The raw key/value table persisted in the Jarvis SQLite database. Prefer the sections above; edit here only when you know the key."
    >
      <Disclosure summary="Raw settings table" open={opened} onOpenChange={setOpened} id="advanced-settings-body">
        <div className="space-y-3 pt-1">
          {load === 'loading' && <StatusLine label="Raw settings">Loading settings…</StatusLine>}
          {load === 'failed' && (
            <AlertLine label="Raw settings" onRetry={() => void reload()} retryText="Retry settings">
              Could not load the raw settings table.
            </AlertLine>
          )}
          {load === 'ready' && (
            <>
              <div className="flex items-center gap-2">
                <SearchInput
                  value={filter}
                  onChange={setFilter}
                  placeholder="Filter settings…"
                  aria-label="Filter settings"
                  clearLabel="Clear settings filter"
                  className="flex-1"
                />
                <Button variant="ghost" icon={<RefreshCw />} onClick={() => void reload()}>
                  Reload
                </Button>
              </div>
              {keys.length === 0 ? (
                <EmptyState compact title={filter ? `No settings match "${filter}".` : 'No settings stored yet.'} />
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {keys.map((key) => {
                    const writable = KNOWN_SETTING_KEYS.has(key);
                    const isDirty = dirty.has(key);
                    const isSaving = saving.has(key);
                    const value = editing[key] ?? '';
                    return (
                      <li key={key} className={cn('space-y-1.5 px-3 py-2.5', isDirty && 'bg-warn-wash')}>
                        <div className="flex items-center gap-2">
                          <label htmlFor={`setting-${key}`} className="flex-1 truncate font-mono text-[11.5px] text-ink-2">
                            {key}
                          </label>
                          {!writable && <Badge size="xs" tone="muted">read-only</Badge>}
                          {isDirty && (
                            <Button variant="secondary" size="xs" busy={isSaving} disabled={isSaving} onClick={() => void saveKey(key)} aria-label={`Save ${key}`}>
                              {isSaving ? 'Saving…' : 'Save'}
                            </Button>
                          )}
                        </div>
                        {value.length > 60 ? (
                          <Textarea
                            id={`setting-${key}`}
                            mono
                            rows={3}
                            value={value}
                            readOnly={!writable}
                            onChange={(e) => handleChange(key, e.target.value)}
                          />
                        ) : (
                          <Input
                            id={`setting-${key}`}
                            mono
                            type="text"
                            value={value}
                            readOnly={!writable}
                            onChange={(e) => handleChange(key, e.target.value)}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {dirty.size > 0 && (
                <p className="text-center font-mono text-[11px] text-warn">
                  {dirty.size} unsaved change{dirty.size > 1 ? 's' : ''} — click Save on each row to persist
                </p>
              )}
            </>
          )}
        </div>
      </Disclosure>
    </SettingsPanel>
  );
}
