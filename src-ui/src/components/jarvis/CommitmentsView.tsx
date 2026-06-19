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

interface Commitment {
  id: string;
  text: string;
  status: string;
  due?: string;
  created_at: string;
  completed_at?: string;
  agent_id?: string;
}

export default function CommitmentsView() {
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState('');
  const [newDue, setNewDue] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchCommitments = useCallback(async () => {
    try {
      const r = await invoke<Commitment[]>('get_commitments');
      setCommitments(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCommitments(); }, [fetchCommitments]);

  const { success, error: toastError } = useToast();

  const handleAdd = async () => {
    if (!newText.trim()) return;
    setAdding(true);
    const textVal = newText.trim(