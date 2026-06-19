import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { cn, GlassCard, StatusDot, Pill, SectionHeader, EmptyState, ErrorState, LoadingState, AnimatedList, AnimatedGrid, useToast } from '../ui';
interface CronJob {
  id: string;
  name: string;
  schedule: string;
  agent_id: string;
  session_id: string | null;
  prompt: string;
  enabled: boolean;
  last_run: string | null;
  next_run: string | null;
  run_count: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface CronRun {
  id: string;
  cron_job_id: string;
  status: string;
  output: string;
  error: string;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface LearningEntry {
  id: string;
  filename: string;
  title: string;
  topic: string;
  date: string;
  actionable: boolean;
  credibility_gate: string;
  source_count: number;
}

interface MemoryDelta {
  id: string;
  title: string;
  content: string;
  category: string;
  importance: string
  cr