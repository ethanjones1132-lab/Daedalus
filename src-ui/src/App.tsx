import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PageTransition,
  AnimatedGrid,
  AnimatedList,
  GlassCard,
  StatusDot,
  Pill,
  SectionHeader,
  ProgressBar,
  SidebarNavItem,
  LoadingState,
  ErrorState,
  EmptyState,
  ErrorBoundary,
  cn,
  ToastProvider,
  useToast,
  TiltCard,
  MetricBlock,
  AnimatedNumber,
  Label,
} from './components/ui';
import { usePolling } from './hooks/usePolling';
import MarkdownRenderer from './components/jarvis/MarkdownRenderer';
import type { BackendSession, NavSection, SessionMessage, ViewId } from './types';
import type { CompanionRarity, CompanionSpecies, CompanionState } from './components/jarvis/types';
import JarvisView from './components/jarvis/JarvisView';
import MemoryView from './components/jarvis/MemoryView';
import { MythosCompanionSprite } from './components/jarvis/MythosCompanionSprite';
import HealthBanner from './components/jarvis/HealthBanner';
import SkillsView from './components/jarvis/SkillsView';
import ChannelsView from './components/jarvis/ChannelsView';
import CronView from './components/jarvis/CronView';
import AgentsView from './components/jarvis/AgentsView';
import ActionRegistryView from './components/jarvis/ActionRegistryView';
import DevicesView from './components/jarvis/DevicesView';
import NodesView from './components/jarvis/NodesView';
import HooksView from './components/jarvis/HooksView';
import CommitmentsView from './components/jarvis/CommitmentsView';
import ApprovalsView from './components/jarvis/ApprovalsView';
import PluginsView from './components/jarvis/PluginsView';
import GatewayView from './components/jarvis/GatewayView';

const APP_VERSION = '3.0.0';

const NAV_SECTIONS: NavSection[] = [
  { title: 'JARVIS', items: [{ id: 'jarvis', label: 'Jarvis', icon: 'J' }] },
  { title: 'CHAT', items: [{ id: 'chat-feeds', label: 'Chats', icon: 'C' }] },
  {
    title: 'CONTROL',
    items: [
      { id: 'overview', label: 'Overview', icon: 'O' },
      { id: 'sessions', label: 'Sessions', icon: 'S' },
      { id: 'cron', label: 'Cron', icon: 'T' },
      { id: 'action-registry', label: 'Actions', icon: 'R' },
      { id: 'channels', label: 'Channels', icon: 'N' },
      { id: 'skills', label: 'Skills', icon: 'K' },
      { id: 'agents', label: 'Agents', icon: 'A' },
      { id: 'control', label: 'Control', icon: 'G' },
      { id: 'models', label: 'Models', icon: 'M' },
      { id: 'memory', label: 'Memory', icon: 'R' },
    ],
  },
  {
    title: 'INFRASTRUCTURE',
    items: [
      { id: 'approvals', label: 'Approvals', icon: 'P' },
      { id: 'commitments', label: 'Commitments', icon: 'C' },
      { id: 'hooks', label: 'Hooks', icon: 'H' },
      { id: 'devices', label: 'Devices', icon: 'D' },
      { id: 'nodes', label: 'Nodes', icon: 'N' },
      { id: 'plugins', label: 'Plugins', icon: 'X' },
      { id: 'gateway', label: 'Gateway', icon: 'W' },
    ],
  },
  {
    title: 'SYSTEM',
    items: [
      { id: 'config', label: 'Config', icon: 'G' },
      { id: 'health', label: 'Health', icon: 'H' },
    ],
  },
];

interface HealthData {
  ollama: { running: boolean; model: string | null; url: string };
  bun_server: { running: boolean; url: string };
  bridge: { running: boolean; port: number };
  disk: { total: string; used: string; available: string; use_percent: string };
  memory: { total_mb: number; available_mb: number; used_mb: number; used_percent: number };
  timestamp: string;
}

interface AgentSummary {
  id: string;
  name: string;
  model: string;
  enabled: boolean;
}

interface OverviewData {
  health: HealthData;
  agents: AgentSummary[];
  sessions: BackendSession[];
}

interface CompanionCronJob {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
}

function isSelfImprovementCron(job: CompanionCronJob): boolean {
  const prompt = job.prompt.toLowerCase();
  return (
    prompt.includes('autonomous learning session') ||
    prompt.includes('credibility_gate') ||
    prompt.includes('self-improvement review') ||
    prompt.includes('durable learnable insights')
  );
}

function buildCronAwarenessMessage({
  activeSelfImprovement,
  activeTotal,
  missedCount,
}: {
  activeSelfImprovement: number;
  activeTotal: number;
  missedCount: number;
}): string {
  if (missedCount > 0) {
    return `Reflecting on ${missedCount} missed self-improvement routine${missedCount === 1 ? '' : 's'}...`;
  }
  if (activeSelfImprovement > 0) {
    return `Tracking ${activeSelfImprovement} self-improvement cron${activeSelfImprovement === 1 ? '' : 's'}.`;
  }
  if (activeTotal > 0) {
    return `Monitoring ${activeTotal} active cron${activeTotal === 1 ? '' : 's'}.`;
  }
  return 'Ready for your next improvement cycle.';
}

function formatAge(ms: number): string {
  if (ms < 0) return 'just now';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ago`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

function formatIsoAge(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return 'unknown';
  return formatAge(Date.now() - time);
}

function formatTokens(n: number | null): string {
  if (n === null || n === undefined) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function percentColor(pct: number | null): string {
  if (pct === null || pct === undefined) return 'text-bone-muted';
  if (pct >= 80) return 'text-error';
  if (pct >= 60) return 'text-warning';
  if (pct >= 40) return 'text-cyan-neon';
  return 'text-bone-muted';
}

function MetricCard({ label, value, sub, color, icon }: { label: string; value: string | number; sub?: string; color?: string; icon?: string }) {
  const isNumber = typeof value === 'number';
  return (
    <GlassCard className="text-center" hoverable>
      {icon && <div className="text-lg opacity-50 mb-1">{icon}</div>}
      {isNumber ? (
        <AnimatedNumber
          value={value as number}
          className={cn('text-2xl font-bold tracking-tight', color || 'text-bone')}
        />
      ) : (
        <motion.div
          className={cn('text-2xl font-bold tracking-tight', color || 'text-bone')}
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', mass: 1.2, stiffness: 180, damping: 22 }}
        >
          {value}
        </motion.div>
      )}
      <Label tone="muted" className="mt-1.5 block">{label}</Label>
      {sub && <div className="text-[10px] font-mono text-bone-faint mt-1">{sub}</div>}
    </GlassCard>
  );
}

function Sidebar({ currentView, onNavigate }: { currentView: ViewId; onNavigate: (v: ViewId) => void }) {
  return (
    <motion.div
      initial={{ x: -20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ type: 'spring', mass: 1.2, stiffness: 180, damping: 22 }}
      className="w-56 glass-strong border-r border-white/[0.04] flex flex-col h-full shrink-0 relative overflow-hidden"
    >
      {/* Aurora bleed from the top-left of the sidebar */}
      <div className="absolute top-0 left-0 w-full h-32 pointer-events-none" style={{
        background: 'radial-gradient(ellipse at top left, rgba(139, 92, 246, 0.15), transparent 60%)',
      }} />

      <div className="h-14 flex items-center px-4 border-b border-white/[0.04] relative">
        <div className="relative mr-2.5">
          <motion.div
            className="w-8 h-8 rounded-lg flex items-center justify-center relative overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, #8b5cf6 0%, #22d3ee 100%)',
              boxShadow: '0 0 20px -4px rgba(139, 92, 246, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
            }}
            whileHover={{ scale: 1.05, rotate: 3 }}
            transition={{ type: 'spring', mass: 0.8, stiffness: 320, damping: 18 }}
          >
            <span className="text-void font-bold text-sm tracking-tight relative z-10">J</span>
            <div className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/30 to-transparent" />
          </motion.div>
          <motion.div
            aria-hidden
            className="absolute inset-0 rounded-lg pointer-events-none"
            style={{ background: 'radial-gradient(circle, rgba(139, 92, 246, 0.5), transparent 70%)', filter: 'blur(8px)' }}
            animate={{ scale: [1, 1.15, 1], opacity: [0.5, 0.8, 0.5] }}
            transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
          />
        </div>
        <div className="flex flex-col">
          <span className="text-bone font-bold text-sm tracking-tight leading-none">Jarvis</span>
          <span className="text-[9px] font-mono uppercase tracking-[0.18em] text-cyan-neon/70 leading-none mt-0.5">Mythos</span>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto py-3 px-2 relative">
        {NAV_SECTIONS.map((section, sectionIndex) => (
          <div key={section.title} className={cn('mb-4', sectionIndex === 0 && 'pb-4 border-b border-white/[0.04]')}>
            <div className="px-2 mb-1.5">
              <span className={cn('text-[10px] font-mono uppercase tracking-[0.18em] font-semibold', sectionIndex === 0 ? 'text-cyan-neon/70' : 'text-bone-faint')}>
                {section.title}
              </span>
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <SidebarNavItem key={item.id} icon={item.icon} label={item.label} isActive={currentView === item.id} onClick={() => onNavigate(item.id)} />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="px-4 py-3 border-t border-white/[0.04] flex items-center justify-between">
        <span className="text-[10px] font-mono text-bone-faint">v{APP_VERSION}</span>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-neon animate-pulse" style={{ boxShadow: '0 0 6px rgba(34, 211, 238, 0.7)' }} />
          <span className="text-[9px] font-mono uppercase tracking-widest text-cyan-glow">live</span>
        </div>
      </div>
    </motion.div>
  );
}

function OverviewView() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [health, agents, sessions] = await Promise.all([
        invoke<HealthData>('get_system_health'),
        invoke<AgentSummary[]>('list_agents'),
        invoke<BackendSession[]>('list_sessions'),
      ]);
      setData({ health, agents, sessions });
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  usePolling(fetchData, 15000, [fetchData]);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;
  if (!data) return <EmptyState message="No data" />;

  const { health, agents, sessions } = data;
  const enabledAgents = agents.filter((agent) => agent.enabled);
  const activeSessions = sessions.filter((session) => {
    const updatedAt = Date.parse(session.updated_at);
    return !Number.isNaN(updatedAt) && Date.now() - updatedAt < 3600000;
  });

  return (
    <PageTransition>
      <SectionHeader title="Overview" subtitle="system telemetry" />
      <AnimatedGrid className="grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <TiltCard intensity="subtle" accent="cyan" className="!p-5">
          <MetricBlock value={agents.length} label="Agents" icon="⬢" tone="cyan" />
        </TiltCard>
        <TiltCard intensity="subtle" accent="royal" className="!p-5">
          <MetricBlock value={sessions.length} label="Sessions" icon="◉" tone="royal" />
        </TiltCard>
        <TiltCard intensity="subtle" accent="cyan" className="!p-5">
          <MetricBlock
            value={sessions.reduce((sum, session) => sum + session.message_count, 0)}
            label="Messages" icon="✦" tone="bone"
          />
        </TiltCard>
        <TiltCard intensity="subtle" accent="aurora" className="!p-5">
          <MetricBlock value={activeSessions.length} label="Active · 1h" icon="◇" tone="bone" />
        </TiltCard>
      </AnimatedGrid>
      <AnimatedGrid className="grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
        <TiltCard glow accent="cyan" intensity="subtle">
          <div className="flex items-center gap-2 mb-3"><StatusDot ok={health.bridge.running || health.bun_server.running} /><h3 className="text-sm font-semibold text-bone tracking-tight">Gateway</h3></div>
          <div className="space-y-2 text-xs font-mono">
            <div className="flex justify-between"><span className="text-bone-dim">Bridge</span><span className={health.bridge.running ? 'text-cyan-glow' : 'text-error'}>{health.bridge.running ? 'running' : 'offline'}</span></div>
            <div className="flex justify-between"><span className="text-bone-dim">Bun</span><span className={health.bun_server.running ? 'text-cyan-glow' : 'text-error'}>{health.bun_server.running ? 'running' : 'offline'}</span></div>
            <div className="flex justify-between"><span className="text-bone-dim">Port</span><span className="text-bone-muted">{health.bridge.port}</span></div>
          </div>
        </TiltCard>
        <TiltCard glow accent="royal" intensity="subtle">
          <div className="flex items-center gap-2 mb-3"><StatusDot ok={health.ollama.running} /><h3 className="text-sm font-semibold text-bone tracking-tight">System</h3></div>
          <div className="space-y-2 text-xs font-mono">
            <div className="flex justify-between"><span className="text-bone-dim">Ollama</span><span className={health.ollama.running ? 'text-cyan-glow' : 'text-error'}>{health.ollama.running ? 'running' : 'offline'}</span></div>
            <div className="flex justify-between"><span className="text-bone-dim">Model</span><span className="text-bone-muted truncate ml-2 max-w-[200px]">{health.ollama.model || 'none'}</span></div>
            <div className="flex justify-between"><span className="text-bone-dim">Memory</span><span className="text-bone-muted">{health.memory.used_percent.toFixed(1)}%</span></div>
            <div className="flex justify-between"><span className="text-bone-dim">Disk</span><span className="text-bone-muted">{health.disk.use_percent}</span></div>
          </div>
        </TiltCard>
        <TiltCard glow accent="aurora" intensity="subtle">
          <div className="flex items-center gap-2 mb-3"><StatusDot ok={enabledAgents.length > 0} warn={enabledAgents.length === 0} /><h3 className="text-sm font-semibold text-bone tracking-tight">Agents</h3></div>
          <div className="space-y-2 text-xs font-mono">
            <div className="flex justify-between"><span className="text-bone-dim">Enabled</span><span className="text-bone-muted">{enabledAgents.length}</span></div>
            <div className="flex justify-between"><span className="text-bone-dim">Disabled</span><span className="text-bone-muted">{agents.length - enabledAgents.length}</span></div>
            <div className="flex justify-between"><span className="text-bone-dim">Sessions</span><span className="text-bone-muted">{sessions.length}</span></div>
          </div>
        </TiltCard>
      </AnimatedGrid>
      <AnimatedGrid className="grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <MetricCard value={agents.length} label="Agents" color="text-cyan-neon" />
        <MetricCard value={sessions.length} label="Sessions" color="text-royal-light" />
        <MetricCard value={sessions.reduce((sum, session) => sum + session.message_count, 0)} label="Messages" color="text-bone-muted" />
        <MetricCard value={activeSessions.length} label="Active (1h)" color="text-bone" />
      </AnimatedGrid>
      <SectionHeader title="Recent Sessions" count={Math.min(sessions.length, 5)} />
      <AnimatedList>
        {sessions.slice(0, 5).map((session) => (
          <TiltCard key={session.id} intensity="subtle" accent="royal" className="!p-3.5">
            <div className="flex items-center gap-3">
              <StatusDot ok={!session.archived} warn={session.archived} size="sm" />
              <div className="flex-1 min-w-0"><div className="text-sm font-semibold text-bone truncate">{session.title || session.agent_id}</div><div className="text-xs font-mono text-bone-faint truncate">{session.id}</div></div>
              <div className="text-right shrink-0"><div className="text-xs font-mono text-bone-muted">{session.model || session.backend}</div><div className="text-[10px] font-mono text-bone-dim">{formatIsoAge(session.updated_at)}</div></div>
            </div>
          </TiltCard>
        ))}
      </AnimatedList>
    </PageTransition>
  );
}

function ChatFeedsView() {
  const { error: toastError } = useToast();
  const [sessions, setSessions] = useState<BackendSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<SessionMessage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const result = await invoke<BackendSession[]>('list_sessions');
      setSessions([...result].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  usePolling(fetchSessions, 15000, [fetchSessions]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [history]);

  const loadHistory = useCallback(async (sessionId: string) => {
    setSelectedId(sessionId);
    setHistoryLoading(true);
    setHistory(null);
    try {
      setHistory(await invoke<SessionMessage[]>('get_session_history', { sessionId }));
    } catch (e) {
      toastError(`Failed to load history: ${e}`, 'Chat Error');
    } finally {
      setHistoryLoading(false);
    }
  }, [toastError]);

  const filtered = sessions.filter((session) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return [session.agent_id, session.id, session.title, session.model, session.backend].some((value) => value.toLowerCase().includes(query));
  });
  const selectedSession = sessions.find((session) => session.id === selectedId);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  return (
    <PageTransition>
      <SectionHeader title="Chat Feeds" count={filtered.length} subtitle="session streams" />
      <div className="flex gap-4 h-[calc(100vh-10rem)]">
        <div className="w-80 shrink-0 flex flex-col">
          <div className="mb-3">
            <input type="text" placeholder="Filter sessions..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full px-3 py-1.5 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors" />
          </div>
          <div className="flex-1 overflow-y-auto space-y-1">
            {filtered.map((session) => (
              <motion.button key={session.id} onClick={() => loadHistory(session.id)} className={cn('w-full text-left px-3 py-2 rounded-lg border transition-all duration-150', selectedId === session.id ? 'bg-royal/15 border-royal/30' : 'bg-obsidian/30 border-iron/20 hover:border-iron/40 hover:bg-obsidian/50')} whileHover={{ x: 2 }} layout>
                <div className="flex items-center gap-2 mb-0.5"><StatusDot ok={!session.archived} warn={session.archived} size="sm" /><span className="text-xs font-semibold text-bone truncate">{session.title || session.agent_id}</span><span className="text-[10px] font-mono text-bone-faint ml-auto shrink-0">{formatIsoAge(session.updated_at)}</span></div>
                <div className="text-[11px] font-mono text-bone-faint truncate pl-4">{session.message_count} messages - {session.backend}</div>
                <div className="text-[10px] font-mono text-bone-dim mt-0.5 pl-4">{session.model}</div>
              </motion.button>
            ))}
            {filtered.length === 0 && <EmptyState message="No sessions match filter" />}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          {!selectedId ? (
            <GlassCard className="h-full flex items-center justify-center"><div className="text-center"><motion.div className="text-4xl mb-4 opacity-20" animate={{ opacity: [0.15, 0.25, 0.15] }} transition={{ duration: 3, repeat: Infinity }}>O</motion.div><p className="text-bone-dim text-sm font-mono">Select a session to view its chat feed</p></div></GlassCard>
          ) : historyLoading ? <LoadingState />
          : history ? (
            <GlassCard className="h-full flex flex-col">
              <div className="pb-3 border-b border-iron/30 mb-3 shrink-0"><div className="flex items-center gap-2 mb-1"><StatusDot ok={!selectedSession?.archived} warn={selectedSession?.archived} /><span className="text-sm font-semibold text-bone">{selectedSession?.title || selectedSession?.agent_id || 'Session'}</span><Pill variant="info">{history.length} msgs</Pill></div><div className="text-[11px] font-mono text-bone-faint truncate">{selectedId}</div></div>
              <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                {history.map((msg, index) => {
                  const isUser = msg.role === 'user';
                  const isTool = msg.role === 'tool' || msg.content.startsWith('[tool:') || msg.content.startsWith('[result:');
                  return (
                    <motion.div key={msg.id || index} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index * 0.008, 0.2) }} className={cn('rounded-xl px-4 py-3 text-sm border', isUser ? 'bg-royal/10 border-royal/20 ml-8' : isTool ? 'bg-obsidian/40 border-iron/20 mr-4' : 'bg-cyan-neon/5 border-cyan-neon/15 mr-4')}>
                      <div className="flex items-center gap-2 mb-1.5"><span className={cn('text-[10px] font-mono uppercase tracking-wider font-bold', isUser ? 'text-royal-light' : isTool ? 'text-bone-dim' : 'text-cyan-neon')}>{isUser ? 'USER' : isTool ? 'TOOL' : 'ASSISTANT'}</span>{msg.created_at && <span className="text-[10px] font-mono text-bone-faint">{new Date(msg.created_at).toLocaleTimeString()}</span>}</div>
                      <div className={cn('text-xs leading-relaxed', isUser ? 'text-bone' : isTool ? 'text-bone-dim' : 'text-bone-muted')}><MarkdownRenderer content={msg.content.length > 2000 ? `${msg.content.slice(0, 2000)}\n\n... (truncated)` : msg.content} /></div>
                    </motion.div>
                  );
                })}
                {history.length === 0 && <EmptyState message="No messages in this session" />}
                <div ref={messagesEndRef} />
              </div>
            </GlassCard>
          ) : <EmptyState message="Failed to load chat history" />}
        </div>
      </div>
    </PageTransition>
  );
}

function SessionsView() {
  const [sessions, setSessions] = useState<BackendSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      setSessions(await invoke<BackendSession[]>('list_sessions'));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  usePolling(fetchData, 15000, [fetchData]);
  const toggle = (id: string) => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  return (
    <PageTransition>
      <SectionHeader title="Sessions" count={sessions.length} subtitle="conversation threads" />
      <AnimatedList>
        {sessions.map((session) => {
          const isExpanded = expanded.has(session.id);
          const percentUsed = session.context_tokens > 0 ? Math.min(100, (session.total_tokens / session.context_tokens) * 100) : null;
          return (
            <motion.div key={session.id} layout>
              <TiltCard
                intensity="subtle"
                accent={isExpanded ? 'cyan' : 'royal'}
                onClick={() => toggle(session.id)}
                className="!p-3.5"
              >
                <div className="flex items-center gap-3">
                  <StatusDot ok={!session.archived} warn={session.archived} />
                  <div className="flex-1 min-w-0"><div className="flex items-center gap-2 mb-0.5"><span className="text-sm font-semibold text-bone truncate">{session.title || session.agent_id}</span><Pill variant="info">{session.backend}</Pill>{session.archived && <Pill variant="warning">archived</Pill>}</div><div className="text-xs font-mono text-bone-faint truncate">{session.id}</div></div>
                  <div className="text-right shrink-0"><div className="text-xs font-mono text-bone-muted">{session.model}</div><div className="text-xs font-mono text-bone-dim">{formatIsoAge(session.updated_at)}</div></div>
                </div>
                <AnimatePresence>{isExpanded && (<motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden"><div className="px-3 pb-3 border-t border-white/[0.06] mt-3 pt-3"><div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono"><div><span className="text-bone-dim block mb-0.5">Session ID</span><span className="text-bone-muted break-all">{session.id}</span></div><div><span className="text-bone-dim block mb-0.5">Agent</span><span className="text-bone-muted">{session.agent_id}</span></div><div><span className="text-bone-dim block mb-0.5">Messages</span><span className="text-bone-muted">{session.message_count}</span></div><div><span className="text-bone-dim block mb-0.5">Tokens</span><span className="text-bone-muted">{formatTokens(session.total_tokens)} / {formatTokens(session.context_tokens)}</span></div><div><span className="text-bone-dim block mb-0.5">Created</span><span className="text-bone-muted">{formatIsoAge(session.created_at)}</span></div><div><span className="text-bone-dim block mb-0.5">Updated</span><span className="text-bone-muted">{formatIsoAge(session.updated_at)}</span></div>{percentUsed !== null && (<div className="col-span-2 md:col-span-4"><div className="flex items-center justify-between mb-1"><span className="text-bone-dim">Context Usage</span><span className={percentColor(percentUsed)}>{percentUsed.toFixed(1)}%</span></div><ProgressBar percent={percentUsed} /></div>)}</div></div></motion.div>)}</AnimatePresence>
              </TiltCard>
            </motion.div>
          );
        })}
      </AnimatedList>
    </PageTransition>
  );
}


interface ActionRegistryAlert {
  id: string;
  kind: string;
  severity: string;
  title: string;
  message: string;
  count?: number;
}

function AppInner() {
  const { warn, error: toastError } = useToast();
  const [currentView, setCurrentView] = useState<ViewId>(() => {
    try {
      const saved = localStorage.getItem('jarvis-current-view') as ViewId | null;
      const known = NAV_SECTIONS.flatMap((s) => s.items).some((i) => i.id === saved);
      return saved && known ? saved : 'jarvis';
    } catch { return 'jarvis'; }
  });
  const [companion, setCompanion] = useState<CompanionState | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  // Feature 2: Luxury companion awareness for self-improvement crons (premium "alive" feel)
  const [cronAwareness, setCronAwareness] = useState<string | null>('Syncing improvement routines…');

  useEffect(() => {
    try { localStorage.setItem('jarvis-current-view', currentView); } catch {}
  }, [currentView]);

  useEffect(() => {
    const intervalId = setInterval(() => setLastRefresh(new Date()), 10000);
    return () => clearInterval(intervalId);
  }, []);

  const refreshCronAwareness = useCallback(async () => {
    try {
      const [jobs, missed] = await Promise.all([
        invoke<CompanionCronJob[]>('list_cron_jobs'),
        invoke<CompanionCronJob[]>('list_pending_missed_jobs'),
      ]);
      const activeJobs = jobs.filter((job) => job.enabled);
      const activeSelfImprovement = activeJobs.filter(isSelfImprovementCron).length;
      setCronAwareness(buildCronAwarenessMessage({
        activeSelfImprovement,
        activeTotal: activeJobs.length,
        missedCount: missed.length,
      }));
    } catch {
      setCronAwareness('Companion synced to your workspace.');
    }
  }, []);

  useEffect(() => {
    void refreshCronAwareness();
    const awarenessInterval = setInterval(() => {
      void refreshCronAwareness();
    }, 60000);

    return () => clearInterval(awarenessInterval);
  }, [refreshCronAwareness]);

  useEffect(() => {
    const showRegistryAlert = (alerts: ActionRegistryAlert[]) => {
      const highPriority = alerts.find((alert) => alert.severity === 'high') ?? alerts[0];
      if (!highPriority) return;
      const toastFn = highPriority.severity === 'high' ? toastError : warn;
      toastFn(
        highPriority.message,
        highPriority.title,
        undefined,
        {
          label: 'Open Actions',
          onClick: () => setCurrentView('action-registry'),
        },
      );
    };

    void invoke<ActionRegistryAlert[]>('get_action_registry_alerts')
      .then((alerts) => {
        if (alerts.length > 0) showRegistryAlert(alerts);
      })
      .catch(() => {});

    const alertListen = listen<ActionRegistryAlert[]>('action-registry://alerts', (e) => {
      showRegistryAlert(e.payload);
    });

    return () => {
      alertListen.then((unlisten) => unlisten());
    };
  }, [warn, toastError]);

  useEffect(() => {
    const missedListen = listen<CompanionCronJob[]>('cron://missed-jobs', (e) => {
      const count = e.payload.length;
      if (count > 0) {
        warn(
          `You have ${count} missed cron job${count > 1 ? 's' : ''} pending review in the Cron tab.`,
          'Missed Cron Jobs Detected',
          undefined,
          {
            label: 'Go to Cron View',
            onClick: () => setCurrentView('cron')
          }
        );
        setCronAwareness(buildCronAwarenessMessage({
          activeSelfImprovement: count,
          activeTotal: count,
          missedCount: count,
        }));
      } else {
        void refreshCronAwareness();
      }
    });

    return () => {
      missedListen.then((unlisten) => unlisten());
    };
  }, [warn, refreshCronAwareness]);

  useEffect(() => {
    if (currentView === 'cron') {
      void refreshCronAwareness();
    }
  }, [currentView, refreshCronAwareness]);

  const renderView = () => {
    switch (currentView) {
      case 'jarvis': return <ErrorBoundary><JarvisView onCompanionChange={setCompanion} /></ErrorBoundary>;
      case 'chat-feeds': return <ChatFeedsView />;
      case 'overview': return <OverviewView />;
      case 'sessions': return <SessionsView />;
      case 'models':
      case 'config':
      case 'health':
      case 'jarvis-config':
      case 'jarvis-status':
      case 'control': return <ErrorBoundary><JarvisView initialSubView="control" onCompanionChange={setCompanion} /></ErrorBoundary>;
      case 'memory': return <MemoryView />;
      case 'cron': return <CronView />;
      case 'action-registry': return <ActionRegistryView />;
      case 'skills': return <SkillsView />;
      case 'agents': return <AgentsView />;
      case 'channels': return <ChannelsView />;
      case 'devices': return <ErrorBoundary><DevicesView /></ErrorBoundary>;
      case 'nodes': return <ErrorBoundary><NodesView /></ErrorBoundary>;
      case 'hooks': return <ErrorBoundary><HooksView /></ErrorBoundary>;
      case 'commitments': return <ErrorBoundary><CommitmentsView /></ErrorBoundary>;
      case 'approvals': return <ErrorBoundary><ApprovalsView /></ErrorBoundary>;
      case 'plugins': return <ErrorBoundary><PluginsView /></ErrorBoundary>;
      case 'gateway': return <ErrorBoundary><GatewayView /></ErrorBoundary>;
      default: return <OverviewView />;
    }
  };

  return (
    <div className="w-full h-full flex">
      <Sidebar currentView={currentView} onNavigate={setCurrentView} />
      <div className="flex-1 flex flex-col min-w-0 relative">
        <motion.header
          className="h-14 glass-strong border-b border-white/[0.04] flex items-center px-6 shrink-0 relative z-10"
          initial={{ y: -10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: 'spring', mass: 1.2, stiffness: 180, damping: 22 }}
        >
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-bone font-bold text-lg tracking-tight leading-none">
              {NAV_SECTIONS.flatMap((section) => section.items).find((item) => item.id === currentView)?.label || 'Jarvis'}
            </h1>
            <Label tone="muted">command surface</Label>
          </div>
          <div className="ml-auto flex items-center gap-5">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-neon animate-pulse" style={{ boxShadow: '0 0 8px rgba(34, 211, 238, 0.7)' }} />
              <span className="text-[10px] font-mono uppercase tracking-widest text-cyan-glow">synced {formatAge(Date.now() - lastRefresh.getTime())}</span>
            </div>
            <span className="text-bone-faint text-[10px] font-mono uppercase tracking-widest">v{APP_VERSION}</span>
          </div>
        </motion.header>
        <HealthBanner />
        <main className="flex-1 overflow-y-auto p-6"><AnimatePresence mode="wait"><div key={currentView}><ErrorBoundary>{renderView()}</ErrorBoundary></div></AnimatePresence></main>
        <motion.div
          className="fixed bottom-6 right-6 z-50"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: 'spring', mass: 1.2, stiffness: 180, damping: 22, delay: 0.3 }}
        >
          <MythosCompanionSprite
            species={(companion?.species as CompanionSpecies) || 'cat'}
            rarity={(companion?.rarity as CompanionRarity) || 'rare'}
            state={companion || undefined}
            size={64}
            cronAwareness={cronAwareness}
          />
        </motion.div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
