/** Native workflow presentation adapters. All controls share Shell design tokens. */
import type { HTMLAttributes, ReactNode } from 'react';
import { Panel, Badge, Page, PageHeader, StatusDot as Dot, StatusLine, AlertLine, EmptyState as Empty, ConfirmModal, useToast, cn, type Tone } from '../../design';
import type { StatusVariant } from '../../domain/tone';
export { ConfirmModal, useToast, cn };
export type { StatusVariant };
const tones: Record<string, Tone> = { success: 'ok', info: 'info', warn: 'warn', warning: 'warn', error: 'error', active: 'accent', default: 'muted' };
export function GlassCard({ children, className, hoverable: _hoverable, glowOnHover: _glow, ...props }: HTMLAttributes<HTMLDivElement> & { hoverable?: boolean; glowOnHover?: boolean }) { return <Panel className={cn('p-4',className)} {...props}>{children}</Panel>; }
export function Pill({ children, variant = 'default', className }: { children: ReactNode; variant?: string; className?: string }) { return <Badge tone={tones[variant] ?? 'muted'} className={className}>{children}</Badge>; }
export function StatusDot({ ok, warn, size: _size, variant }: { ok?: boolean; warn?: boolean; size?: string; variant?: StatusVariant }) { return <Dot tone={variant ? tones[variant] : ok ? 'ok' : warn ? 'warn' : 'muted'} />; }
export function SectionHeader({ title, subtitle, count, action, actions }: { title: ReactNode; subtitle?: ReactNode; count?: number; action?: ReactNode; actions?: ReactNode }) { return <PageHeader title={title} description={subtitle} actions={action ?? actions}>{count !== undefined && <span className="text-ink-3">{count} records</span>}</PageHeader>; }
export function LoadingState({ message = 'Loading…' }: { message?: string }) { return <StatusLine>{message}</StatusLine>; }
export function ErrorState({ message, error, onRetry }: { message?: string; error?: string; onRetry?: () => void }) { return <AlertLine onRetry={onRetry}>{message ?? error}</AlertLine>; }
export function EmptyState({ message }: { message: string }) { return <Empty title={message} />; }
export function PageTransition({ children }: { children: ReactNode }) { return <Page wide>{children}</Page>; }
export function AnimatedList({ children, className }: { children: ReactNode; className?: string }) { return <div className={cn('flex flex-col gap-3',className)}>{children}</div>; }
export function MetricBlock({ value, label, icon, tone: _tone }: { value: ReactNode; label: string; icon?: ReactNode; tone?: string }) { return <div><span aria-hidden="true">{icon}</span><p className="font-mono text-xl text-ink">{value}</p><p className="d-label">{label}</p></div>; }
