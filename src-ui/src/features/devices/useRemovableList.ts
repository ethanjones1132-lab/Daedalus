import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../design';
import { reconcileRemovals, removalLocked, type RemovalOperation } from '../../domain/removal-state';

/*
 * Shared lifecycle for the two store-backed CRUD lists in Connect (Devices,
 * Nodes): request-id fenced reads, a synchronous create guard, and the
 * confirmed removal state machine (writing -> reconciling -> reconciled, or
 * write-failed / read-failed with a retry that never repeats a settled write).
 */

export interface RemovableRow {
  id: string;
  name: string;
}

export interface RemovableListConfig {
  listCommand: string;
  removeCommand: string;
}

export function useRemovableList<T extends RemovableRow>({ listCommand, removeCommand }: RemovableListConfig) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<T | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const [operations, setOperations] = useState<Record<string, RemovalOperation<T>>>({});
  const createPending = useRef(false);
  const operationsRef = useRef(operations);
  const requestId = useRef(0);
  const reading = useRef(false);
  const { success } = useToast();

  const publishOperations = useCallback((next: Record<string, RemovalOperation<T>>) => {
    operationsRef.current = next;
    setOperations(next);
  }, []);

  const fetchRows = useCallback(
    async (opts?: { removalRead?: boolean }) => {
      const request = ++requestId.current;
      reading.current = true;
      setLoading(true);
      setError(null);
      try {
        const snapshot = await invoke<T[]>(listCommand);
        if (request !== requestId.current) return;
        const result = reconcileRemovals(snapshot, operationsRef.current, request);
        publishOperations(result.operations);
        setRows(result.rows);
        setLoaded(true);
      } catch (e) {
        if (request !== requestId.current) return;
        const next = { ...operationsRef.current };
        let removalFailure = false;
        for (const [id, operation] of Object.entries(next)) {
          if (operation.phase === 'reconciling' || operation.phase === 'read-failed') {
            next[id] = { ...operation, phase: 'read-failed' };
            removalFailure = true;
          }
        }
        publishOperations(next);
        if (!opts?.removalRead || !removalFailure) setError(String(e));
      } finally {
        if (request === requestId.current) {
          reading.current = false;
          setLoading(false);
        }
      }
    },
    [listCommand, publishOperations],
  );

  const retryRead = useCallback(() => {
    if (reading.current) return;
    void fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  /**
   * Run one creation. `perform` issues the native write; `reset` clears the
   * draft after a confirmed write (before the readback, so a failed readback
   * never reads as a failed creation).
   */
  const create = useCallback(
    async (perform: () => Promise<unknown>, successMessage: string, reset: () => void) => {
      if (createPending.current) return;
      createPending.current = true;
      setCreating(true);
      setCreateError(false);
      try {
        await perform();
        success(successMessage);
        reset();
        await fetchRows();
      } catch {
        setCreateError(true);
      } finally {
        createPending.current = false;
        setCreating(false);
      }
    },
    [fetchRows, success],
  );

  const remove = useCallback((row: T) => {
    if (!removalLocked(operationsRef.current[row.id])) setPendingDelete(row);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || removalLocked(operationsRef.current[pendingDelete.id])) return;
    const row = rows.find((candidate) => candidate.id === pendingDelete.id);
    if (!row) {
      setPendingDelete(null);
      return;
    }
    const operation: RemovalOperation<T> = { row, phase: 'writing', after: requestId.current };
    publishOperations({ ...operationsRef.current, [row.id]: operation });
    try {
      const removed = await invoke<boolean>(removeCommand, { id: row.id });
      if (removed !== true) throw new Error('Removal not confirmed');
      success(`Removed ${row.name}`);
      publishOperations({
        ...operationsRef.current,
        [row.id]: { ...operation, phase: 'reconciling', after: requestId.current },
      });
      setPendingDelete((current) => (current?.id === row.id ? null : current));
      await fetchRows({ removalRead: true });
    } catch {
      publishOperations({
        ...operationsRef.current,
        [row.id]: { ...operation, phase: 'write-failed', after: requestId.current },
      });
      setPendingDelete((current) => (current?.id === row.id ? null : current));
    }
  }, [fetchRows, pendingDelete, publishOperations, removeCommand, rows, success]);

  const cancelDelete = useCallback(() => {
    const operation = pendingDelete ? operationsRef.current[pendingDelete.id] : undefined;
    if (operation?.phase === 'writing') return;
    setPendingDelete(null);
  }, [pendingDelete]);

  const deleteOperation = pendingDelete ? operations[pendingDelete.id] : undefined;
  const deleting = deleteOperation?.phase === 'writing';

  return {
    rows,
    loading,
    loaded,
    error,
    operations,
    pendingDelete,
    deleting,
    creating,
    createError,
    fetchRows,
    retryRead,
    create,
    remove,
    confirmDelete,
    cancelDelete,
  };
}
