import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PageTransition,
  AnimatedGrid,
  GlassCard,
  Pill,
  SectionHeader,
  LoadingState,
  ErrorState,
  EmptyState,
  cn,
  useToast,
} from '../ui';

// ── Types ──

interface Skill {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  metadata: string | null;
  body: string;
  version: number;
  last_improved_at?: string | null;
  improvement_score: number;
  created_at: string;
  updated_at: string;
}

interface SkillRevision {
  id: string;
  skill_id: string;
  version: number;
  body_before: string;
  body_after: string;
  change_reason: string;
  source_session_id?: string | null;
  created_at: string;
}

interface InvokeModalProps {
  skill: Skill;
  onClose: () => void;
  onInvoke: (skill: Skill, args: string) => void;
}

// ── Invoke Modal ──

function InvokeModal({ skill, onClose, onInvoke }: InvokeModalProps) {
  const [args, setArgs] = useState('{}');

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 