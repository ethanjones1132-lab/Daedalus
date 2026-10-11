import { useRef, type ReactNode } from 'react';
import { Button, Dialog, Field, Input, cn } from '../../design';
import type { ModelProfileDraft } from '../../domain/model-profile-creation-state';
import { BACKENDS } from './backends';

const FORM_ID = 'new-profile-form';

const numberOrNaN = (value: string) => (value === '' ? Number.NaN : Number(value));

export interface ProfileCreateDialogProps {
  open: boolean;
  draft: ModelProfileDraft;
  onDraftChange: (patch: Partial<ModelProfileDraft>) => void;
  /** True while the write or its readback is in flight: every field is frozen. */
  creating: boolean;
  onSubmit: () => void;
  onClose: () => void;
  /** Status / alert lines for the creation operation, rendered inside the dialog. */
  feedback?: ReactNode;
}

/** The "New profile" form. Behaviour lives in ModelsPage; this is presentation only. */
export function ProfileCreateDialog({ open, draft, onDraftChange, creating, onSubmit, onClose, feedback }: ProfileCreateDialogProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const edit = (patch: Partial<ModelProfileDraft>) => {
    if (creating) return;
    onDraftChange(patch);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="New profile"
      title="New profile"
      description="A saved inference configuration. Activate it to make it the default for new Session turns."
      initialFocusRef={nameRef}
      busy={creating}
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button variant="primary" size="md" type="submit" form={FORM_ID} busy={creating} disabled={creating}>
            Create profile
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <fieldset disabled={creating} className="m-0 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3.5 border-0 p-0">
          <Field label="Name" className="col-span-2">
            {(id) => (
              <Input
                id={id}
                ref={nameRef}
                type="text"
                value={draft.name}
                placeholder="Daily coding"
                onChange={(e) => edit({ name: e.target.value })}
              />
            )}
          </Field>

          <Field label="Backend" hint="Which Inference backend serves this profile." className="col-span-2">
            {(id) => (
              <>
                <Input id={id} type="text" mono value={draft.backend} onChange={(e) => edit({ backend: e.target.value })} />
                <div className="flex flex-wrap gap-1">
                  {BACKENDS.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      aria-label={`Use backend ${b.id}`}
                      aria-pressed={draft.backend === b.id}
                      onClick={() => edit({ backend: b.id })}
                      className={cn(
                        'h-5 rounded-[4px] border px-1.5 font-mono text-[10.5px] transition-colors',
                        draft.backend === b.id
                          ? 'border-accent-line bg-accent-wash text-accent-hot'
                          : 'border-line text-ink-3 hover:border-line-strong hover:text-ink-2',
                      )}
                    >
                      {b.id}
                    </button>
                  ))}
                </div>
              </>
            )}
          </Field>

          <Field label="Model" hint="The model id the backend understands." className="col-span-2">
            {(id) => <Input id={id} type="text" mono value={draft.model} placeholder="qwen/qwen3-coder:free" onChange={(e) => edit({ model: e.target.value })} />}
          </Field>

          <Field label="Max tokens">
            {(id) => (
              <Input
                id={id}
                type="number"
                min="1"
                step="1"
                mono
                value={Number.isNaN(draft.maxTokens) ? '' : draft.maxTokens}
                onChange={(e) => edit({ maxTokens: numberOrNaN(e.target.value) })}
              />
            )}
          </Field>

          <Field label="Temperature">
            {(id) => (
              <Input
                id={id}
                type="number"
                min="0"
                max="2"
                step="0.1"
                mono
                value={Number.isNaN(draft.temperature) ? '' : draft.temperature}
                onChange={(e) => edit({ temperature: numberOrNaN(e.target.value) })}
              />
            )}
          </Field>

          <Field label="Top P">
            {(id) => (
              <Input
                id={id}
                type="number"
                min="0"
                max="1"
                step="0.1"
                mono
                value={Number.isNaN(draft.topP) ? '' : draft.topP}
                onChange={(e) => edit({ topP: numberOrNaN(e.target.value) })}
              />
            )}
          </Field>

          <Field label="Engine" hint="native, or claude_cli.">
            {(id) => <Input id={id} type="text" mono value={draft.engine} onChange={(e) => edit({ engine: e.target.value })} />}
          </Field>
        </fieldset>
      </form>
      {feedback && <div className="mt-4 space-y-2">{feedback}</div>}
    </Dialog>
  );
}
