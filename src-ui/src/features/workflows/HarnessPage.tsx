import { useEffect, useMemo, useReducer, useState } from 'react';
import { Button, Page, PageHeader } from '../../design';
import { harnessReducer, initialHarnessState } from '../../domain/harness-state';
import type { HarnessPurpose, SavedHarnessManifest } from './harness-api';
import { HarnessApiError, harnessApi } from './harness-api';

const PURPOSES: Array<{ id: HarnessPurpose; label: string }> = [
  { id: 'bug_fix', label: 'Bug fix' },
  { id: 'feature', label: 'Feature' },
  { id: 'generic_audit', label: 'Generic audit' },
  { id: 'release_prep', label: 'Release preparation' },
];

// The manifest lookup is a Native read, so its failure surfaces the project's own
// sentence rather than whatever the rejecting layer said. A Native error may embed
// store or project detail, and it explains nothing the operator can act on here:
// the fix is always to retry the lookup against a readable project.
const MANIFEST_READ_FAILED =
  'Could not read saved harness manifests. The read failed or was malformed; this is not an empty list. Retry the lookup when the project is readable.';

export default function HarnessPage() {
  const [state, dispatch] = useReducer(harnessReducer, initialHarnessState);
  const [projectRoot, setProjectRoot] = useState('');
  const [purpose, setPurpose] = useState<HarnessPurpose>('bug_fix');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const root = projectRoot.trim();
    if (!root) {
      setLoading(false);
      setLoadError(null);
      dispatch({ type: 'manifests-loaded', manifests: [] });
      dispatch({ type: 'manifest-selected', saved: null });
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    dispatch({ type: 'manifests-loaded', manifests: [] });
    dispatch({ type: 'manifest-selected', saved: null });
    void harnessApi.listManifests(root)
      .then((manifests) => {
        if (cancelled) return;
        if (!Array.isArray(manifests)) {
          // A malformed body is a failed read, not an empty list, and the
          // operator's next step is the same as after a rejection.
          dispatch({ type: 'manifests-loaded', manifests: [] });
          setLoadError(MANIFEST_READ_FAILED);
          return;
        }
        dispatch({ type: 'manifests-loaded', manifests });
      })
      .catch(() => {
        if (cancelled) return;
        dispatch({ type: 'manifests-loaded', manifests: [] });
        setLoadError(MANIFEST_READ_FAILED);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectRoot, reloadKey]);

  const manifests = useMemo(
    () => state.manifests.filter((saved) => saved.manifest.purpose === purpose),
    [state.manifests, purpose],
  );
  const selected = state.selected && manifests.some((saved) => saved.manifest.id === state.selected?.manifest.id)
    ? state.selected
    : null;

  function selectManifest(saved: SavedHarnessManifest) {
    setSaveError(null);
    dispatch({ type: 'manifest-selected', saved });
  }

  function editGuideList(field: 'rules' | 'skills' | 'references' | 'banned_defaults', value: string) {
    // Keep every line, including blank ones, or the textarea's controlled value
    // would swallow the newline as soon as the operator presses Enter. Blank
    // entries are dropped when the guides are saved.
    const entries = value.split(/\r?\n/);
    setSaveError(null);
    dispatch({ type: 'guides-edited', guides: { [field]: entries } });
  }

  async function reloadToCompare() {
    const root = projectRoot.trim();
    const id = selected?.manifest.id;
    if (!root || !id || loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const latest = await harnessApi.listManifests(root);
      if (!Array.isArray(latest)) {
        setLoadError(MANIFEST_READ_FAILED);
        return;
      }
      dispatch({ type: 'manifests-loaded', manifests: latest });
      const fresh = latest.find((item) => item.manifest.id === id);
      if (fresh) {
        dispatch({ type: 'manifest-refreshed', saved: fresh });
      } else {
        dispatch({ type: 'manifest-selected', saved: null });
        setSaveError('That manifest is no longer in the saved list. Your guide edits were not saved.');
      }
    } catch {
      setLoadError(MANIFEST_READ_FAILED);
    } finally {
      setLoading(false);
    }
  }

  async function saveGuides() {
    if (!selected || !state.dirty.guides || saving) return;
    const loadedRevision = selected.revision;
    const edited = state.dirty.guides;
    const clean = (lines: string[]) => lines.filter((line) => line.trim().length > 0);
    const guides = { ...selected.manifest.guides, ...edited };
    guides.rules = clean(guides.rules);
    guides.skills = clean(guides.skills);
    guides.references = clean(guides.references);
    guides.banned_defaults = clean(guides.banned_defaults);
    const manifest = { ...selected.manifest, guides };
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await harnessApi.updateManifest(manifest, loadedRevision);
      dispatch({ type: 'manifest-saved', saved });
    } catch (error) {
      if (error instanceof HarnessApiError && error.code === 'stale_revision') {
        dispatch({ type: 'revision-conflict', expectedRevision: loadedRevision });
      } else {
        setSaveError('Could not save guide edits. Your edits are still unsaved; retry when the manifest can be saved. No harness run or result is claimed.');
      }
    } finally {
      setSaving(false);
    }
  }

  const purposeLabel = PURPOSES.find((item) => item.id === purpose)?.label ?? purpose;

  return (
    <Page wide>
      <PageHeader
        eyebrow="Build · verification"
        title="Harness"
        description="Choose a project and purpose to find its saved verification manifest. This picker does not run checks or claim a result."
      />

      <section className="max-w-3xl space-y-6" aria-label="Harness manifest picker">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5 text-[12.5px] text-ink-2">
            <span>Project root</span>
            <input
              aria-label="Project root"
              className="h-9 w-full rounded-md border border-line-strong bg-raised px-3 text-[13px] text-ink outline-none focus:border-accent"
              value={projectRoot}
              onChange={(event) => setProjectRoot(event.currentTarget.value)}
              placeholder="Enter a project directory"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="block space-y-1.5 text-[12.5px] text-ink-2">
            <span>Purpose</span>
            <select
              aria-label="Harness purpose"
              className="h-9 w-full rounded-md border border-line-strong bg-raised px-3 text-[13px] text-ink outline-none focus:border-accent"
              value={purpose}
              onChange={(event) => {
                setPurpose(event.currentTarget.value as HarnessPurpose);
                setSaveError(null);
                dispatch({ type: 'manifest-selected', saved: null });
              }}
            >
              {PURPOSES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        </div>

        <section className="rounded-xl border border-line bg-panel p-5" aria-labelledby="harness-manifests-heading">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 id="harness-manifests-heading" className="text-[15px] font-medium text-ink">Saved manifests</h2>
              <p className="mt-1 text-[12px] text-ink-3">{purposeLabel}{projectRoot.trim() ? ` · ${projectRoot.trim()}` : ''}</p>
            </div>
            {projectRoot.trim() && (
              <Button size="xs" onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
                {loading ? 'Loading…' : 'Refresh'}
              </Button>
            )}
          </div>

          {!projectRoot.trim() && (
            <p className="rounded-lg border border-line bg-raised p-4 text-[13px] text-ink-3">
              Enter a project root to look up saved manifests. No manifest lookup has been performed yet.
            </p>
          )}
          {loading && projectRoot.trim() && <p role="status" className="py-4 text-[13px] text-ink-3">Loading saved manifests…</p>}
          {!loading && loadError && (
            <div role="alert" className="space-y-3 rounded-lg border border-err/30 bg-err-wash p-4 text-[13px] text-err">
              <p>{loadError}</p>
              <Button size="xs" onClick={() => setReloadKey((key) => key + 1)}>Retry manifest lookup</Button>
            </div>
          )}
          {!loading && !loadError && projectRoot.trim() && manifests.length === 0 && (
            <div className="space-y-3 rounded-lg border border-line bg-raised p-4">
              <p className="text-[13px] font-medium text-ink">No saved manifest for this project and purpose.</p>
              <p className="text-[12px] leading-relaxed text-ink-3">A manifest is required before harness controls are available. No check or harness run has been performed.</p>
              <Button size="xs" disabled>Select a manifest</Button>
            </div>
          )}
          {!loading && !loadError && manifests.length > 0 && (
            <ul className="space-y-2">
              {manifests.map((saved) => {
                const isSelected = selected?.manifest.id === saved.manifest.id;
                return (
                  <li key={saved.manifest.id}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => selectManifest(saved)}
                      className={`w-full rounded-lg border p-4 text-left transition-colors ${isSelected ? 'border-accent bg-accent-wash' : 'border-line bg-raised hover:border-line-strong'}`}
                    >
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-ink">{saved.manifest.project_kind} · {saved.manifest.template_family}</span>
                        <span className="text-[11px] text-ink-3">Revision {saved.revision}</span>
                      </span>
                      <span className="mt-1 block font-mono text-[11px] text-ink-3">{saved.manifest.id}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {selected && (
            <div className="mt-4 space-y-4 rounded-lg border border-line bg-raised p-4">
              <p role="status" className="text-[12px] text-ink-2">
                Manifest selected. No harness run has been performed.
              </p>
              {state.dirty.guides && (
                <p className="text-[12px] text-ink-2">
                  Unsaved guide edits. Selecting another manifest or purpose discards them.
                </p>
              )}
              <div className="space-y-3">
                {([
                  ['rules', 'Rules'],
                  ['skills', 'Skills'],
                  ['references', 'References'],
                  ['banned_defaults', 'Banned defaults'],
                ] as const).map(([field, label]) => (
                  <label key={field} className="block space-y-1.5 text-[12.5px] text-ink-2">
                    <span>{label} (one entry per line)</span>
                    <textarea
                      aria-label={label}
                      className="min-h-20 w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                      value={(state.dirty.guides?.[field] ?? selected.manifest.guides[field]).join('\n')}
                      onChange={(event) => editGuideList(field, event.currentTarget.value)}
                    />
                  </label>
                ))}
                <label className="block space-y-1.5 text-[12.5px] text-ink-2">
                  <span>Brief template</span>
                  <textarea
                    aria-label="Brief template"
                    className="min-h-28 w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                    value={state.dirty.guides?.brief_template ?? selected.manifest.guides.brief_template}
                    onChange={(event) => {
                      setSaveError(null);
                      dispatch({ type: 'guides-edited', guides: { brief_template: event.currentTarget.value } });
                    }}
                  />
                </label>
              </div>
              {state.conflict && (
                <div role="alert" className="space-y-3 rounded-lg border border-err/30 bg-err-wash p-3 text-[13px] text-err">
                  <p>
                    This manifest changed since it was loaded. Your guide edits are unsaved. Reload the manifest to compare its current version; your edits stay on screen and Save then uses the reloaded revision. No save, harness run, sensor result, or approval is claimed.
                  </p>
                  <Button size="xs" onClick={() => void reloadToCompare()} disabled={loading}>
                    Reload manifest to compare
                  </Button>
                </div>
              )}
              {saveError && <p role="alert" className="text-[13px] text-err">{saveError}</p>}
              <div className="flex items-center gap-3">
                <Button size="xs" onClick={() => void saveGuides()} disabled={!state.dirty.guides || saving || Boolean(state.conflict)}>
                  {saving ? 'Saving…' : 'Save guide edits'}
                </Button>
                {selected && <span className="text-[12px] text-ink-3">Revision {selected.revision}</span>}
              </div>
            </div>
          )}
        </section>
      </section>
    </Page>
  );
}
