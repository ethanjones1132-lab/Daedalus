import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { cn, GlassCard, LoadingState, ErrorState, EmptyState, useToast } from '../ui';

interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  tags: string;
  category: string;
  created_at: string;
  updated_at: string;
  relevance_score: number;
  agent_id: string;
  source: string;
  source_session_id?: string | null;
  source_message_ids: string;
  confidence: number;
  last_used_at?: string | null;
  usage_count: number;
  expires_at?: string | null;
  review_after?: string | null;
  status: 'active' | 'tombstoned' | string;
  supersedes_id?: string | null;
  metadata?: string | null;
}

interface MemoryEvent {
  id: string;
  memory_id?: string | null;
  event_type: string;
  actor: string;
  reason: string;
  confidence: number;
  session_id?: string | null;
  created_at: string;
}

interface MemoryRun {
  id: string;
  kind: string;
  status: string;
  scanned_count: number;
  changed_count: number;
  blocked_count: number;
  error: string;
  started_at: string;
  finished_at?: string | null;
}

interface MemoryRecall {
  memory: MemoryEntry;
  score: number;
  matched_terms: string[];
}

interfac