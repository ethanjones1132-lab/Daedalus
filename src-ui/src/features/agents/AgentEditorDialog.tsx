import { X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import type { AgentOperationPhase } from '../../domain/agent-operation-state';
import { AGENT_RECORD_FIELD_BASIS } from '../../domain/agent-routing-scope';
import { AlertLine, Button, Dialog, Field, Input, StatusLine, Textarea } from '../../design';
import type { AgentDraft } from './types';

/*
 * Create / edit an Agent identity. The draft is kept through a failed write so
 * Retry repeats the same normalized payload. While a write or its
 * reconciliation is in flight the fields freeze and nothing can dismiss the
 * dialog, so one create has exactly one lifetime.
 */
export function AgentEditorDialog({
  title,
  description,
  initial,
  onSave,
  onClose,
  locked = false,
  phase = null,
  failureMessage = 'Agent change failed. Your draft was kept.',
  onRetryRead,
}: {
  title: string;
  description: string;
  initial: AgentDraft;
  onSave: (draft: AgentDraft) => Promise<void>;
  onClose: () => void;
  locked?: boolean;
  phase?: AgentOperationPhase | null;
  failureMessage?: string;
  onRetryRead?: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const busy = locked || saving;
  const invalid = !draft.name.trim() || !draft.model.trim();

  const field = (key: keyof AgentDraft, value: string) => {
    if (!busy) setDraft((d) => ({ ...d, [key]: value }));
  };

  const submit = async () => {
    if (busy || invalid) return;
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  return (
    <Dialog
      open
      label={title}
      title={title}
      description={description}
      onClose={() => {
        if (!busy) onClose();
      }}
      hideClose
      busy={busy}
      initialFocusRef={nameRef}
      className="relative"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="md" onClick={() => void submit()} disabled={busy || invalid} busy={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        disabled={busy}
        className="absolute right-3.5 top-3.5 flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
      <form onSubmit={onSubmit} className="space-y-4">
        <fieldset disabled={busy} className="m-0 min-w-0 space-y-4 border-0 p-0">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name">
              {(id) => (
                <Input
                  id={id}
                  ref={nameRef}
                  placeholder="Name *"
                  value={draft.name}
                  onChange={(e) => field('name', e.target.value)}
                />
              )}
            </Field>
            <Field label="Model" hint={AGENT_RECORD_FIELD_BASIS}>
              {(id) => (
                <Input
                  id={id}
                  mono
                  placeholder="Model * (e.g. qwen2.5-coder:7b)"
                  value={draft.model}
                  onChange={(e) => field('model', e.target.value)}
                />
              )}
            </Field>
          </div>
          <Field label="Description">
            {(id) => (
              <Input
                id={id}
                placeholder="Description"
                value={draft.description}
                onChange={(e) => field('description', e.target.value)}
              />
            )}
          </Field>
          <Field label="System prompt">
            {(id) => (
              <Textarea
                id={id}
                mono
                rows={6}
                className="resize-none"
                placeholder="System prompt"
                value={draft.system_prompt}
                onChange={(e) => field('system_prompt', e.target.value)}
              />
            )}
          </Field>
        </fieldset>
        {phase === 'writing' && <StatusLine>Saving agent…</StatusLine>}
        {phase === 'reconciling' && <StatusLine>Change saved. Reconciling agents…</StatusLine>}
        {phase === 'write-failed' && (
          <AlertLine onRetry={() => void submit()} retryDisabled={saving || invalid}>{failureMessage}</AlertLine>
        )}
        {phase === 'read-failed' && (
          <AlertLine onRetry={onRetryRead} retryDisabled={saving}>
            Change saved, but the agent list could not be reconciled. Showing previous state. Retry reloads the list only.
          </AlertLine>
        )}
      </form>
    </Dialog>
  );
}
