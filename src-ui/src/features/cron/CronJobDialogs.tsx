import { invoke } from '@tauri-apps/api/core';
import { useMemo, useRef, useState } from 'react';
import { AlertLine, Button, cn, Dialog, Field, Input, StatusLine, Textarea, useToast } from '../../design';
import { JOB_TYPES, type CronJob, type CronJobDraft, type CronJobType } from './cron-model';
import { describeSchedule } from './cron-schedule';

// ── Prompt preview ───────────────────────────────────────────────────────────

function PromptPreview({ prompt }: { prompt: string }) {
  const wordCount = prompt.trim().split(/\s+/).filter(Boolean).length;
  const charCount = prompt.length;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-sunken">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="d-label">Prompt Preview</span>
        <span className="font-mono text-[10.5px] text-ink-4 tabular">{wordCount} words · {charCount} chars</span>
      </div>
      <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-relaxed text-ink-3">
        {prompt || <span className="italic text-ink-4">No prompt yet…</span>}
      </pre>
    </div>
  );
}

// ── Add job ──────────────────────────────────────────────────────────────────

/**
 * Mounted only while open, so closing it discards the draft and reopening
 * starts from the Learning Session defaults. While `creating`, every field,
 * Cancel and every dismissal path (×, Escape, backdrop) is inert.
 */
export function AddJobDialog({
  onCreate,
  onCancel,
  creating,
  createError,
}: {
  onCreate: (draft: CronJobDraft) => Promise<void>;
  onCancel: () => void;
  creating: boolean;
  createError: boolean;
}) {
  const [jobType, setJobType] = useState<CronJobType>('learning');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState(JOB_TYPES[0].schedulePresets[0]?.expr ?? '');
  const [customExpr, setCustomExpr] = useState('');
  const [isCustomSchedule, setIsCustomSchedule] = useState(false);
  const [prompt, setPrompt] = useState(JOB_TYPES[0].defaultPrompt);
  const [agentId, setAgentId] = useState('jarvis');
  const [showPreview, setShowPreview] = useState(true);
  const nameRef = useRef<HTMLInputElement>(null);

  const typeConfig = useMemo(() => JOB_TYPES.find((t) => t.id === jobType)!, [jobType]);

  const handleTypeChange = (newType: CronJobType) => {
    if (creating) return;
    setJobType(newType);
    const config = JOB_TYPES.find((t) => t.id === newType)!;
    setPrompt(config.defaultPrompt);
    setPreset(config.schedulePresets[0]?.expr || '');
    setIsCustomSchedule(false);
    setCustomExpr('');
    if (!name.trim()) setName(config.label);
  };

  const expr = isCustomSchedule ? customExpr : preset;
  const incomplete = !name.trim() || !expr.trim() || !prompt.trim();

  const handleSubmit = () => {
    if (creating || incomplete) return;
    void onCreate({
      name: name.trim(),
      schedule: expr.trim(),
      prompt: prompt.trim(),
      agentId: agentId.trim() || 'jarvis',
    });
  };

  const schedulePresets = typeConfig.schedulePresets;
  const showCustomInput = isCustomSchedule || (preset !== '' && !schedulePresets.some((p) => p.expr === preset));
  const described = expr.trim() ? describeSchedule(expr) : null;

  return (
    <Dialog
      open
      size="lg"
      label="Add cron job"
      title="Add Cron Job"
      description="A cron job hands a prompt to an Agent on a schedule and records every run."
      busy={creating}
      hideClose={creating}
      onClose={() => {
        if (!creating) onCancel();
      }}
      initialFocusRef={nameRef}
      className="max-h-[84vh] overflow-y-auto"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onCancel} disabled={creating}>
            Cancel
          </Button>
          <Button variant="primary" size="md" busy={creating} onClick={handleSubmit} disabled={creating || incomplete}>
            {creating ? 'Adding…' : 'Add Job'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {creating && (
          <StatusLine>Adding cron job. The submitted draft is locked until the request completes.</StatusLine>
        )}

        {createError && (
          <AlertLine onRetry={handleSubmit} retryDisabled={creating || incomplete}>
            Could not add cron job. Your draft has been kept.
          </AlertLine>
        )}

        <fieldset disabled={creating} className="m-0 min-w-0 space-y-4 border-0 p-0">
          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-ink-2">Job Type</span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {JOB_TYPES.map((type) => {
                const selected = jobType === type.id;
                const Icon = type.icon;
                return (
                  <button
                    key={type.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => handleTypeChange(type.id)}
                    className={cn(
                      'rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                      selected ? 'border-accent-line bg-accent-wash' : 'border-line bg-sunken hover:border-line-strong',
                    )}
                  >
                    <div className="mb-1 flex items-center gap-1.5">
                      <Icon aria-hidden="true" className={cn('size-3.5', selected ? 'text-accent-hot' : 'text-ink-3')} />
                      <span className={cn('text-[12.5px] font-medium', selected ? 'text-ink' : 'text-ink-2')}>{type.label}</span>
                    </div>
                    <p className="text-[11px] leading-snug text-ink-3">{type.description}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Name">
              {(id) => (
                <Input
                  id={id}
                  ref={nameRef}
                  type="text"
                  value={name}
                  onChange={(e) => {
                    if (!creating) setName(e.target.value);
                  }}
                  placeholder={typeConfig.label}
                />
              )}
            </Field>
            <Field label="Agent">
              {(id) => (
                <Input
                  id={id}
                  mono
                  type="text"
                  value={agentId}
                  onChange={(e) => {
                    if (!creating) setAgentId(e.target.value);
                  }}
                  placeholder="jarvis"
                />
              )}
            </Field>
          </div>

          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-ink-2">Schedule</span>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {schedulePresets.map((p) => {
                const selected = (!isCustomSchedule && preset === p.expr) || (isCustomSchedule && p.label === 'Custom');
                return (
                  <button
                    key={p.label}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      if (creating) return;
                      if (p.label === 'Custom') {
                        setIsCustomSchedule(true);
                        setPreset('');
                      } else {
                        setIsCustomSchedule(false);
                        setPreset(p.expr);
                      }
                    }}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                      selected
                        ? 'border-accent-line bg-accent-wash text-accent-hot'
                        : 'border-line-strong text-ink-3 hover:border-ink-4 hover:text-ink-2',
                    )}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            {(showCustomInput || isCustomSchedule) && (
              <Input
                mono
                type="text"
                aria-label="Cron expression"
                value={customExpr}
                onChange={(e) => {
                  if (!creating) setCustomExpr(e.target.value);
                }}
                placeholder="*/5 * * * *"
              />
            )}
            <p className="mt-1.5 font-mono text-[11px] text-ink-3">
              {expr.trim() ? (
                <>
                  <span className="text-ink-2">{expr.trim()}</span>
                  {described ? ` — ${described}` : ''}
                </>
              ) : (
                'Choose a preset or enter a five-field cron expression.'
              )}
            </p>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="cron-add-prompt" className="text-[12px] font-medium text-ink-2">
                Prompt
              </label>
              <button
                type="button"
                onClick={() => {
                  if (!creating) setShowPreview(!showPreview);
                }}
                className="text-[11px] text-ink-3 transition-colors hover:text-ink"
              >
                {showPreview ? 'Hide Preview' : 'Show Preview'}
              </button>
            </div>
            <Textarea
              id="cron-add-prompt"
              mono
              value={prompt}
              onChange={(e) => {
                if (!creating) setPrompt(e.target.value);
              }}
              rows={6}
              placeholder="What should this cron job do?"
              className="resize-none"
            />
            {showPreview && (
              <div className="mt-3">
                <PromptPreview prompt={prompt} />
              </div>
            )}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

// ── Edit job ─────────────────────────────────────────────────────────────────

export function EditJobDialog({
  job,
  onClose,
  onSave,
}: {
  job: CronJob;
  onClose: () => void;
  onSave: (job: CronJob) => void;
}) {
  const { success, error: toastError } = useToast();
  const [name, setName] = useState(job.name);
  const [schedule, setSchedule] = useState(job.schedule);
  const [prompt, setPrompt] = useState(job.prompt);
  const [agentId, setAgentId] = useState(job.agent_id);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const described = describeSchedule(schedule);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await invoke<CronJob>('edit_cron_job', {
        id: job.id,
        patch: { name, schedule, prompt, agent_id: agentId },
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
    <Dialog
      open
      size="lg"
      label="Edit cron job"
      title="Edit Cron Job"
      description={job.name}
      busy={saving}
      onClose={() => {
        if (!saving) onClose();
      }}
      initialFocusRef={nameRef}
      className="max-h-[84vh] overflow-y-auto"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="md" busy={saving} onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <fieldset disabled={saving} className="m-0 min-w-0 space-y-4 border-0 p-0">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Agent">{(id) => <Input id={id} mono value={agentId} onChange={(e) => setAgentId(e.target.value)} />}</Field>
        </div>
        <Field label="Schedule" hint={described ? `Runs ${described}.` : undefined}>
          {(id) => <Input id={id} mono value={schedule} onChange={(e) => setSchedule(e.target.value)} />}
        </Field>
        <Field label="Prompt">
          {(id) => <Textarea id={id} mono rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="resize-none" />}
        </Field>
      </fieldset>
    </Dialog>
  );
}
