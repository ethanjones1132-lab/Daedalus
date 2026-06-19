import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  PageTransition,
  AnimatedList,
  GlassCard,
  StatusDot,
  Pill,
  SectionHeader,
  LoadingState,
  ErrorState,
  useToast,
} from '../ui';

interface Approval {
  id: string;
  request_type: string;
  description: string;
  agent_id: string;
  created_at: string;
  status: string;
  tool_name?: string;
  tool_args?: string;
}

export default function ApprovalsView() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<Set<string>>(new Set());

  const fetchApprovals = useCallback(async () => {
    try {
      const r = await invoke<Approval[]>('get_approvals');
      setApprovals(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchApprovals(); }, [fetchApprovals]);

  const { success, error: toastError } = useToast();

  const handleApprove = async (id: string) => {
    setActing(prev => new Set(prev).add(id));
    try {
      await invoke('approve_request', { id });
      success('Request approved su
      await fetchApprovals();
    } catch (e) {
      toastError(`Failed to approve request: ${e}`, 'Approval Error');
      console.error('Failed to approve:', e);
    } finally {
      setActing(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  const handleReject = async (id: string) => {
    setActing(prev => new Set(prev).add(id));
    try {
      await invoke('reject_request', { id });
      success('Request rejected successfully.', 'Approval Action');
      await fetchApprovals();
    } catch (e) {
      toastError(`Failed to reject request: ${e}`, 'Approval Error');
      console.error('Failed to reject:', e);
    } finally {
      setActing(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  return (