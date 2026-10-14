import TrustedManifestsPanel from './TrustedManifestsPanel';
import GoalNotificationsPanel from './GoalNotificationsPanel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertLine, Page, PageHeader, StatusLine } from '../../design';
import type { JarvisConfig } from '../../domain/types';
import { AdvancedPanel } from './AdvancedPanel';
import { AppearancePanel } from './AppearancePanel';
import { ConfigPanels, type ConfigUpdater } from './ConfigPanels';
import { SECTIONS, isConfigDirty } from './config-draft';
import { SaveBar } from './SaveBar';
import { SectionIndex } from './SectionIndex';

/**
 * Settings: the Jarvis config (Inference backend, provider keys, tools, bridge…),
 * appearance, and the raw settings table.
 *
 * Saving round-trips the object that was fetched: edits spread over it, so
 * fields the TypeScript type does not describe (the Rust JarvisConfig carries
 * `mode`, `prizepicks_prompt`, `compaction`, `profiles`, `agents_root`, …) are
 * sent back untouched instead of being dropped.
 */
export default function SettingsPage() {
  // ── Load ───────────────────────────────────────────────────
  const [config, setConfig] = useState<JarvisConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const loadPending = useRef(false);

  const loadConfig = useCallback(async () => {
    if (loadPending.current) return;
    loadPending.current = true;
    setLoading(true);
    try {
      const result = await invoke<JarvisConfig>('jarvis_get_config');
      if (!result) throw new Error('Missing config');
      setConfig(result);
      setLoadError(false);
    } catch {
      // Native errors may contain configuration values; never display or log them.
      setLoadError(true);
    } finally {
      loadPending.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // ── Draft + save ───────────────────────────────────────────
  const [draft, setDraft] = useState<JarvisConfig | null>(config);
  const [savedConfig, setSavedConfig] = useState<JarvisConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const savePending = useRef(false);
  // "Saved" is true only while the draft is the very object that was saved.
  const saved = savedConfig !== null && savedConfig === draft;
  const dirty = useMemo(() => isConfigDirty(draft, config), [draft, config]);

  useEffect(() => {
    setDraft(config);
  }, [config]);

  const update: ConfigUpdater = useCallback((fn) => {
    setDraft((prev) => (prev ? fn(prev) : prev));
  }, []);

  const save = useCallback(async () => {
    if (!draft || savePending.current) return;
    const submitted = draft;
    savePending.current = true;
    setSaving(true);
    setSaveError(false);
    setSavedConfig(null);
    try {
      await invoke('jarvis_save_config', { config: submitted });
      setConfig(submitted);
      setSavedConfig(submitted);
    } catch {
      // Native errors may contain configuration values; never display or log them.
      setSaveError(true);
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  }, [draft]);

  const discard = useCallback(() => {
    if (savePending.current) return;
    setDraft(config);
    setSavedConfig(null);
    setSaveError(false);
  }, [config]);

  const sections = SECTIONS.filter((s) => !s.needsConfig || draft !== null);

  return (
    <Page>
      <PageHeader
        eyebrow="System"
        title="Settings"
        description="How Jarvis reaches its Inference backends, what it may run, and how it looks. Changes to the config apply when you save them."
      />

      <div className="grid grid-cols-1 items-start gap-x-12 gap-y-6 lg:grid-cols-[168px_minmax(0,1fr)]">
        <SectionIndex sections={sections} />

        <div className="min-w-0 space-y-5">
          {!draft && (
            <div className="space-y-3">
              {loading && <StatusLine>Loading config...</StatusLine>}
              {loadError && (
                <AlertLine onRetry={() => void loadConfig()} retryLabel="Retry config" retryDisabled={loading}>
                  Could not load config. Retry to load configuration.
                </AlertLine>
              )}
            </div>
          )}

          {draft && (
            <>
              <h2 className="d-label">Configuration</h2>
              {/* Freeze the submitted draft until native persistence resolves. */}
              <fieldset disabled={saving} aria-label="Configuration settings" className="m-0 min-w-0 space-y-5 border-0 p-0">
                <ConfigPanels draft={draft} update={update} showKeys={showKeys} onToggleKeys={() => setShowKeys((v) => !v)} />
              </fieldset>
            </>
          )}

          <h2 className="d-label pt-5">Application</h2>
          <AppearancePanel />
          <GoalNotificationsPanel /><TrustedManifestsPanel /><AdvancedPanel />

          {draft && <SaveBar dirty={dirty} saving={saving} saved={saved} saveError={saveError} onSave={() => void save()} onDiscard={discard} />}
        </div>
      </div>
    </Page>
  );
}
