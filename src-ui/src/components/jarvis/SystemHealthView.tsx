import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PageTransition,
  GlassCard,
  StatusDot,
  Pill,
  SectionHeader,
  ProgressBar,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';

interface HealthData {
  ollama: { running: boolean; model: string | null; url: string };
  bun_server: { running: boolean; url: string };
  bridge: { running: boolean; port: number };
  claude_proxy: { running: boolean; port: number };
  disk: { total: string; used: string; available: string; use_percent: string };
  memory: { total_mb: number; available_mb: number; used_mb: number; used_percent: number };
  timestamp: string;
}

interface DoctorCheck {
  name: string;
  status: string;
  detail: string;
}

interface DoctorReport {
  checks: DoctorCheck[];
  summary: { total: number; ok: number; warn: number; error: number; overall: string };
  timestamp: string;
}

export default function SystemHealthView() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [s