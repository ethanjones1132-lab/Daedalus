import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  PageTransition,
  GlassCard,
  StatusDot,
  Pill,
  SectionHeader,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';

interface GatewayStatus {
  bridge: { running: boolean; port: number; url: string };
  bun_server: { running: boolean; port: number; url: string };
  overall: string;
  claude_settings_optimized: boolean;
  timestamp: string;
}

interface HealthData {
  ollama: { running: boolean; model: string | null; url: string };
  bun_server: { running: boolean; url: string };
  bridge: { running: boolean; port: number };
  disk: { total: string; used: string; available: string; use_percent: string };
  memory: { total_mb: number; available_mb: number; used_mb: number; used_percent: number };
  timestamp: string;
}

export default function GatewayView() {
  const { error: toastError } = useToast();
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [bridgeMsg, setBridgeMsg] 
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

    try {
      await fetchStatus();
    } finally {
      set