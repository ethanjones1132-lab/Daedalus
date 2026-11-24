import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Button, Page, PageHeader } from '../../design';
import { harnessReducer, initialHarnessState } from '../../domain/harness-state';
import type { HarnessPurpose, HarnessRun, HarnessSensor, SavedHarnessManifest } from './harness-api';
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

// How often an in-flight run is re-read while this page is open. The timer is
// owned by the page and cleared with it, so nothing polls after the operator
// leaves, and nothing starts a run except the click.
const LIVE_POLL_MS = 2000;

const LIVE_READ_FAILED =
  'Could not read this harness run from the server. Its rounds and events are not shown; retry the read. No stop reason is claimed.';

const START_FAILED =
  'Could not start a harness run. No run was created and no result is claimed; retry when the server answers.';

export default function HarnessPage() {
  const [state, dispatch] = useReducer(harnessReducer, initialHarnessState);
  const [projectRoot, setProjectRoot] = useState('');
  const [purpose, setPurpose] = useState<HarnessPurpose>('bug_fix');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A second tap before React re-renders would otherwise post a second start or
  // cancel for the same click target.
  const startInFlight = useRef(false);
  const cancelInFlight = useRef(false);

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

  useEffect(() => {
    const root = projectRoot.trim();
    if (!root) {
      dispatch({ type: 'history-reset' });
      return;
    }
    let cancelled = false;
    dispatch({ type: 'history-loading' });
    void harnessApi.listRuns(root)
      .then((runs) => {
        if (cancelled) return;
        if (!Array.isArray(runs)) {
          dispatch({ type: 'history-error', message: 'Could not read harness run history. The response was malformed; it is not an empty history.' });
          return;
        }
        dispatch({ type: 'history-loaded', runs });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'history-error', message: 'Could not read harness run history. Retry when the project is readable.' });
      });
    return () => { cancelled = true; };
  }, [projectRoot]);

  // A run shown in the panel belongs to the project that started it. Typing a
  // different root clears the panel rather than letting it read as this root's.
  useEffect(() => {
    dispatch({ type: 'live-reset' });
  }, [projectRoot]);

  // Re-read an in-flight run's own record while this page is open. The timer
  // lives and dies with the page and with the run's unsettled phase.
  useEffect(() => {
    const runId = state.live.runId;
    if (!runId || state.live.phase !== 'running') return;
    const root = projectRoot.trim();
    if (!root) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (cancelled) return;
      void readLiveRun(root, runId);
    }, LIVE_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [state.live.runId, state.live.phase, projectRoot]);

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

  async function selectHistoryRun(id: string) {
    const root = projectRoot.trim();
    if (!root) return;
    dispatch({ type: 'history-run-selected', id });
    try {
      const run = await harnessApi.getRun(root, id);
      if (!isReadableRun(run, id, root)) {
        dispatch({ type: 'history-run-error', id, message: 'Could not read this harness run. The response was malformed; no run details are available.' });
        return;
      }
      dispatch({ type: 'history-run-loaded', run });
    } catch (error) {
      const message = error instanceof HarnessApiError && error.isRunNotFound()
        ? 'That harness run was not found for this project. No run details are available.'
        : 'Could not read this harness run. No run details are available; retry the lookup.';
      dispatch({ type: 'history-run-error', id, message });
    }
  }

  // Every round and event on the panel comes through this read; the start
  // route only returns an id.
  async function readLiveRun(root: string, runId: string) {
    try {
      const run = await harnessApi.getRun(root, runId);
      if (!isReadableRun(run, runId, root)) {
        dispatch({ type: 'live-read-failed', runId, message: LIVE_READ_FAILED });
        return;
      }
      dispatch({ type: 'live-loaded', run });
    } catch (error) {
      const message = error instanceof HarnessApiError && error.isRunNotFound()
        ? 'That harness run was not found for this project. No rounds or events are available for it.'
        : LIVE_READ_FAILED;
      dispatch({ type: 'live-read-failed', runId, message });
    }
  }

  async function startLiveRun() {
    const root = projectRoot.trim();
    const manifestId = selected?.manifest.id;
    if (!root || !manifestId || startInFlight.current || state.live.phase === 'starting' || state.live.phase === 'running') return;
    startInFlight.current = true;
    dispatch({ type: 'live-starting' });
    try {
      const started = await harnessApi.startRun({ projectRoot: root, manifestId });
      if (!started || typeof started.run_id !== 'string' || started.run_id.length === 0) {
        dispatch({ type: 'live-start-failed', message: 'The start response did not name a run. No run is shown; retry the start.' });
        return;
      }
      dispatch({ type: 'live-started', runId: started.run_id });
      void readLiveRun(root, started.run_id);
    } catch (error) {
      if (error instanceof HarnessApiError && error.isExecutionUnavailable()) {
        // The server's own refusal: no execution is wired into it, and no run
        // exists to read. Render that state instead of retrying or guessing.
        dispatch({ type: 'live-start-refused' });
        return;
      }
      dispatch({ type: 'live-start-failed', message: START_FAILED });
    } finally {
      startInFlight.current = false;
    }
  }

  async function cancelLiveRun() {
    const root = projectRoot.trim();
    const runId = state.live.runId;
    if (!root || !runId || cancelInFlight.current || state.live.cancelStatus === 'cancelling') return;
    cancelInFlight.current = true;
    dispatch({ type: 'live-cancelling' });
    try {
      const result = await harnessApi.cancelRun(root, runId);
      if (!result || result.run_id !== runId || typeof result.stop_reason !== 'string') {
        dispatch({ type: 'live-cancel-failed', message: 'The cancel response did not confirm this run. No cancel is claimed; check the run again.' });
        return;
      }
      dispatch({ type: 'live-cancelled', runId, stopReason: result.stop_reason });
      // The server answers after the run settled, so a fresh read carries the
      // stopped event that belongs with this stop reason.
      void readLiveRun(root, runId);
    } catch (error) {
      if (error instanceof HarnessApiError && error.isRunNotRunning()) {
        dispatch({ type: 'live-not-running' });
        void readLiveRun(root, runId);
        return;
      }
      dispatch({ type: 'live-cancel-failed', message: 'Could not cancel this harness run. It may still be running; retry the cancel. No stopped state is claimed.' });
    } finally {
      cancelInFlight.current = false;
    }
  }

  function eventPayload(run: HarnessRun, eventType: string): Record<string, unknown> | null {
    const event = run.events.find((item) => item.event_type === eventType);
    return typeof event?.payload === 'object' && event.payload !== null
      ? event.payload as Record<string, unknown>
      : null;
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
              <p className="text-[12px] leading-relaxed text-ink-3">A manifest is required before harness controls are available. No check or harness run has been started from this page.</p>
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
                Manifest selected. Start a harness run from the live run panel below; run history stays read-only.
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

        <section className="rounded-xl border border-line bg-panel p-5" aria-labelledby="harness-live-heading">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="harness-live-heading" className="text-[15px] font-medium text-ink">Live run</h2>
              <p className="mt-1 text-[12px] text-ink-3">
                {selected
                  ? `${selected.manifest.project_kind} · ${selected.manifest.template_family} · ${selected.manifest.id}`
                  : 'No manifest selected.'}
              </p>
            </div>
            {state.live.phase === 'running' ? (
              <Button size="xs" onClick={() => void cancelLiveRun()} disabled={state.live.cancelStatus === 'cancelling'}>
                {state.live.cancelStatus === 'cancelling' ? 'Cancelling…' : 'Cancel run'}
              </Button>
            ) : selected ? (
              <Button size="xs" onClick={() => void startLiveRun()} disabled={state.live.phase === 'starting'}>
                {state.live.phase === 'starting' ? 'Starting…' : 'Start harness run'}
              </Button>
            ) : null}
          </div>

          {state.live.phase === 'idle' && !state.live.startRefusal && !state.live.startError && (
            <p className="rounded-lg border border-line bg-raised p-4 text-[13px] text-ink-3">
              {selected
                ? 'Nothing has been started from this page yet. Start a run to watch its rounds and events as the server records them.'
                : 'Select a manifest above to start a harness run. No run has been started from this page.'}
            </p>
          )}
          {state.live.phase === 'starting' && (
            <p role="status" className="py-4 text-[13px] text-ink-3">Starting the harness run…</p>
          )}
          {state.live.startRefusal === 'execution_unavailable' && (
            <div role="alert" className="space-y-2 rounded-lg border border-err/30 bg-err-wash p-4 text-[13px] text-err">
              <p>This server cannot start a harness yet: it has no harness execution wired in. No run was created, and no rounds or results exist for one.</p>
              <p className="text-[12px]">The start was refused with <span className="font-mono">harness_execution_unavailable</span> (HTTP 503).</p>
            </div>
          )}
          {state.live.startError && (
            <p role="alert" className="rounded-lg border border-err/30 bg-err-wash p-4 text-[13px] text-err">{state.live.startError}</p>
          )}

          {state.live.runId && (() => {
            const run = state.live.detail;
            const matchingManifest = run
              ? state.manifests.find((saved) => saved.manifest.id === run.manifest_id && saved.manifest_hash === run.manifest_hash)
              : undefined;
            const sensorsById = new Map(matchingManifest?.manifest.sensors.map((sensor) => [sensor.id, sensor] as const) ?? []);
            return (
              <div className="space-y-3" aria-label="Live harness run">
                <div>
                  <p className="text-[13px] font-medium text-ink">Run <span className="font-mono text-[11px]">{state.live.runId}</span></p>
                  <p className="mt-1 text-[12px] text-ink-3">
                    {run
                      ? `${run.status} · manifest id ${run.manifest_id} · ${run.rounds.length} ${run.rounds.length === 1 ? 'round' : 'rounds'} · ${run.events.length} ${run.events.length === 1 ? 'event' : 'events'} · started ${run.created_at}`
                      : 'Reading the run from the server…'}
                  </p>
                </div>
                {state.live.phase === 'running' && (
                  <p role="status" className="text-[12px] text-ink-2">
                    Run in flight. Its rounds and events are read from the server while this page is open.
                  </p>
                )}
                {state.live.stopReason && (
                  <p role="status" className="rounded-lg border border-line bg-raised p-3 text-[13px] text-ink-2">Stop reason: {state.live.stopReason}</p>
                )}
                {state.live.cancelStatus === 'cancelled' && (
                  <p className="text-[12px] text-ink-2">The server accepted the cancel and the run settled.</p>
                )}
                {state.live.cancelStatus === 'not_running' && (
                  <p role="alert" className="rounded-lg border border-err/30 bg-err-wash p-3 text-[13px] text-err">
                    That harness run is not running on this server, so there was nothing to cancel. No cancel is claimed; the run's recorded state is read from its own route.
                  </p>
                )}
                {state.live.cancelStatus === 'error' && state.live.cancelError && (
                  <p role="alert" className="rounded-lg border border-err/30 bg-err-wash p-3 text-[13px] text-err">{state.live.cancelError}</p>
                )}
                {state.live.detailStatus === 'error' && state.live.detailError && (
                  <div role="alert" className="space-y-3 rounded-lg border border-err/30 bg-err-wash p-3 text-[13px] text-err">
                    <p>{state.live.detailError}</p>
                    <Button
                      size="xs"
                      onClick={() => {
                        const root = projectRoot.trim();
                        const runId = state.live.runId;
                        if (!root || !runId) return;
                        dispatch({ type: 'live-read-loading', runId });
                        void readLiveRun(root, runId);
                      }}
                    >
                      Check the run again
                    </Button>
                  </div>
                )}
                {run && (
                  <>
                    <h3 className="text-[13px] font-medium text-ink">Live rounds</h3>
                    <RunRounds run={run} sensorsById={sensorsById} />
                    <h3 className="text-[13px] font-medium text-ink">Live events</h3>
                    <RunEvents events={run.events} />
                  </>
                )}
              </div>
            );
          })()}
        </section>

        <section className="rounded-xl border border-line bg-panel p-5" aria-labelledby="harness-history-heading">
          <div className="mb-4">
            <h2 id="harness-history-heading" className="text-[15px] font-medium text-ink">Run history</h2>
            <p className="mt-1 text-[12px] text-ink-3">{projectRoot.trim() || 'Select a project root to view its saved runs.'}</p>
          </div>
          {state.historyStatus === 'idle' && (
            <p className="rounded-lg border border-line bg-raised p-4 text-[13px] text-ink-3">Enter a project root to look up saved harness runs.</p>
          )}
          {state.historyStatus === 'loading' && <p role="status" className="py-4 text-[13px] text-ink-3">Loading saved harness runs…</p>}
          {state.historyStatus === 'empty' && (
            <p className="rounded-lg border border-line bg-raised p-4 text-[13px] text-ink-3">No harness run has been recorded for this project.</p>
          )}
          {state.historyStatus === 'error' && (
            <p role="alert" className="rounded-lg border border-err/30 bg-err-wash p-4 text-[13px] text-err">{state.historyError}</p>
          )}
          {(state.historyStatus === 'loaded' || state.historyStatus === 'loading') && state.runHistory.length > 0 && (
            <ul className="space-y-2">
              {state.runHistory.map((run) => {
                const stopped = eventPayload(run, 'stopped');
                const isSelected = state.selectedHistoryRunId === run.id;
                const matchingManifest = state.manifests.find((saved) =>
                  saved.manifest.id === run.manifest_id && saved.manifest_hash === run.manifest_hash);
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => void selectHistoryRun(run.id)}
                      className={`w-full rounded-lg border p-4 text-left transition-colors ${isSelected ? 'border-accent bg-accent-wash' : 'border-line bg-raised hover:border-line-strong'}`}
                    >
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-ink">{run.status}</span>
                        <span className="text-[11px] text-ink-3">{run.rounds.length} {run.rounds.length === 1 ? 'round' : 'rounds'}</span>
                      </span>
                      <span className="mt-1 block font-mono text-[11px] text-ink-3">{run.id}</span>
                      <span className="mt-2 grid gap-1 text-[12px] text-ink-3 sm:grid-cols-2">
                        <span>Stop reason: {typeof stopped?.stop_reason === 'string' ? stopped.stop_reason : 'Not recorded'}</span>
                        <span>Manifest revision: {matchingManifest ? matchingManifest.revision : 'Unavailable for this manifest hash'}</span>
                        <span>Started: {run.created_at}</span>
                        <span>Finished: {run.events.find((event) => event.event_type === 'stopped')?.created_at ?? 'Not recorded'}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {state.selectedHistoryRunStatus === 'loading' && <p role="status" className="mt-4 text-[13px] text-ink-3">Loading selected harness run…</p>}
          {state.selectedHistoryRunStatus === 'error' && (
            <p role="alert" className="mt-4 text-[13px] text-err">{state.selectedHistoryRunError}</p>
          )}
          {state.selectedHistoryRunStatus === 'loaded' && state.selectedHistoryRun && (() => {
            const run = state.selectedHistoryRun;
            const matchingManifest = state.manifests.find((saved) =>
              saved.manifest.id === run.manifest_id && saved.manifest_hash === run.manifest_hash);
            const sensorsById = new Map(matchingManifest?.manifest.sensors.map((sensor) => [sensor.id, sensor] as const) ?? []);
            return (
              <div className="mt-4 space-y-3" aria-label="Selected run details">
                <h3 className="text-[13px] font-medium text-ink">Run rounds</h3>
                <RunRounds run={run} sensorsById={sensorsById} />
              </div>
            );
          })()}
        </section>
      </section>
    </Page>
  );
}

/** A run read from GET /harness/runs/:id must name itself and carry both collections. */
function isReadableRun(run: HarnessRun | null | undefined, id: string, root: string): run is HarnessRun {
  return Boolean(run) && run!.id === id && run!.project_root === root
    && Array.isArray(run!.rounds) && Array.isArray(run!.events);
}

function RunRounds({ run, sensorsById }: { run: HarnessRun; sensorsById: Map<string, HarnessSensor> }) {
  if (run.rounds.length === 0) {
    return <p className="rounded-lg border border-line bg-raised p-4 text-[13px] text-ink-3">This run has no rounds recorded yet.</p>;
  }
  return (
    <ol className="space-y-3">
      {[...run.rounds].sort((a, b) => a.round_number - b.round_number).map((round) => {
        const statuses = round.sensor_results.map((result) => result.status);
        const hasNonZeroValue = round.sensor_results.some((result) => typeof result.counter === 'number' && result.counter > 0);
        const outcome = statuses.length === 0 ? 'No sensor results recorded'
          : statuses.includes('failed') ? 'Failed'
            : hasNonZeroValue ? 'Non-zero sensor value'
            : statuses.every((status) => status === 'passed') ? 'Passed'
              : statuses.every((status) => status === 'not_applicable') ? 'Not applicable'
                : 'Mixed sensor results';
        return (
          <li key={round.id} className="rounded-lg border border-line bg-raised p-4">
            <h4 className="text-[13px] font-medium text-ink">Round {round.round_number} · {outcome}</h4>
            {round.sensor_results.length === 0 ? (
              <p className="mt-2 text-[12px] text-ink-3">No sensor results recorded for this round.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {round.sensor_results.map((result) => {
                  const sensor = sensorsById.get(result.sensor_id);
                  const displayedStatus = result.status === 'passed' && typeof result.counter === 'number' && result.counter > 0
                    ? 'Non-zero value (reported passed)'
                    : result.status;
                  return (
                    <li key={result.id} className="border-t border-line pt-3 text-[12px]">
                      <p className="font-medium text-ink">{result.sensor_id} · {displayedStatus}</p>
                      <p className="mt-1 text-ink-3">Result ID: <span className="font-mono">{result.id}</span> · Value: {result.counter ?? 'Not recorded'} · Zero threshold: {sensor ? sensor.zero_threshold : 'Unavailable for this manifest hash'}</p>
                      {result.stdout && <BoundedOutput label="stdout" value={result.stdout} truncated={result.stdout_truncated} />}
                      {result.stderr && <BoundedOutput label="stderr" value={result.stderr} truncated={result.stderr_truncated} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The run's own event log, in the order the server returns it. */
function RunEvents({ events }: { events: HarnessRun['events'] }) {
  if (events.length === 0) {
    return <p className="rounded-lg border border-line bg-raised p-4 text-[13px] text-ink-3">This run has no events recorded yet.</p>;
  }
  return (
    <ol className="space-y-2">
      {events.map((event) => {
        const payload = typeof event.payload === 'object' && event.payload !== null
          ? event.payload as Record<string, unknown>
          : null;
        const stopReason = typeof payload?.stop_reason === 'string' ? payload.stop_reason : null;
        return (
          <li key={event.id} className="rounded-lg border border-line bg-raised p-3 text-[12px]">
            <p className="font-medium text-ink">{event.event_type}</p>
            <p className="mt-1 text-ink-3">{event.created_at}{stopReason ? ` · stop_reason: ${stopReason}` : ''}</p>
          </li>
        );
      })}
    </ol>
  );
}

function BoundedOutput({ label, value, truncated }: { label: string; value: string; truncated: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-2">
      <p className="text-[11px] font-medium text-ink-3">{label}{truncated ? ' (bounded; truncated by the harness)' : ''}</p>
      <pre className="mt-1 whitespace-pre-wrap break-words rounded-md border border-line bg-panel p-2 text-[11px] text-ink-2">
        {!expanded && (truncated || value.length > 240) ? `${value.slice(0, 240)}…` : value}
      </pre>
      {(truncated || value.length > 240) && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)} className="mt-1 text-[11px] text-accent hover:underline">
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
    </div>
  );
}
