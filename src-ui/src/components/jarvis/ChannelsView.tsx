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

interface Channel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  last_used: string | null;
  connected: boolean;
  created_at: string;
  updated_at: string;
}

const CHANNEL_TYPES = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'signal', label: 'Signal' },
  { value: 'email', label: 'Email' },
  { value: 'http', label: 'HTTP Endpoint' },
  { value: 'websocket', label: 'WebSocket' },
];

function formatTimestamp(ts: string | null): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 0) return 'just now';
    const s = Math.floor(diff / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const days = Math.floor(h / 24);
    if (days > 0) return `${days}d $