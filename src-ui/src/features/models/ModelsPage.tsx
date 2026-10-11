import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Compass, Plus, RefreshCw, Settings2 } from 'lucide-react';
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
import { useNavigation } from '../../shell/navigation';
import { DiscoveredModels } from './DiscoveredModels';
import { ProfileCreateDialog } from './ProfileCreateDialog';
import { ActiveProfileHero, ProfileCard } from './ProfileViews';
import type { DiscoveredModel, EffectiveRuntimeConfig, ModelProfile } from './types';
import { useObservedResource } from './useObservedResource';

type CreationError = 'validation' | 'write' | 'reconciliation' | null;
type DiscoveryState =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'failed' }
  | { phase: 'done'; models: DiscoveredModel[] };

const RECONCILIATION_MESSAGE = 'Profile created, but the profile list did not confirm it. Retry reloads the list only.';

function isDiscoveredModel(value: unknown): value is DiscoveredModel {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.provider === 'string';
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
  const [discovery, setDiscovery] = useState<DiscoveryState>({ phase: 'idle' });
  const discoveryRequest = useRef(0);

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
    setDiscovery({ phase: 'pending' });
    try {
      const result = await invoke<unknown>('jarvis_discover_models');
      if (discoveryRequest.current !== requestId) return;
      if (!Array.isArray(result)) throw new Error('Unexpected discovery payload');
      setDiscovery({ phase: 'done', models: result.filter(isDiscoveredModel) });
    } catch {
      if (discoveryRequest.current !== requestId) return;
      // Native errors may carry endpoint details; show a fixed sentence.
      setDiscovery({ phase: 'failed' });
    }
  }, []);

  const discovering = discovery.phase === 'pending';

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
            <ActiveProfileHero profile={activeProfile} observed={observed} locked={mutationLocked} onDelete={remove} />

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

        {discovery.phase !== 'idle' && (
          <section aria-label="Model discovery" className="space-y-2">
            {discovery.phase === 'pending' && <StatusLine label="Model discovery">Discovering models…</StatusLine>}
            {discovery.phase === 'failed' && (
              <AlertLine label="Model discovery" onRetry={() => void discover()} retryText="Retry discovery">
                Could not discover models. Check that an Inference backend is running.
              </AlertLine>
            )}
            {discovery.phase === 'done' && (
              <DiscoveredModels
                models={discovery.models}
                disabled={mutationLocked}
                onCreate={(m) => openCreateDialog({ name: m.name, backend: m.provider, model: m.id })}
              />
            )}
          </section>
        )}
      </div>
    </Page>
  );
}
