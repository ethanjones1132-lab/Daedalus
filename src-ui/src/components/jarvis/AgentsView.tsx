import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PageTransition,
  AnimatedList,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  ErrorState,
  EmptyState,
  cn,
} from '../ui';

// ── Types ──

interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  backend: string;
  system_prompt: string;
  enabled: boolean;
  config: string | null;
  created_at: string;
  updated_at: string;
}

interface Channel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

// ── Helpers ──

function getBoundChannelIds(agent: Agent): string[] {
  if (!agent.config) return [];
  try {
    const parsed = JSON.parse(agent.config);
    if (Array.isArray(parsed.channels)) {
      return parsed.channels.filter((c: unknown) => typeof c === 'string');
    }
  } catch {
    // ignore
  }
  return [];
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 0) return 'just now';
    const s = Math.floor(diff / 1000);
    const m = Math.floor(s / 60);
    const