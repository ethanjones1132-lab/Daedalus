import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../ui';
import type { JarvisStatus, JarvisConfig } from './types';
import { RECOMMENDED_OLLAMA_MODELS } from './types';

// ── Helpers ──

type ConnStatus = 'connected' | 'slow' | 'disconnected';

function getStatusColor(status: ConnStatus): string {
  switch (status) {
    case 'connected': return 'bg-emerald-400';
    case 'slow': return 'bg-amber-400';
    case 'disconnected': return 'bg-red-400';
  }
}

function getStatusGlow(status: ConnStatus): string {
  switch (status) {
    case 'connected': return 'shadow-[0_0_6px_rgba(52,211,153,0.5)]';
    case 'slow': return 'shadow-[0_0_6px_rgba(251,191,36,0.5)]';
    case 'disconnected': return 'shadow-[0_0_6px_rgba(248,113,113,0.5)]';
  }
}

function getStatusLabel(status: ConnStatus): string {
  switch (status) {
    case 'connected': return 'Connected';
    case 'slow': return 'Slow';
    case 'disconnected': return 'Disconnected';
  }
}

// ── Component ──

export default function HealthBanner() {
  const [status, setStatus] = useState<JarvisStatus | null>(null);
  const [config, setConfig] = useState<JarvisConfig | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = 
    try {
      const result = await invoke<Jar