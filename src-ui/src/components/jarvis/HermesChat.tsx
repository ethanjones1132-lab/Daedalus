import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  useHermesChat,
  useHermesSessions,
  useHermesStatus,
  hermesSpawn,
  hermesRestart,
} from '../../lib/hermes';
import { HermesApprovalModal } from './HermesApprovalModal';
import { cn, GlassCard, StatusDot, Pill } from '../ui';

const stateLabel = (s: string) =>
  s === 'ready' ? 'ready' : s === 'starting' ? 'starting…' : s === 'cold' ? 'cold' : s;

const statePillVariant = (s: string): 'success' | 'info' | 'error' | 'default' =>
  s === 'ready' ? 'success' : s === 'starting' ? 'info' : s === 'crashed' ? 'error' : 'default';

export function HermesChat() {
  const status = useHermesStatus();
  const { refresh, create, resume } = useHermesSessions();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const { messages, submit, interrupt, isStreaming } = useHermesChat(sessionId);
  const [input, setInput] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (status.state === 'cold') {
      hermesSpawn().catch((e) => console.error('[hermes] spawn failed:', e));
    }
  }, [status.state]);

  useEffect(() => {
    if (status.state !== 'ready') return;
    let cancelled = false;
    (async () => {
      const nextSessions = await refresh