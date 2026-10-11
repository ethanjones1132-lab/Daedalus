import { Trash2, Zap } from 'lucide-react';
import { Badge, Button, Chip, Panel, Skeleton, Stat, StatusDot, formatAge } from '../../design';
import { backendInfo, backendLabel } from './backends';
import type { ModelProfile } from './types';

/** "34d ago" / "5h ago" — coarse on purpose; a profile's age needs no minutes. */
function ageLabel(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return '';
  const ms = Date.now() - t;
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `Created ${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `Created ${hours}h ago`;
  return `Created ${formatAge(ms)}`;
}

function BackendBadge({ provider }: { provider: string }) {
  const info = backendInfo(provider);
  return (
    <Badge tone={info ? (info.local ? 'ok' : 'info') : 'neutral'}>
      {backendLabel(provider)}
      {info ? ` · ${info.local ? 'local' : 'cloud'}` : ''}
    </Badge>
  );
}

/** The one hero panel of the page: the profile new Session turns use. */
export function ActiveProfileHero({
  profile,
  observed,
  locked,
  onDelete,
}: {
  profile: ModelProfile | null;
  /** Whether the profile list has ever been successfully observed. */
  observed: boolean;
  locked: boolean;
  onDelete: (profile: ModelProfile) => void;
}) {
  if (!profile) {
    return (
      <Panel ticks aria-label="Active profile" className="d-rise">
        <div className="d-label mb-2">Active profile</div>
        {observed ? (
          <>
            <p className="d-display text-[30px] text-ink-2">No active profile.</p>
            <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-ink-3">
              Activate a profile below to choose the model, temperature, and token budget for new Session turns.
            </p>
          </>
        ) : (
          <>
            <div className="space-y-2.5" aria-hidden="true">
              <Skeleton className="h-8 w-56" />
              <Skeleton className="h-4 w-80" />
            </div>
            <p className="mt-3 text-[12.5px] text-ink-3">Active profile not yet observed.</p>
          </>
        )}
      </Panel>
    );
  }
  return (
    <ul>
      <Panel ticks as="li" className="d-rise">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="d-label mb-2 flex items-center gap-2 text-accent">
              <StatusDot tone="accent" live />
              Active profile
            </div>
            <h2 className="d-display text-[38px] leading-[1.05] text-ink">{profile.name}</h2>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <BackendBadge provider={profile.provider} />
              <Chip>{profile.model}</Chip>
              <Chip>engine {profile.engine}</Chip>
              <Badge tone="ok" dot>
                active
              </Badge>
            </div>
          </div>
          <Button variant="ghost" size="sm" icon={<Trash2 />} onClick={() => onDelete(profile)} disabled={locked} className="hover:bg-err-wash hover:text-err">
            Delete
          </Button>
        </div>
        <div className="mt-6 grid grid-cols-3 gap-6 border-t border-line pt-5">
          <Stat label="Temperature" value={profile.temperature} sub="sampling randomness" />
          <Stat label="Max tokens" value={profile.max_tokens.toLocaleString('en-US')} sub="per response" />
          <Stat label="Top P" value={profile.top_p} sub="nucleus mass" />
        </div>
        {profile.api_base && (
          <p className="mt-4 truncate font-mono text-[11px] text-ink-3" title={profile.api_base}>
            {profile.api_base}
          </p>
        )}
      </Panel>
    </ul>
  );
}

/** A saved profile that is not active. */
export function ProfileCard({
  profile,
  locked,
  onActivate,
  onDelete,
}: {
  profile: ModelProfile;
  locked: boolean;
  onActivate: (profile: ModelProfile) => void;
  onDelete: (profile: ModelProfile) => void;
}) {
  return (
    <Panel as="li" interactive className="flex flex-col gap-3">
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-[14px] font-semibold text-ink">{profile.name}</h3>
          <BackendBadge provider={profile.provider} />
        </div>
        <p className="mt-1 truncate font-mono text-[11.5px] text-ink-2" title={profile.model}>
          {profile.model}
        </p>
        <p className="mt-0.5 font-mono text-[10.5px] text-ink-4">engine {profile.engine}</p>
      </div>
      <dl className="grid grid-cols-3 gap-2 border-t border-line pt-3 tabular">
        {(
          [
            ['temp', profile.temperature],
            ['top_p', profile.top_p],
            ['tokens', profile.max_tokens],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="d-label">{k}</dt>
            <dd className="font-mono text-[13px] text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="truncate text-[11px] text-ink-4">{ageLabel(profile.created_at)}</span>
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="xs" icon={<Zap />} onClick={() => onActivate(profile)} disabled={locked}>
            Activate
          </Button>
          <Button variant="ghost" size="xs" onClick={() => onDelete(profile)} disabled={locked} className="hover:text-err">
            Delete
          </Button>
        </div>
      </div>
    </Panel>
  );
}
