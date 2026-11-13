import { useEffect, useMemo, useReducer, useState } from 'react';
import { Button, Page, PageHeader } from '../../design';
import { harnessReducer, initialHarnessState } from '../../domain/harness-state';
import type { HarnessPurpose, SavedHarnessManifest } from './harness-api';
import { harnessApi } from './harness-api';

const PURPOSES: Array<{ id: HarnessPurpose; label: string }> = [
  { id: 'bug_fix', label: 'Bug fix' },
  { id: 'feature', label: 'Feature' },
  { id: 'generic_audit', label: 'Generic audit' },
  { id: 'release_prep', label: 'Release preparation' },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The manifest request failed.';
}

export default function HarnessPage() {
  const [state, dispatch] = useReducer(harnessReducer, initialHarnessState);
  const [projectRoot, setProjectRoot] = useState('');
  const [purpose, setPurpose] = useState<HarnessPurpose>('bug_fix');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
        if (!Array.isArray(manifests)) throw new Error('The manifest response was unreadable; it is not an empty manifest list.');
        dispatch({ type: 'manifests-loaded', manifests });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        dispatch({ type: 'manifests-loaded', manifests: [] });
        setLoadError(`Could not read saved harness manifests: ${errorMessage(error)} This is not an empty list.`);
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
    dispatch({ type: 'manifest-selected', saved });
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
            <p role="status" className="mt-4 rounded-lg border border-line bg-raised p-3 text-[12px] text-ink-2">
              Manifest selected. Guide editing, live rounds, and run history are not part of this picker slice.
            </p>
          )}
        </section>
      </section>
    </Page>
  );
}
