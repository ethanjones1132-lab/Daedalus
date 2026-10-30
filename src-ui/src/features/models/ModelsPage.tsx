import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Compass, Globe, Plus, RefreshCw, Server, Settings2 } from 'lucide-react';
import {
  AlertLine,
  Button,
  ConfirmModal,
  EmptyState,
  Page,
  PageHeader,
  StatusLine,
  useToast,
} from '../../design';
import {
  DEFAULT_MODEL_PROFILE_DRAFT,
  validateCreateProfileDraft,
  type CreateProfileArgs,
  type ModelProfileDraft,
} from '../../domain/model-profile-creation-state';
import { profileOperationLocked, reduceProfileOperation, type ProfileOperationPhase } from '../../domain/profile-operation-state';
import type { JarvisConfig } from '../../domain/types';
import { useNavigation } from '../../shell/navigation';
import {
  DISCOVERY_COMMANDS,
  decodeDiscoveredModels,
  mergeDiscoveredModels,
  type DiscoverySource,
} from './discovery';
import { DiscoveredModels } from './DiscoveredModels';
import { projectRoutingIdentity } from './profile-routing';
import { ProfileCreateDialog } from './ProfileCreateDialog';
import { ActiveProfileHero, ProfileCard } from './ProfileViews';
import type { DiscoveredModel, EffectiveRuntimeConfig, ModelProfile } from './types';
import { useObservedResource } from './useObservedResource';

type CreationError = 'validation' | 'write' | 'reconciliation' | null;
type DiscoveryRun = 'idle' | 'pending' | 'failed';
type SourceDiscoveryState = 'idle' | 'pending' | 'failed';
/** Where the OpenRouter key stands. The key itself is held only to forward it to the discovery command. */
type OpenRouterCredential =
  | { phase: 'loading' }
  | { phase: 'ready'; apiKey: string }
  | { phase: 'missing' }
  | { phase: 'unavailable' };

const RECONCILIATION_MESSAGE = 'Profile created, but the profile list did not confirm it. Retry reloads the list only.';

function readConfigSection(config: unknown, key: 'ollama' | 'openrouter'): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {};
  const section = (config as Record<string, unknown>)[key];
  return section && typeof section === 'object' ? (section as Record<string, unknown>) : {};
}

/** Inference: saved model profiles, the active one, and model discovery. */
export default function ModelsPage() {
  const { navigate } = useNavigation();
  const { success } = useToast();

  const profileResource = useObservedResource<ModelProfile[]>('list_model_profiles');
  const { load: loadProfiles, invalidate: invalidateProfiles } = profileResource;
  const profiles = profileResource.snapshot ?? [];
  const observed = profileResource.snapshot !== null;
  const activeProfile = profiles.find((p) => p.is_active) ?? null;
  const otherProfiles = profiles.filter((p) => !p.is_active);

  // ── Creation ───────────────────────────────────────────────
  const [pendingDelete, setPendingDelete] = useState<ModelProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<ModelProfileDraft>({ ...DEFAULT_MODEL_PROFILE_DRAFT });
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [profileCreateStage, setProfileCreateStage] = useState<'write' | 'readback' | null>(null);
  const [profileCreationError, setProfileCreationError] = useState<CreationError>(null);
  const [profileCreationMessage, setProfileCreationMessage] = useState<string | null>(null);
  const profileCreatePending = useRef(false);
  const createdProfileId = useRef<string | null>(null);

  // ── Activate / delete operations ───────────────────────────
  const operationPhase = useRef<ProfileOperationPhase>('idle');
  const [phase, setPhase] = useState<ProfileOperationPhase>('idle');
  const [operation, setOperation] = useState<{ kind: 'activate' | 'delete'; profile: ModelProfile } | null>(null);
  const [reconciliationError, setReconciliationError] = useState(false);
  const transition = useCallback((event: Parameters<typeof reduceProfileOperation>[1]) => {
    operationPhase.current = reduceProfileOperation(operationPhase.current, event);
    setPhase(operationPhase.current);
  }, []);
  const mutationLocked = profileOperationLocked(phase) || creatingProfile || profileCreationError === 'reconciliation';

  // ── Discovery ──────────────────────────────────────────────
  // Every discovery path is an explicit action: nothing here runs on load.
  const discoveryReasonId = useId();
  const [discovery, setDiscovery] = useState<DiscoveryRun>('idle');
  const discoveryRequest = useRef(0);
  const [sources, setSources] = useState<Record<DiscoverySource, SourceDiscoveryState>>({
    ollama: 'idle',
    openrouter: 'idle',
  });
  const sourceRequests = useRef<Record<DiscoverySource, number>>({ ollama: 0, openrouter: 0 });
  const sourcePending = useRef<Record<DiscoverySource, boolean>>({ ollama: false, openrouter: false });
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [discoverySucceeded, setDiscoverySucceeded] = useState(false);
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState<string | null>(null);
  const [openRouterCredential, setOpenRouterCredential] = useState<OpenRouterCredential>({ phase: 'loading' });
  /** The configured route (`jarvis_get_config`) as last confirmed; never inferred from the profile row. */
  const [routingConfig, setRoutingConfig] = useState<JarvisConfig | null>(null);

  // Read the Inference settings so OpenRouter discovery can pass its key. The key
  // is never rendered; it is held only long enough to reach the native command.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await invoke<unknown>('jarvis_get_config');
        if (cancelled) return;
        setRoutingConfig(config && typeof config === 'object' ? (config as JarvisConfig) : null);
        const ollama = readConfigSection(config, 'ollama');
        const ollamaUrl = typeof ollama.base_url === 'string' ? ollama.base_url.trim() : '';
        setOllamaBaseUrl(ollamaUrl || null);
        const openrouter = readConfigSection(config, 'openrouter');
        const apiKey = typeof openrouter.api_key === 'string' ? openrouter.api_key.trim() : '';
        setOpenRouterCredential(apiKey ? { phase: 'ready', apiKey } : { phase: 'missing' });
      } catch {
        if (!cancelled) setOpenRouterCredential({ phase: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshProfiles = useCallback(
    async (supersede = false) => {
      if (profileOperationLocked(operationPhase.current) || profileCreatePending.current) return null;
      return loadProfiles(supersede);
    },
    [loadProfiles],
  );

  useEffect(() => {
    void refreshProfiles(true);
  }, [refreshProfiles]);

  const reconcileProfiles = useCallback(async () => {
    const observedList = await loadProfiles(true);
    setReconciliationError(!observedList);
    transition(observedList ? 'observed' : 'read-failed');
  }, [loadProfiles, transition]);

  const retryReconciliation = useCallback(async () => {
    if (operationPhase.current !== 'reconciliation-failed') return;
    transition('retry-read');
    await reconcileProfiles();
  }, [transition, reconcileProfiles]);

  const createProfile = useCallback(async () => {
    if (profileCreatePending.current || profileOperationLocked(operationPhase.current)) return;
    const validation = validateCreateProfileDraft(profileDraft);
    if (!validation.valid) {
      setProfileCreationError('validation');
      setProfileCreationMessage(validation.message);
      return;
    }
    const args: CreateProfileArgs = validation.args;
    profileCreatePending.current = true;
    setCreatingProfile(true);
    setProfileCreateStage('write');
    if (profileCreationError === 'validation') {
      setProfileCreationError(null);
      setProfileCreationMessage(null);
    }
    setPendingDelete(null);
    createdProfileId.current = null;
    invalidateProfiles();
    let stage: 'write' | 'reconciliation' = 'write';
    try {
      const created = await invoke<ModelProfile>('create_profile', args);
      stage = 'reconciliation';
      setProfileCreateStage('readback');
      if (!created || typeof created.id !== 'string' || created.id.length === 0) {
        throw new Error('Missing created profile identity');
      }
      createdProfileId.current = created.id;
      const observedList = await loadProfiles(true);
      if (!observedList?.some((profile) => profile.id === created.id)) {
        setProfileCreationError('reconciliation');
        setProfileCreationMessage(RECONCILIATION_MESSAGE);
        setProfileCreateStage(null);
        setShowProfileForm(false);
        return;
      }
      createdProfileId.current = null;
      setProfileDraft({ ...DEFAULT_MODEL_PROFILE_DRAFT });
      setShowProfileForm(false);
      setProfileCreationError(null);
      setProfileCreationMessage(null);
      setProfileCreateStage(null);
      success(`Created "${args.name}"`);
    } catch {
      setProfileCreateStage(null);
      if (stage === 'write') {
        setProfileCreationError('write');
        setProfileCreationMessage('Could not create profile. Your draft has been kept.');
        setShowProfileForm(true);
      } else {
        setProfileCreationError('reconciliation');
        setProfileCreationMessage(RECONCILIATION_MESSAGE);
        setShowProfileForm(false);
      }
    } finally {
      profileCreatePending.current = false;
      setCreatingProfile(false);
    }
  }, [profileDraft, profileCreationError, invalidateProfiles, loadProfiles, success]);

  const retryProfileReadback = useCallback(async () => {
    if (profileCreationError !== 'reconciliation' || profileCreatePending.current) return;
    const id = createdProfileId.current;
    if (!id) return;
    profileCreatePending.current = true;
    setCreatingProfile(true);
    setProfileCreateStage('readback');
    try {
      const observedList = await loadProfiles(true);
      if (!observedList?.some((profile) => profile.id === id)) {
        setProfileCreationError('reconciliation');
        setProfileCreationMessage(RECONCILIATION_MESSAGE);
        return;
      }
      createdProfileId.current = null;
      setProfileDraft({ ...DEFAULT_MODEL_PROFILE_DRAFT });
      setProfileCreationError(null);
      setProfileCreationMessage(null);
      setProfileCreateStage(null);
      success(`Created "${profileDraft.name.trim()}"`);
    } catch {
      setProfileCreationError('reconciliation');
      setProfileCreationMessage(RECONCILIATION_MESSAGE);
    } finally {
      profileCreatePending.current = false;
      setCreatingProfile(false);
    }
  }, [loadProfiles, profileCreationError, profileDraft.name, success]);

  const mutateProfile = useCallback(
    async (kind: 'activate' | 'delete', profile: ModelProfile) => {
      if (profileOperationLocked(operationPhase.current) || profileCreatePending.current) return;
      transition('submit');
      setOperation({ kind, profile });
      setPendingDelete(null);
      setReconciliationError(false);
      // Fence reads issued before the write, not merely before its readback.
      invalidateProfiles();
      try {
        if (kind === 'activate') {
          const effective = await invoke<EffectiveRuntimeConfig>('set_active_profile', { id: profile.id });
          success(`Activated ${profile.name} · ${effective.provider}/${effective.model}`);
          // Activation projects the profile onto the canonical config. Re-read it
          // so the hero's "Routing backend" describes what was just written; a
          // failed read keeps the last confirmed route rather than inventing one.
          try {
            const config = await invoke<unknown>('jarvis_get_config');
            if (config && typeof config === 'object') setRoutingConfig(config as JarvisConfig);
          } catch {
            /* keep the last confirmed routing identity */
          }
        } else {
          const deleted = await invoke<boolean>('delete_profile', { id: profile.id });
          if (deleted !== true) throw new Error('Deletion not confirmed');
          success(`Deleted ${profile.name}`);
        }
      } catch {
        transition('write-failed');
        return;
      }
      transition('written');
      await reconcileProfiles();
    },
    [transition, invalidateProfiles, success, reconcileProfiles],
  );

  const activate = useCallback((profile: ModelProfile) => mutateProfile('activate', profile), [mutateProfile]);
  const remove = useCallback((profile: ModelProfile) => {
    if (!profileOperationLocked(operationPhase.current) && !profileCreatePending.current) setPendingDelete(profile);
  }, []);
  const confirmDelete = useCallback(async () => {
    if (pendingDelete) await mutateProfile('delete', pendingDelete);
  }, [pendingDelete, mutateProfile]);

  // ── Dialog plumbing ────────────────────────────────────────
  const openCreateDialog = useCallback(
    (prefill?: Partial<ModelProfileDraft>) => {
      if (mutationLocked) return;
      setProfileCreationError(null);
      setProfileCreationMessage(null);
      if (prefill) setProfileDraft({ ...DEFAULT_MODEL_PROFILE_DRAFT, ...prefill });
      setShowProfileForm(true);
    },
    [mutationLocked],
  );

  const closeCreateDialog = useCallback(() => {
    if (profileCreatePending.current) return;
    setShowProfileForm(false);
    setProfileCreationError(null);
    setProfileCreationMessage(null);
  }, []);

  // ── Discovery ──────────────────────────────────────────────
  const discover = useCallback(async () => {
    const requestId = ++discoveryRequest.current;
    setDiscovery('pending');
    try {
      const result = await invoke<unknown>('jarvis_discover_models');
      if (discoveryRequest.current !== requestId) return;
      const models = decodeDiscoveredModels(result);
      setDiscovered((current) => mergeDiscoveredModels(current, models));
      setDiscoverySucceeded(true);
      setDiscovery('idle');
    } catch {
      if (discoveryRequest.current !== requestId) return;
      // Native errors may carry endpoint details; show a fixed sentence.
      setDiscovery('failed');
    }
  }, []);

  const discoverFrom = useCallback(
    async (source: DiscoverySource) => {
      if (sourcePending.current[source]) return;
      const apiKey = openRouterCredential.phase === 'ready' ? openRouterCredential.apiKey : '';
      if (source === 'openrouter' && !apiKey) return;
      sourcePending.current[source] = true;
      const requestId = ++sourceRequests.current[source];
      setSources((current) => ({ ...current, [source]: 'pending' }));
      try {
        let result: unknown;
        if (source === 'ollama') {
          // `base_url` is optional: omit it and the native side falls back to OLLAMA_BASE_URL.
          result = await invoke<unknown>(DISCOVERY_COMMANDS.ollama, ollamaBaseUrl ? { baseUrl: ollamaBaseUrl } : {});
        } else {
          result = await invoke<unknown>(DISCOVERY_COMMANDS.openrouter, { apiKey });
        }
        if (sourceRequests.current[source] !== requestId) return;
        const models = decodeDiscoveredModels(result);
        setDiscovered((current) => mergeDiscoveredModels(current, models));
        setDiscoverySucceeded(true);
        setSources((current) => ({ ...current, [source]: 'idle' }));
      } catch {
        if (sourceRequests.current[source] !== requestId) return;
        // Native errors may carry endpoint or key details; show a fixed sentence.
        setSources((current) => ({ ...current, [source]: 'failed' }));
      } finally {
        if (sourceRequests.current[source] === requestId) sourcePending.current[source] = false;
      }
    },
    [ollamaBaseUrl, openRouterCredential],
  );

  const discovering = discovery === 'pending';
  const openRouterReason =
    openRouterCredential.phase === 'loading'
      ? 'Checking whether an OpenRouter key is configured…'
      : openRouterCredential.phase === 'missing'
        ? 'Add an OpenRouter API key in Settings to discover OpenRouter models.'
        : openRouterCredential.phase === 'unavailable'
          ? 'Could not read the OpenRouter key from Settings. Reload to try again.'
          : null;

  // ── Feedback ───────────────────────────────────────────────
  const creationFeedbackActive = creatingProfile || profileCreationError !== null;
  const creationFeedback: ReactNode = (
    <>
      {creatingProfile && (
        <StatusLine label="Profile creation">
          {profileCreateStage === 'readback' ? 'Refreshing profile list…' : 'Creating profile…'}
        </StatusLine>
      )}
      {profileCreationError === 'validation' && <AlertLine label="Profile creation">{profileCreationMessage}</AlertLine>}
      {profileCreationError === 'write' && (
        <AlertLine label="Profile creation" onRetry={() => void createProfile()} retryText="Retry profile creation" retryDisabled={creatingProfile}>
          {profileCreationMessage}
        </AlertLine>
      )}
      {profileCreationError === 'reconciliation' && (
        <AlertLine label="Profile reconciliation" onRetry={() => void retryProfileReadback()} retryText="Retry profile list" retryDisabled={creatingProfile}>
          {profileCreationMessage}
        </AlertLine>
      )}
    </>
  );

  return (
    <Page>
      <ConfirmModal
        open={pendingDelete !== null}
        message={`Delete profile "${pendingDelete?.name}"?`}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
      <ProfileCreateDialog
        open={showProfileForm}
        draft={profileDraft}
        onDraftChange={(patch) => setProfileDraft((current) => ({ ...current, ...patch }))}
        creating={creatingProfile}
        onSubmit={() => void createProfile()}
        onClose={closeCreateDialog}
        feedback={creationFeedbackActive ? creationFeedback : null}
      />

      <PageHeader
        eyebrow="Build"
        title="Inference"
        description="Model profiles for Session turns. Inference backends are chosen in Settings."
        actions={
          <>
            <Button
              variant="ghost"
              icon={<RefreshCw />}
              onClick={() => {
                if (!profileResource.loading && !creatingProfile) void refreshProfiles(true);
              }}
              disabled={profileResource.loading || creatingProfile}
            >
              Refresh
            </Button>
            <Button variant="ghost" icon={<Settings2 />} onClick={() => navigate('settings')}>
              Backend settings
            </Button>
            <Button variant="secondary" icon={<Compass />} busy={discovering} disabled={discovering} onClick={() => void discover()}>
              {discovering ? 'Discovering…' : 'Discover models'}
            </Button>
            <Button variant="primary" icon={<Plus />} onClick={() => openCreateDialog()} disabled={mutationLocked}>
              New profile
            </Button>
          </>
        }
      />

      <div className="space-y-2 empty:hidden">
        {!mutationLocked && (
          <>
            {profileResource.loading && (
              <StatusLine label="Profiles observation">
                {profileResource.snapshot === null ? 'Loading' : 'Refreshing'} Profiles…
              </StatusLine>
            )}
            {profileResource.error && (
              <AlertLine
                label="Profiles observation"
                onRetry={() => void refreshProfiles()}
                retryText="Retry Profiles"
                retryDisabled={profileResource.loading}
              >
                Could not load Profiles.
                {profileResource.snapshot !== null && ' Showing previously observed data; it may be stale.'}
              </AlertLine>
            )}
          </>
        )}
        {!showProfileForm && creationFeedbackActive && creationFeedback}
        {(phase === 'writing' || phase === 'reconciling') && (
          <StatusLine label="Profile operation">
            {phase === 'writing' ? `${operation?.kind === 'activate' ? 'Activating' : 'Deleting'} ${operation?.profile.name}…` : 'Reconciling profiles…'}
            {' Showing previously observed profiles; they may be stale.'}
          </StatusLine>
        )}
        {phase === 'write-failed' && operation && (
          <AlertLine
            label="Profile operation"
            onRetry={() => (operation.kind === 'activate' ? void activate(operation.profile) : remove(operation.profile))}
            retryText={`Retry ${operation.kind === 'activate' ? 'activation' : 'deletion'}`}
          >
            Could not {operation.kind} {operation.profile.name}. Showing last confirmed profiles.
          </AlertLine>
        )}
        {reconciliationError && (
          <AlertLine
            label="Profile operation"
            onRetry={() => void retryReconciliation()}
            retryText="Retry profile reconciliation"
            retryDisabled={phase === 'reconciling'}
          >
            Profile write succeeded, but reconciliation failed. Showing previously observed profiles; they may be stale.
          </AlertLine>
        )}
      </div>

      <section aria-label="Model discovery" className="mt-6 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            icon={<Server />}
            busy={sources.ollama === 'pending'}
            disabled={sources.ollama === 'pending'}
            onClick={() => void discoverFrom('ollama')}
          >
            {sources.ollama === 'pending' ? 'Discovering from Ollama…' : 'Discover from Ollama'}
          </Button>
          <Button
            variant="secondary"
            icon={<Globe />}
            busy={sources.openrouter === 'pending'}
            disabled={sources.openrouter === 'pending' || openRouterReason !== null}
            aria-describedby={openRouterReason !== null ? discoveryReasonId : undefined}
            onClick={() => void discoverFrom('openrouter')}
          >
            {sources.openrouter === 'pending' ? 'Discovering from OpenRouter…' : 'Discover from OpenRouter'}
          </Button>
          {openRouterReason !== null && (
            <p id={discoveryReasonId} className="text-[11.5px] text-ink-3">
              {openRouterReason}
            </p>
          )}
        </div>
        {discovery === 'pending' && <StatusLine label="Model discovery">Discovering models…</StatusLine>}
        {discovery === 'failed' && (
          <AlertLine label="Model discovery" onRetry={() => void discover()} retryText="Retry discovery">
            Could not discover models. Check that an Inference backend is running.
          </AlertLine>
        )}
        {sources.ollama === 'pending' && (
          <StatusLine label="Ollama discovery">Contacting Ollama for its model list…</StatusLine>
        )}
        {sources.ollama === 'failed' && (
          <AlertLine label="Ollama discovery" onRetry={() => void discoverFrom('ollama')} retryText="Retry Ollama discovery">
            Could not discover models from Ollama. Check that Ollama is running.
          </AlertLine>
        )}
        {sources.openrouter === 'pending' && (
          <StatusLine label="OpenRouter discovery">Contacting OpenRouter for its model list…</StatusLine>
        )}
        {sources.openrouter === 'failed' && (
          <AlertLine
            label="OpenRouter discovery"
            onRetry={() => void discoverFrom('openrouter')}
            retryText="Retry OpenRouter discovery"
          >
            Could not discover models from OpenRouter. Check the OpenRouter key in Settings.
          </AlertLine>
        )}
        {discoverySucceeded && (
          <DiscoveredModels
            models={discovered}
            disabled={mutationLocked}
            onCreate={(m) => openCreateDialog({ name: m.name, backend: m.provider, model: m.id })}
          />
        )}
      </section>

      <div className="mt-6 space-y-8">
        {observed && profiles.length === 0 ? (
          <EmptyState
            title="No model profiles configured."
            description="A profile pins a model and its sampling settings. Create one, or discover what your backends can already reach."
            action={
              <Button variant="primary" icon={<Plus />} onClick={() => openCreateDialog()} disabled={mutationLocked}>
                Create a profile
              </Button>
            }
          />
        ) : (
          <>
            <ActiveProfileHero
              profile={activeProfile}
              observed={observed}
              routing={projectRoutingIdentity(routingConfig, activeProfile)}
              locked={mutationLocked}
              onDelete={remove}
            />

            {otherProfiles.length > 0 && (
              <section aria-label="Other profiles">
                <div className="mb-3 flex items-baseline gap-2">
                  <h2 className="d-label">Saved profiles</h2>
                  <span className="font-mono text-[11px] text-ink-4 tabular">{otherProfiles.length}</span>
                </div>
                <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {otherProfiles.map((profile) => (
                    <ProfileCard key={profile.id} profile={profile} locked={mutationLocked} onActivate={activate} onDelete={remove} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </Page>
  );
}
