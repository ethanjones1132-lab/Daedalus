import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '../../design';
import {
  skillCandidateMutationConfirmed,
  skillCandidateMutationLocked,
  startSkillCandidateMutation,
  transitionSkillCandidateMutation,
  type SkillCandidateAction,
  type SkillCandidateMutation,
} from '../../domain/skill-candidate-operation-state';
import { applySkillListRead, confirmSkillToggle, type SkillToggleProtection } from '../../domain/skill-toggle-state';
import { useSkillObservation } from './skill-hooks';
import {
  isDistilledSkill,
  postSkillCandidateAction,
  readCandidates,
  readRuntimeSkills,
  readRuntimeTools,
  type Skill,
} from './skill-model';

/**
 * All Skills-surface state: the native skill list (with confirmed, fenced
 * toggles), the three optional observations, and the distilled-candidate
 * lifecycle state machine. The page only renders.
 */
export function useSkillsController() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const pendingToggles = useRef(new Set<string>());
  const [togglePending, setTogglePending] = useState<Record<string, boolean>>({});
  const [toggleError, setToggleError] = useState<Record<string, boolean>>({});
  const protections = useRef<Record<string, SkillToggleProtection<boolean>>>({});
  const candidateMutationRef = useRef<Record<string, SkillCandidateMutation | undefined>>({});
  const [candidateMutations, setCandidateMutations] = useState<Record<string, SkillCandidateMutation | undefined>>({});
  const nextCandidateMutationToken = useRef(0);
  const listReadId = useRef(0);
  const { state: runtimeSkills, refresh: refreshRuntimeSkills } = useSkillObservation(readRuntimeSkills);
  const { state: runtimeTools, refresh: refreshRuntimeTools } = useSkillObservation(readRuntimeTools);
  const { state: candidateState, refresh: refreshCandidates, current: candidatesCurrent } = useSkillObservation(readCandidates);
  const candidates = candidateState.snapshot;
  const candidateCurrent = candidates !== null && !candidateState.loading && !candidateState.error;
  const canUseCandidate = useCallback(() => candidatesCurrent.current, [candidatesCurrent]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { success } = useToast();

  const publishCandidateMutation = useCallback((candidateId: string, mutation: SkillCandidateMutation | null) => {
    candidateMutationRef.current[candidateId] = mutation ?? undefined;
    setCandidateMutations((previous) => {
      const next = { ...previous };
      if (mutation) next[candidateId] = mutation;
      else delete next[candidateId];
      return next;
    });
  }, []);

  const fetchSkills = useCallback(
    async (includeCandidates = true) => {
      const readId = ++listReadId.current;
      void refreshRuntimeSkills();
      void refreshRuntimeTools();
      if (includeCandidates) void refreshCandidates();
      setLoading(true);
      setError(null);
      try {
        try {
          await invoke<number>('sync_distilled_skill_candidates');
        } catch {
          /* Bun may not have written candidates yet */
        }
        const list = await invoke<Skill[]>('list_skills');
        if (readId !== listReadId.current) return;
        const reconciled = applySkillListRead(list, protections.current, readId);
        protections.current = reconciled.protections;
        setSkills(reconciled.skills);
      } catch (e) {
        if (readId === listReadId.current) setError(String(e));
      } finally {
        if (readId === listReadId.current) setLoading(false);
      }
    },
    [refreshRuntimeSkills, refreshRuntimeTools, refreshCandidates],
  );

  useEffect(() => {
    void fetchSkills();
  }, [fetchSkills]);

  const toggle = useCallback(
    async (skill: Skill) => {
      if (isDistilledSkill(skill) || pendingToggles.current.has(skill.id)) return;
      pendingToggles.current.add(skill.id);
      setTogglePending((prev) => ({ ...prev, [skill.id]: true }));
      const next = !skill.enabled;
      // Concurrent reads must not publish an in-flight write as confirmed.
      protections.current[skill.id] = { target: skill.enabled, barrierReadId: Infinity };
      try {
        await invoke<void>(next ? 'enable_skill' : 'disable_skill', { name: skill.name });
        protections.current[skill.id] = { target: next, barrierReadId: listReadId.current };
        setSkills((prev) => confirmSkillToggle(prev, skill.id, next));
        setToggleError((prev) => ({ ...prev, [skill.id]: false }));
        success(`${next ? 'Enabled' : 'Disabled'} ${skill.name}`);
      } catch {
        protections.current[skill.id] = { target: skill.enabled, barrierReadId: listReadId.current };
        setToggleError((prev) => ({ ...prev, [skill.id]: true }));
      } finally {
        pendingToggles.current.delete(skill.id);
        setTogglePending((prev) => ({ ...prev, [skill.id]: false }));
      }
    },
    [success],
  );

  const runCandidateAction = useCallback(
    async (skillName: string, candidateId: string, action: SkillCandidateAction) => {
      if (!canUseCandidate()) return;
      const observed = candidates?.[candidateId];
      if (!observed) return;
      const existing = candidateMutationRef.current[candidateId];
      if (skillCandidateMutationLocked(existing)) return;
      const token = ++nextCandidateMutationToken.current;
      const mutation = startSkillCandidateMutation(candidateId, action, observed.lifecycle_version ?? 0, token, observed.status);
      publishCandidateMutation(candidateId, mutation);
      const isCurrent = () => candidateMutationRef.current[candidateId]?.token === token;
      const response = await postSkillCandidateAction(candidateId, action, mutation.expectedVersion);
      if (!isCurrent()) return;
      if (!response.ok) {
        if (response.status === 400) {
          publishCandidateMutation(candidateId, transitionSkillCandidateMutation(mutation, 'write-failed'));
          return;
        }
        const reconciling = transitionSkillCandidateMutation(mutation, 'conflict');
        if (!reconciling) return;
        publishCandidateMutation(candidateId, reconciling);
        const snapshot = await refreshCandidates();
        if (!isCurrent()) return;
        const authoritative = snapshot?.[candidateId];
        if (snapshot && authoritative && skillCandidateMutationConfirmed(reconciling, authoritative)) {
          publishCandidateMutation(candidateId, null);
          success(
            `${authoritative.status === 'promoted' ? 'Promoted' : authoritative.status === 'rejected' ? 'Rejected' : action === 'eval' ? 'Evaluated' : 'Updated'} ${skillName}`,
          );
        } else {
          publishCandidateMutation(candidateId, transitionSkillCandidateMutation(reconciling, 'read-failed'));
        }
        return;
      }
      const reconciling = transitionSkillCandidateMutation(mutation, 'write-succeeded');
      if (!reconciling) return;
      publishCandidateMutation(candidateId, reconciling);
      const snapshot = await refreshCandidates();
      if (!isCurrent()) return;
      const authoritative = snapshot?.[candidateId];
      if (!snapshot || !authoritative || !skillCandidateMutationConfirmed(reconciling, authoritative)) {
        publishCandidateMutation(candidateId, transitionSkillCandidateMutation(reconciling, 'read-failed'));
        return;
      }
      publishCandidateMutation(candidateId, null);
      const outcome = authoritative.status === 'promoted' ? 'Promoted' : authoritative.status === 'rejected' ? 'Rejected' : 'Evaluated';
      success(`${outcome} ${skillName}`);
      void fetchSkills(false);
    },
    [candidates, canUseCandidate, fetchSkills, publishCandidateMutation, refreshCandidates, success],
  );

  const retryCandidateMutation = useCallback(
    async (skillName: string, candidateId: string) => {
      const mutation = candidateMutationRef.current[candidateId];
      if (!mutation) return;
      if (mutation.phase === 'write-failed') {
        await runCandidateAction(skillName, candidateId, mutation.action);
        return;
      }
      if (mutation.phase !== 'read-failed') return;
      const reconciling = transitionSkillCandidateMutation(mutation, 'retry-read');
      if (!reconciling) return;
      publishCandidateMutation(candidateId, reconciling);
      const token = reconciling.token;
      const snapshot = await refreshCandidates();
      if (candidateMutationRef.current[candidateId]?.token !== token) return;
      const authoritative = snapshot?.[candidateId];
      if (!snapshot || !authoritative || !skillCandidateMutationConfirmed(reconciling, authoritative)) {
        publishCandidateMutation(candidateId, transitionSkillCandidateMutation(reconciling, 'read-failed'));
        return;
      }
      publishCandidateMutation(candidateId, null);
      const outcome = authoritative.status === 'promoted' ? 'Promoted' : authoritative.status === 'rejected' ? 'Rejected' : 'Evaluated';
      success(`${outcome} ${skillName}`);
      void fetchSkills(false);
    },
    [fetchSkills, publishCandidateMutation, refreshCandidates, runCandidateAction, success],
  );

  return {
    skills,
    loading,
    error,
    togglePending,
    toggleError,
    toggle,
    fetchSkills,
    runtimeSkills,
    runtimeTools,
    candidateState,
    candidates,
    candidateCurrent,
    candidateMutations,
    refreshRuntimeSkills,
    refreshRuntimeTools,
    refreshCandidates,
    runCandidateAction,
    retryCandidateMutation,
  };
}
