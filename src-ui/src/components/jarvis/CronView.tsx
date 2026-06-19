import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PageTransition,
  AnimatedList,
  GlassCard,
  StatusDot,
  Pill,
  SectionHeader,
  LoadingState,
  ErrorState,
  EmptyState,
  cn,
  useToast,
} from '../ui';

// ── Types ────────────────────────────────────────────────────────────────────

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
  cron_id: string;
  status: string;
  output: string;
  error: string;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
}

// ── Job Types ────────────────────────────────────────────────────────────────

type CronJobType = 'learning' | 'review' | 'custom';

interface JobTypeConfig {
  id: CronJobType;
  label: string;
  description: string;
  icon: string;
  defaultPrompt: string;
  schedulePresets: Array<{ label: string; expr: string }>;
}

const JOB_TYPES: JobTypeConfig[] = [
  {
    id: 'learning',
    label: 'Learning Session',
    description: 'Research local AI topics, evaluate sources, write findings to memory',
    icon: '🔬',
    defaultPrompt: `You are Jarvis conducting an autonomous Learning Session on local agentic AI architecture.

## Your Task
1. Research today's assigned subtopics using web_search (2-3 queries per subtopic)
2. Fetch the most credible sources using web_fetch
3. Tier 1 sources ONLY: arXiv, ACL Anthology, NeurIPS, ICML, ICLR, Anthropic/DeepMind/HuggingFace engineering blogs, PyTorch blog, vllm.ai, llama.cpp docs
4. For each subtopic, produce ONE structured finding

## Output Format per finding
Write to: ~/.openclaw/jarvis/memory/reference/learnings/YYYY-MM-DD-<short-title>.md

---
type: reference
topic: <subtopic_id>
date: <YYYY-MM-DD>
credibility_gate: passed
---

## Finding: <Concise title>
**Source:** <URL>
**Why credible:** <One sentence>
**Summary:** <3-5 sentences, include specific numbers/metrics>
**Relevance to local agentic AI:** <Concrete application to consumer GPU agents>
**Actionable:** <yes/no>
**Action detail:** <If yes: what could be implemented>

After writing all findings, append index entries to MEMORY.md:
- [<Title>](reference/learnings/<filename>.md) — <One-line hook>`,
    schedulePresets: [
      { label: 'Daily 3am', expr: '0 3 * * *' },
      { label: 'Every 2 days', expr: '0 3 */2 * *' },
      { label: 'Weekly (Mon)', expr: '0 3 * * 1' },
    ],
  },
  {
    id: 'review',
    label: 'Conversation Review',
    description: 'Analyze recent conversations, extract memories and skill updates',
    icon: '🧠',
    defaultPrompt: `You are Jarvis performing a self-improvement review of recent conversations.

## Your Task
Analyze the conversation history and extract DURABLE, ACTIONABLE insights.

## Focus Areas
- **Memories:** User preferences, corrections, project facts, project constraints
- **Skill Updates:** Frustration patterns ("stop doing X"), workflow corrections, reusable rules

## Output
Return ONLY valid JSON (no markdown, no explanation):

{
  "memories": [
    {
      "title": "Short descriptive title",
      "content": "Specific, actionable fact or preference",
      "category": "user|feedback|project|reference",
      "importance": "high|medium|low"
    }
  ],
  "skill_updates": [
    {
      "area": "Specific skill area",
      "change": "One-line improvement rule",
      "priority": "critical|high|medium|low"
    }
  ]
}

Be conservative. Only include genuinely durable insights. If nothing warrants saving, return empty arrays.`,
    schedulePresets: [
      { label: 'Every 12 hours', expr: '0 */12 * * *' },
      { label: 'Daily midnight', expr: '0 0 * * *' },
      { label: 'Every 6 hours', expr: '0 */6 * * *' },
    ],
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Fully custom prompt and schedule',
    icon: '⚡',
    defaultPrompt: '',
    schedulePresets: [
      { label: 'Every hour', expr: '0 * * * *' },
      { label: 'Every 6 hours', expr: '0 */6 * * *' },
      { label: 'Daily 9am', expr: '0 9 * * *' },
      { label: 'Daily midnight', expr: '0 0 * * *' },
      { label: 'Weekly (Mon 8am)', expr: '0 8 * * 1' },
      { label: 'Weekdays 9am', expr: '0 9 * * 1-5' },
      { label: 'Custom', expr: '' },
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatAge(dateStr: string | null): string {
  if (!dateStr) return 'never';
  const d = new Date(dateStr);
  const ms = Date.now() - d.getTime();
  if (ms < 0) {
    const futureMs = -ms;
    const s = Math.floor(futureMs / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d2 = Math.floor(h / 24);
    if (d2 > 0) return `in ${d2}d ${h % 24}h`;
    if (h > 0) return `in ${h}h ${m % 60}m`;
    if (m > 0) return `in ${m}m`;
    return `in ${s}s`;
  }
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d2 = Math.floor(h / 24);
  if (d2 > 0) return `${d2}d ${h % 24}h ago`;
  if (h > 0) return `${h}h ${m % 60}m ago`;
  if (m > 0) return `${m}m ago`;
  return `${s}s ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function statusVariant(status: string): 'success' | 'warning' | 'error' | 'default' | 'info' {
  switch (status) {
    case 'success': return 'success';
    case 'failed': return 'error';
    case 'timeout': return 'warning';
    default: return 'default';
  }
}

// ── Prompt Preview ───────────────────────────────────────────────────────────

function PromptPreview({ prompt }: { prompt: string; jobType?: CronJobType }) {
  const wordCount = prompt.trim().split(/\s+/).filter(Boolean).length;
  const charCount = prompt.length;

  return (
    <div className="rounded-lg border border-iron/20 bg-obsidian/40 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-iron/10 border-b border-iron/20">
        <span className="text-[9px] font-mono uppercase tracking-wider text-bone-dim">Prompt Preview</span>
        <span className="text-[9px] font-mono text-bone-faint">{wordCount} words · {charCount} chars</span>
      </div>
      <pre className="text-[10px] font-mono text-bone-dim whitespace-pre-wrap leading-relaxed p-3 max-h-48 overflow-y-auto">
        {prompt || <span className="text-bone-faint italic">No prompt yet…</span>}
      </pre>
    </div>
  );
}

// ── Add Job Form ─────────────────────────────────────────────────────────────

function AddJobForm({ onAdd, onCancel }: { onAdd: (job: CronJob) => void; onCancel: () => void }) {
  const { success, error: toastError } = useToast();
  const [jobType, setJobType] = useState<CronJobType>('learning');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('');
  const [customExpr, setCustomExpr] = useState('');
  const [isCustomSchedule, setIsCustomSchedule] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [agentId, setAgentId] = useState('jarvis');
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  const typeConfig = useMemo(() => JOB_TYPES.find(t => t.id === jobType)!, [jobType]);

  // Update defaults when job type changes
  const handleTypeChange = (newType: CronJobType) => {
    setJobType(newType);
    const config = JOB_TYPES.find(t => t.id === newType)!;
    setPrompt(config.defaultPrompt);
    setPreset(config.schedulePresets[0]?.expr || '');
    setIsCustomSchedule(false);
    setCustomExpr('');
    // Auto-generate name if empty
    if (!name.trim()) {
      setName(config.label);
    }
  };

  // Initialize with learning defaults
  useMemo(() => {
    if (!prompt) {
      setPrompt(JOB_TYPES[0].defaultPrompt);
      setPreset(JOB_TYPES[0].schedulePresets[0]?.expr || '');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const expr = isCustomSchedule ? customExpr : preset;

  const handleSubmit = async () => {
    if (!name.trim() || !expr.trim() || !prompt.trim()) return;
    setSaving(true);
    try {
      const job = await invoke<CronJob>('add_cron_job', {
        name: name.trim(),
        schedule: expr.trim(),
        prompt: prompt.trim(),
        agentId: agentId.trim() || 'jarvis',
      });
      success(`Cron job "${name}" created successfully.`, 'Cron Job Added');
      onAdd(job);
    } catch (e) {
      toastError(`Failed to add cron job: ${e}`, 'Cron Job Error');
    } finally {
      setSaving(false);
    }
  };

  const schedulePresets = typeConfig.schedulePresets;
  const showCustomInput = isCustomSchedule || (preset !== '' && !schedulePresets.some(p => p.expr === preset));

  return (
    <GlassCard>
      <h3 className="text-sm font-semibold text-bone mb-4">Add Cron Job</h3>

      {/* Job Type Selector */}
      <div className="mb-4">
        <label className="block text-xs font-mono text-bone-dim mb-1.5">Job Type</label>
        <div className="grid grid-cols-3 gap-2">
          {JOB_TYPES.map((type) => (
            <button
              key={type.id}
              onClick={() => handleTypeChange(type.id)}
              className={cn(
                'px-3 py-2.5 rounded-lg border text-left transition-all duration-150',
                jobType === type.id
                  ? 'border-royal/50 bg-royal/15'
                  : 'border-iron/30 bg-obsidian/30 hover:border-iron/50'
              )}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-sm" aria-hidden="true">{type.icon}</span>
                <span className={cn('text-xs font-mono font-semibold', jobType === type.id ? 'text-royal-light' : 'text-bone')}>{type.label}</span>
              </div>
              <p className="text-[9px] font-mono text-bone-faint leading-tight">{type.description}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Name + Agent */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-xs font-mono text-bone-dim mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={typeConfig.label}
            className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-mono text-bone-dim mb-1.5">Agent</label>
          <input
            type="text"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="jarvis"
            className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
          />
        </div>
      </div>

      {/* Schedule */}
      <div className="mb-4">
        <label className="block text-xs font-mono text-bone-dim mb-1.5">Schedule</label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {schedulePresets.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                if (p.label === 'Custom') {
                  setIsCustomSchedule(true);
                  setPreset('');
                } else {
                  setIsCustomSchedule(false);
                  setPreset(p.expr);
                }
              }}
              className={cn(
                'px-2.5 py-1 text-[10px] font-mono rounded-md border transition-all duration-150',
                (!isCustomSchedule && preset === p.expr) || (isCustomSchedule && p.label === 'Custom')
                  ? 'bg-royal/20 text-royal-light border-royal/40'
                  : 'text-bone-dim border-iron/40 hover:border-iron/60 hover:text-bone-muted'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        {(showCustomInput || isCustomSchedule) && (
          <motion.input
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            type="text"
            value={customExpr}
            onChange={(e) => setCustomExpr(e.target.value)}
            placeholder="*/5 * * * *"
            className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors"
          />
        )}
      </div>

      {/* Prompt */}
      <div className="mb-2">
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-xs font-mono text-bone-dim">Prompt</label>
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="text-[9px] font-mono text-bone-faint hover:text-bone-dim transition-colors"
          >
            {showPreview ? 'Hide Preview' : 'Show Preview'}
          </button>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          placeholder="What should this cron job do?"
          className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone placeholder:text-bone-faint focus:outline-none focus:border-royal/50 transition-colors resize-none"
        />
      </div>

      {/* Prompt Preview */}
      <AnimatePresence>
        {showPreview && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="mb-4 overflow-hidden"
          >
            <PromptPreview prompt={prompt} jobType={jobType} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        <motion.button
          onClick={onCancel}
          className="px-4 py-2 text-xs font-mono text-bone-dim border border-iron/40 rounded-lg hover:border-iron/60 transition-colors"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          Cancel
        </motion.button>
        <motion.button
          onClick={handleSubmit}
          disabled={saving || !name.trim() || !expr.trim() || !prompt.trim()}
          className={cn(
            'px-4 py-2 text-xs font-mono text-void bg-gradient-to-r from-royal to-cyan-neon rounded-lg transition-opacity',
            (saving || !name.trim() || !expr.trim() || !prompt.trim())
              ? 'opacity-50 cursor-not-allowed'
              : 'hover:opacity-90'
          )}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          {saving ? 'Adding…' : 'Add Job'}
        </motion.button>
      </div>
    </GlassCard>
  );
}

// ── Edit Job Modal ───────────────────────────────────────────────────────────

function EditJobModal({ job, onClose, onSave }: { job: CronJob; onClose: () => void; onSave: (job: CronJob) => void }) {
  const { success, error: toastError } = useToast();
  const [name, setNameEdit] = useState(job.name);
  const [schedule, setSchedule] = useState(job.schedule);
  const [prompt, setPrompt] = useState(job.prompt);
  const [agentId, setAgentId] = useState(job.agent_id);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await invoke<CronJob>('edit_cron_job', {
        id: job.id,
        patch: {
          name,
          schedule,
          prompt,
          agent_id: agentId,
        },
      });
      success(`Cron job "${name}" updated successfully.`, 'Cron Job Saved');
      onSave(updated);
      onClose();
    } catch (e) {
      toastError(`Failed to save cron job: ${e}`, 'Cron Job Error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        className="glass-strong border border-iron/40 rounded-2xl p-6 w-full max-w-lg mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-bone">Edit Cron Job</h3>
          <button onClick={onClose} className="text-bone-dim hover:text-bone transition-colors text-sm">✕</button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-mono text-bone-dim mb-1">Name</label>
            <input type="text" value={name} onChange={(e) => setNameEdit(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone focus:outline-none focus:border-royal/50 transition-colors" />
          </div>
          <div>
            <label className="block text-xs font-mono text-bone-dim mb-1">Schedule</label>
            <input type="text" value={schedule} onChange={(e) => setSchedule(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone focus:outline-none focus:border-royal/50 transition-colors" />
          </div>
          <div>
            <label className="block text-xs font-mono text-bone-dim mb-1">Agent</label>
            <input type="text" value={agentId} onChange={(e) => setAgentId(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone focus:outline-none focus:border-royal/50 transition-colors" />
          </div>
          <div>
            <label className="block text-xs font-mono text-bone-dim mb-1">Prompt</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6}
              className="w-full px-3 py-2 text-xs font-mono bg-obsidian/60 border border-iron/40 rounded-lg text-bone focus:outline-none focus:border-royal/50 transition-colors resize-none" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 mt-4">
          <motion.button onClick={onClose}
            className="px-4 py-2 text-xs font-mono text-bone-dim border border-iron/40 rounded-lg hover:border-iron/60 transition-colors"
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>Cancel</motion.button>
          <motion.button onClick={handleSave} disabled={saving}
            className="px-4 py-2 text-xs font-mono text-void bg-gradient-to-r from-royal to-cyan-neon rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>{saving ? 'Saving…' : 'Save'}</motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Runs History ─────────────────────────────────────────────────────────────

function RunsHistory({ job }: { job: CronJob }) {
  const { error: toastError } = useToast();
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const fetchRuns = useCallback(async () => {
    try {
      const r = await invoke<CronRun[]>('get_cron_runs', { cronId: job.id });
      setRuns(r);
    } catch (e) {
      toastError(`Failed to fetch runs for "${job.name}": ${e}`, 'Runs Fetch Error');
    } finally {
      setLoading(false);
    }
  }, [job.id, job.name, toastError]);

  useEffect(() => {
    if (expanded) fetchRuns();
  }, [expanded, fetchRuns]);

  if (job.run_count === 0) return null;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] font-mono text-bone-faint hover:text-bone-dim transition-colors flex items-center gap-1"
      >
        <span className={cn('transition-transform duration-200', expanded && 'rotate-90')}>▶</span>
        {job.run_count} runs
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 pl-3 border-l border-iron/20 space-y-1.5">
              {loading ? (
                <div className="text-[10px] font-mono text-bone-faint">Loading runs…</div>
              ) : runs.length === 0 ? (
                <div className="text-[10px] font-mono text-bone-faint">No runs yet</div>
              ) : (
                runs.map((run) => (
                  <div key={run.id} className="flex items-start gap-2 py-1.5 border-b border-iron/10 last:border-0">
                    <StatusDot ok={run.status === 'success'} warn={run.status === 'timeout'} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <Pill variant={statusVariant(run.status)}>{run.status}</Pill>
                        <span className="text-[10px] font-mono text-bone-faint">{formatAge(run.started_at)}</span>
                        {run.duration_ms > 0 && (
                          <span className="text-[10px] font-mono text-bone-dim">{formatDuration(run.duration_ms)}</span>
                        )}
                      </div>
                      {run.output && (
                        <div className="text-[10px] font-mono text-bone-dim truncate max-w-xs">
                          {run.output.length > 120 ? run.output.slice(0, 120) + '…' : run.output}
                        </div>
                      )}
                      {run.error && (
                        <div className="text-[10px] font-mono text-error truncate max-w-xs">
                          {run.error.length > 120 ? run.error.slice(0, 120) + '…' : run.error}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Cron Job Card ────────────────────────────────────────────────────────────

// Detect job type from prompt content
function detectJobType(job: CronJob): CronJobType {
  if (job.prompt.includes('autonomous Learning Session') || job.prompt.includes('credibility_gate')) return 'learning';
  if (job.prompt.includes('self-improvement review') || job.prompt.includes('durable learnable insights')) return 'review';
  return 'custom';
}

function CronJobCard({ job, onRefresh, isInFlight }: { job: CronJob; onRefresh: () => void; isInFlight: boolean }) {
  const { success, error: toastError } = useToast();
  const [toggling, setToggling] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);

  const jobType = detectJobType(job);
  const typeConfig = JOB_TYPES.find(t => t.id === jobType);

  const handleToggle = async () => {
    setToggling(true);
    try {
      if (job.enabled) {
        await invoke('disable_cron_job', { id: job.id });
        success(`Cron job "${job.name}" disabled.`, 'Cron Job Disabled');
      } else {
        await invoke('enable_cron_job', { id: job.id });
        success(`Cron job "${job.name}" enabled.`, 'Cron Job Enabled');
      }
      onRefresh();
    } catch (e) {
      toastError(`Failed to toggle: ${e}`, 'Toggle Error');
    } finally {
      setToggling(false);
    }
  };

  const handleRun = async () => {
    setRunning(true);
    try {
      await invoke('run_cron_job', { id: job.id });
      success(`Cron job "${job.name}" triggered successfully.`, 'Cron Job Started');
      onRefresh();
    } catch (e) {
      toastError(`Failed to run: ${e}`, 'Run Error');
    } finally {
      setRunning(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete cron job "${job.name}"?`)) return;
    setDeleting(true);
    try {
      await invoke('delete_cron_job', { id: job.id });
      success(`Cron job "${job.name}" deleted.`, 'Cron Job Deleted');
      onRefresh();
    } catch (e) {
      toastError(`Failed to delete: ${e}`, 'Delete Error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <GlassCard glowOnHover={!job.enabled}>
        <div className="flex items-start gap-3">
          <StatusDot ok={job.enabled} warn={!job.enabled} />
          <div className="flex-1 min-w-0">
            {/* Header */}
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-sm font-semibold text-bone">{job.name}</span>
              {/* Job type badge */}
              {typeConfig && (
                <Pill variant="info">
                  <span className="mr-1" aria-hidden="true">{typeConfig.icon}</span>
                  {typeConfig.label}
                </Pill>
              )}
              {!job.enabled && <Pill variant="warning">disabled</Pill>}
              <Pill variant="default">{job.agent_id}</Pill>
              {isInFlight && (
                <Pill variant="success">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-neon mr-1.5 animate-pulse" />
                  Running
                </Pill>
              )}
            </div>

            {/* Schedule + meta */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs font-mono mb-2">
              <div>
                <span className="text-bone-dim">Schedule: </span>
                <span className="text-cyan-glow font-semibold">{job.schedule}</span>
              </div>
              <div>
                <span className="text-bone-dim">Last run: </span>
                <span className="text-bone-muted">{formatAge(job.last_run)}</span>
              </div>
              <div>
                <span className="text-bone-dim">Next run: </span>
                <span className="text-bone-muted">{job.next_run ? formatAge(job.next_run) : '—'}</span>
              </div>
            </div>

            {/* Prompt preview */}
            <p className="text-xs text-bone-muted mb-2 line-clamp-2">{job.prompt}</p>

            {/* Runs history */}
            <RunsHistory job={job} />

            {/* Actions */}
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-iron/20">
              <motion.button
                onClick={handleToggle} disabled={toggling}
                className={cn(
                  'relative w-10 h-5 rounded-full transition-colors duration-200 border',
                  job.enabled ? 'bg-cyan-neon/20 border-cyan-neon/40' : 'bg-iron/20 border-iron/40',
                  toggling && 'opacity-50'
                )}
                whileTap={{ scale: 0.95 }}
              >
                <motion.div
                  className={cn('absolute top-0.5 w-4 h-4 rounded-full', job.enabled ? 'bg-cyan-neon' : 'bg-bone-dim')}
                  animate={{ left: job.enabled ? '1.25rem' : '0.125rem' }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                />
              </motion.button>

              <motion.button
                onClick={handleRun} disabled={running || isInFlight || !job.enabled}
                className={cn(
                  'px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded-md border transition-colors',
                  job.enabled && !isInFlight && !running
                    ? 'bg-cyan-neon/10 text-cyan-glow border-cyan-neon/30 hover:bg-cyan-neon/20'
                    : 'bg-iron/10 text-bone-faint border-iron/20 cursor-not-allowed'
                )}
                whileHover={job.enabled && !isInFlight && !running ? { scale: 1.05 } : undefined}
                whileTap={job.enabled && !isInFlight && !running ? { scale: 0.95 } : undefined}
              >
                {running || isInFlight ? 'Running…' : 'Run Now'}
              </motion.button>

              <motion.button
                onClick={() => setEditing(true)}
                className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider bg-royal/10 text-royal-light border border-royal/30 rounded-md hover:bg-royal/20 transition-colors"
                whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
              >Edit</motion.button>

              <motion.button
                onClick={handleDelete} disabled={deleting}
                className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider bg-error/10 text-error border border-error/30 rounded-md hover:bg-error/20 transition-colors disabled:opacity-50"
                whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
              >{deleting ? '…' : 'Delete'}</motion.button>
            </div>
          </div>
        </div>
      </GlassCard>

      <AnimatePresence>
        {editing && (
          <EditJobModal job={job} onClose={() => setEditing(false)} onSave={() => { onRefresh(); }} />
        )}
      </AnimatePresence>
    </>
  );
}

// ── Main CronView ────────────────────────────────────────────────────────────

export default function CronView() {
  const { success, error: toastError } = useToast();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [inFlightIds, setInFlightIds] = useState<Set<string>>(new Set());
  const [pendingMissed, setPendingMissed] = useState<CronJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  // Feature 1: Premium Insights state (luxury viz + smart recs using existing data)
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [insightRuns, setInsightRuns] = useState<CronRun[]>([]);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [hasAutoOpenedInsights, setHasAutoOpenedInsights] = useState(false);

  const fetchInFlight = useCallback(async () => {
    try {
      const ids = await invoke<string[]>('get_in_flight_cron_jobs');
      setInFlightIds(new Set(ids));
    } catch (e) { /* Squelch background polling errors */ }
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const r = await invoke<CronJob[]>('list_cron_jobs');
      setJobs(r);
      setError(null);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, []);

  const fetchPendingMissed = useCallback(async () => {
    try {
      const missed = await invoke<CronJob[]>('list_pending_missed_jobs');
      setPendingMissed(missed);
    } catch (e) { /* Squelch background errors */ }
  }, []);

  useEffect(() => {
    fetchJobs();
    fetchInFlight();
    fetchPendingMissed();
    const interval = setInterval(fetchInFlight, 3000);

    const missedListen = listen<CronJob[]>('cron://missed-jobs', (e) => {
      setPendingMissed(e.payload);
    });

    return () => {
      clearInterval(interval);
      missedListen.then(unlisten => unlisten());
    };
  }, [fetchJobs, fetchInFlight, fetchPendingMissed]);

  const handleAdd = (newJob: CronJob) => {
    setJobs((prev) => [newJob, ...prev]);
    setShowAddForm(false);
  };

  const handleTriggerMissed = async (id: string, name: string) => {
    try {
      await invoke('trigger_missed_cron_job', { id });
      success(`Missed job "${name}" is executing now.`, 'Missed Job Started');
      setPendingMissed(prev => prev.filter(j => j.id !== id));
      fetchJobs();
    } catch (e) {
      toastError(`Failed to trigger: ${e}`, 'Trigger Error');
    }
  };

  const handleDismissMissed = async (id: string, name: string) => {
    try {
      await invoke('dismiss_missed_cron_job', { id });
      success(`Missed job "${name}" dismissed and rescheduled.`, 'Missed Job Dismissed');
      setPendingMissed(prev => prev.filter(j => j.id !== id));
      fetchJobs();
    } catch (e) {
      toastError(`Failed to dismiss: ${e}`, 'Dismiss Error');
    }
  };

  const handleDismissAllMissed = async () => {
    try {
      await Promise.all(pendingMissed.map(j => invoke('dismiss_missed_cron_job', { id: j.id })));
      success('All missed jobs dismissed.', 'Missed Jobs Dismissed');
      setPendingMissed([]);
      fetchJobs();
    } catch (e) {
      toastError(`Failed to dismiss all: ${e}`, 'Dismiss All Error');
    }
  };

  // Feature 1: Luxury Insights loader + simple viz (uses existing invokes, client-side agg, capped)
  const loadInsights = useCallback(async () => {
    if (insightsLoading) return;

    setInsightsLoading(true);
    try {
      const samples: CronRun[] = [];
      const topJobs = [...jobs].sort((a, b) => b.run_count - a.run_count).slice(0, 4); // perf safety
      for (const j of topJobs) {
        try {
          const rs: CronRun[] = await invoke('get_cron_runs', { cronId: j.id });
          samples.push(...rs.slice(0, 5));
        } catch {}
      }
      setInsightRuns(samples);
    } finally {
      setInsightsLoading(false);
    }
  }, [insightsLoading, jobs]);

  const toggleInsights = async () => {
    if (insightsOpen) {
      setInsightsOpen(false);
      return;
    }

    setInsightsOpen(true);
    await loadInsights();
  };

  useEffect(() => {
    if (!hasAutoOpenedInsights && jobs.length > 0) {
      setHasAutoOpenedInsights(true);
      setInsightsOpen(true);
      void loadInsights();
    }
  }, [hasAutoOpenedInsights, jobs.length, loadInsights]);

  // Summary stats
  const enabledCount = jobs.filter(j => j.enabled).length;
  const learningCount = jobs.filter(j => detectJobType(j) === 'learning').length;
  const reviewCount = jobs.filter(j => detectJobType(j) === 'review').length;

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  return (
    <PageTransition>
      <SectionHeader
        title="Cron Jobs"
        count={jobs.length}
        subtitle={jobs.length > 0 ? `${enabledCount} enabled · ${learningCount} learning · ${reviewCount} review` : undefined}
        action={
          <div className="flex items-center gap-2">
            {jobs.length > 0 && (
              <motion.button
                onClick={toggleInsights}
                className={cn(
                  'px-3 py-1.5 text-xs font-mono rounded-lg border transition-all duration-150',
                  insightsOpen
                    ? 'bg-cyan-neon/15 text-cyan-glow border-cyan-neon/30'
                    : 'bg-iron/10 text-bone-dim border-iron/20 hover:bg-iron/15'
                )}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
              >
                {insightsLoading ? 'Loading…' : insightsOpen ? 'Hide Insights' : '📊 Insights'}
              </motion.button>
            )}
            <motion.button
              onClick={() => setShowAddForm(!showAddForm)}
              className={cn(
                'px-3 py-1.5 text-xs font-mono rounded-lg border transition-all duration-150',
                showAddForm
                  ? 'bg-error/10 text-error border-error/30'
                  : 'bg-royal/15 text-royal-light border-royal/30 hover:bg-royal/25'
              )}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
            >
              {showAddForm ? 'Cancel' : '+ Add Job'}
            </motion.button>
          </div>
        }
      />

      <AnimatePresence>
        {insightsOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="mb-4 overflow-hidden"
          >
            <GlassCard className="border-cyan-neon/30 bg-cyan-neon/5 p-4">
              <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                <div>
                  <h4 className="text-xs font-bold text-cyan-glow font-mono uppercase tracking-wider">
                    📊 Premium Cron Insights
                  </h4>
                  <p className="text-[11px] font-mono text-bone-dim mt-1">
                    Live execution quality, run history, and balance recommendations for your automation loop.
                  </p>
                </div>
                <Pill variant="info">{insightsLoading ? 'syncing…' : `${insightRuns.length} samples`}</Pill>
              </div>

              {insightsLoading ? (
                <p className="text-xs font-mono text-bone-dim">
                  Loading premium cron insights from recent run history…
                </p>
              ) : (
                (() => {
                  const total = insightRuns.length;
                  const successful = insightRuns.filter((r) => r.status === 'success').length;
                  const successRate = total > 0 ? Math.round((successful / total) * 100) : null;
                  const avgDuration = total > 0 ? Math.round(insightRuns.reduce((acc, r) => acc + r.duration_ms, 0) / total) : null;
                  const mostActive = jobs.length > 0 ? jobs.reduce((a, b) => (b.run_count > a.run_count ? b : a)).name : '—';
                  const learningEnabled = jobs.filter((j) => j.enabled && detectJobType(j) === 'learning').length;
                  const reviewEnabled = jobs.filter((j) => j.enabled && detectJobType(j) === 'review').length;
                  const recommendation = pendingMissed.length > 0
                    ? `${pendingMissed.length} missed cron job${pendingMissed.length === 1 ? '' : 's'} need review to keep your loop tight.`
                    : learningEnabled > reviewEnabled + 1
                      ? 'You have more learning jobs than review jobs — add a review pass to turn research into durable insights.'
                      : reviewEnabled > learningEnabled + 1
                        ? 'Reflection is strong — add another learning cron to feed the review loop with fresh signal.'
                        : 'Learning and review routines are balanced — your self-improvement loop looks healthy.';

                  return (
                    <div className="space-y-4 font-mono">
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                        <div className="p-3 bg-obsidian/40 border border-iron/20 rounded-lg">
                          <div className="text-[10px] text-bone-faint uppercase tracking-wider">Success Rate</div>
                          <div className="text-xl font-bold text-cyan-glow mt-1">{successRate === null ? '—' : `${successRate}%`}</div>
                          <div className="text-[10px] text-bone-dim mt-0.5">{successful} of {total} sampled runs</div>
                        </div>
                        <div className="p-3 bg-obsidian/40 border border-iron/20 rounded-lg">
                          <div className="text-[10px] text-bone-faint uppercase tracking-wider">Avg Duration</div>
                          <div className="text-xl font-bold text-royal-light mt-1">{avgDuration === null ? '—' : formatDuration(avgDuration)}</div>
                          <div className="text-[10px] text-bone-dim mt-0.5">Recent execution latency</div>
                        </div>
                        <div className="p-3 bg-obsidian/40 border border-iron/20 rounded-lg">
                          <div className="text-[10px] text-bone-faint uppercase tracking-wider">Analysed Samples</div>
                          <div className="text-xl font-bold text-bone mt-1">{total}</div>
                          <div className="text-[10px] text-bone-dim mt-0.5">Top 4 jobs, 5 recent runs each</div>
                        </div>
                        <div className="p-3 bg-obsidian/40 border border-iron/20 rounded-lg">
                          <div className="text-[10px] text-bone-faint uppercase tracking-wider">Most Active</div>
                          <div className="text-sm font-bold text-bone mt-1 truncate">{mostActive}</div>
                          <div className="text-[10px] text-bone-dim mt-0.5">Highest run-count automation</div>
                        </div>
                      </div>

                      <div className="rounded-lg border border-iron/20 bg-obsidian/35 p-3">
                        <div className="text-[10px] text-bone-faint uppercase tracking-wider mb-2">Recent Run History</div>
                        {total === 0 ? (
                          <p className="text-xs text-bone-dim">
                            No historical runs found yet — let a cron execute and this panel will start charting the loop.
                          </p>
                        ) : (
                          <div className="flex gap-1 h-16 items-end">
                            {insightRuns.slice(0, 16).map((run) => (
                              <div
                                key={run.id}
                                className={cn(
                                  'flex-1 rounded-t-md transition-opacity hover:opacity-100 opacity-90',
                                  run.status === 'success'
                                    ? 'bg-cyan-neon/80'
                                    : run.status === 'failed'
                                      ? 'bg-error/75'
                                      : 'bg-warning/70'
                                )}
                                style={{ height: `${Math.max(14, Math.min(100, (run.duration_ms || 50) / 6))}%` }}
                                title={`${run.status} • ${formatDuration(run.duration_ms)}`}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="rounded-lg border border-royal/20 bg-royal/8 p-3 text-[11px] leading-relaxed text-bone-dim">
                        <span className="text-royal-light font-semibold tracking-wide uppercase text-[10px]">Recommendation</span>
                        <p className="mt-1">{recommendation}</p>
                      </div>
                    </div>
                  );
                })()
              )}
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAddForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="mb-4 overflow-hidden"
          >
            <AddJobForm onAdd={handleAdd} onCancel={() => setShowAddForm(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {pendingMissed.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="mb-6"
          >
            <GlassCard className="border-warning/30 bg-warning/5 p-4">
              <div className="flex items-center justify-between mb-3 border-b border-warning/20 pb-2 flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm">⏳</span>
                  <h4 className="text-xs font-semibold text-warning font-mono uppercase tracking-wider">
                    {pendingMissed.length} Missed Cron Job(s) Pending Action
                  </h4>
                </div>
                <button
                  onClick={handleDismissAllMissed}
                  className="px-2.5 py-1 text-[10px] font-mono text-warning hover:text-warning/80 border border-warning/30 hover:border-warning/50 rounded-md hover:bg-warning/10 transition-colors"
                >
                  Dismiss All
                </button>
              </div>
              <p className="text-[11px] font-mono text-bone-dim mb-3 leading-relaxed">
                These scheduled runs passed while Jarvis was closed. Choose to execute them now, or dismiss to skip to their next scheduled interval.
              </p>
              <div className="space-y-2">
                {pendingMissed.map((m) => (
                  <div key={m.id} className="flex items-center justify-between p-2.5 bg-obsidian/40 border border-iron/20 rounded-lg flex-wrap gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-bone truncate">{m.name}</div>
                      <div className="text-[10px] font-mono text-bone-faint mt-0.5">
                        Schedule: <span className="text-cyan-glow">{m.schedule}</span> · Was due: <span className="text-bone-muted">{m.next_run ? formatAge(m.next_run) : '—'}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleDismissMissed(m.id, m.name)}
                        className="px-2.5 py-1 text-[10px] font-mono border border-iron/40 rounded-md text-bone-dim hover:text-bone hover:border-iron/60 transition-colors"
                      >
                        Dismiss
                      </button>
                      <button
                        onClick={() => handleTriggerMissed(m.id, m.name)}
                        className="px-2.5 py-1 text-[10px] font-mono bg-cyan-neon/15 border border-cyan-neon/30 rounded-md text-cyan-glow hover:bg-cyan-neon/25 transition-colors font-semibold"
                      >
                        Trigger Now
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      {jobs.length === 0 ? (
        <EmptyState message="No cron jobs configured" />
      ) : (
        <AnimatedList>
          {jobs.map((job) => (
            <CronJobCard key={job.id} job={job} onRefresh={fetchJobs} isInFlight={inFlightIds.has(job.id)} />
          ))}
        </AnimatedList>
      )}
    </PageTransition>
  );
}