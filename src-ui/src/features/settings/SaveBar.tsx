import { Check, RotateCcw } from 'lucide-react';
import { AlertLine, Button, StatusLine } from '../../design';

/**
 * Sticky bottom bar for the config draft. It appears while the draft is dirty
 * and stays through the save so the saving / saved / failed sentences have a
 * home. Pinned strings: "Saving config...", "Config saved.", "Could not save
 * config. Your edits are preserved. Retry to save configuration."
 */
export function SaveBar({
  dirty,
  saving,
  saved,
  saveError,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  saveError: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!dirty && !saving && !saved && !saveError) return null;
  return (
    <div className="sticky bottom-4 z-20 d-rise">
      <div className="space-y-2.5 rounded-[10px] border border-line-strong bg-overlay px-4 py-3 shadow-pop">
        {saveError && (
          <AlertLine retryLabel="Retry save config" onRetry={onSave} retryDisabled={saving}>
            Could not save config. Your edits are preserved. Retry to save configuration.
          </AlertLine>
        )}
        {saving && <StatusLine>Saving config...</StatusLine>}
        {saved && (
          <StatusLine busy={false} tone="ok">
            Config saved.
          </StatusLine>
        )}
        <div className="flex items-center justify-between gap-4">
          <p className="d-label">{dirty ? 'Unsaved changes' : saved ? 'Up to date' : 'Nothing to save'}</p>
          <div className="flex items-center gap-2">
            {dirty && (
              <Button variant="ghost" icon={<RotateCcw />} onClick={onDiscard} disabled={saving}>
                Discard
              </Button>
            )}
            <Button variant="primary" size="md" busy={saving} icon={saved && !saving ? <Check /> : undefined} onClick={onSave} disabled={saving}>
              {saving ? 'Saving...' : saved ? 'Saved' : 'Save Config'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
