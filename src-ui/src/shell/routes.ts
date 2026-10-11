import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import {
  Activity,
  Bot,
  BookMarked,
  Brain,
  Cable,
  CalendarClock,
  Cpu,
  Gauge,
  Handshake,
  HardDrive,
  LayoutDashboard,
  MessagesSquare,
  Network,
  Plug,
  Radio,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

/*
 * The route registry is the single source of truth for navigation: the rail,
 * the command palette, the titlebar breadcrumb, and persisted-view restore
 * all read from here. Every legacy ViewId resolves through `ALIASES`, so no
 * persisted or programmatic id can land on an unrouted surface.
 */

export type RouteId =
  | 'sessions'
  | 'overview'
  | 'agents'
  | 'skills'
  | 'memory'
  | 'models'
  | 'cron'
  | 'actions'
  | 'hooks'
  | 'commitments'
  | 'approvals'
  | 'channels'
  | 'plugins'
  | 'mcp'
  | 'devices'
  | 'nodes'
  | 'health'
  | 'settings'
  | 'gateway'
  | 'hermes';

export type RouteGroup = 'Work' | 'Build' | 'Automate' | 'Connect' | 'System';

export interface RouteDef {
  id: RouteId;
  label: string;
  group: RouteGroup;
  icon: LucideIcon;
  /** One-line purpose, shown in the palette. */
  description: string;
  /** Extra search terms for the palette. */
  keywords?: string[];
  /** Legacy surfaces stay reachable but are visually de-emphasised. */
  legacy?: boolean;
  component: LazyExoticComponent<ComponentType>;
}

export const ROUTES: RouteDef[] = [
  {
    id: 'sessions',
    label: 'Sessions',
    group: 'Work',
    icon: MessagesSquare,
    description: 'Converse with Jarvis — Session turns, activity, and recorded runs',
    keywords: ['chat', 'jarvis', 'conversation', 'turn', 'history'],
    component: lazy(() => import('../features/sessions/SessionsPage')),
  },
  {
    id: 'overview',
    label: 'Overview',
    group: 'Work',
    icon: LayoutDashboard,
    description: 'The pulse of the whole system at a glance',
    keywords: ['dashboard', 'home', 'pulse', 'summary'],
    component: lazy(() => import('../features/overview/OverviewPage')),
  },
  {
    id: 'agents',
    label: 'Agents',
    group: 'Build',
    icon: Bot,
    description: 'Agent directories, soul.md, lifecycle and bindings',
    keywords: ['soul', 'lifecycle', 'projection', 'discover'],
    component: lazy(() => import('../features/agents/AgentsPage')),
  },
  {
    id: 'skills',
    label: 'Skills',
    group: 'Build',
    icon: Sparkles,
    description: 'Installed skills, eligibility, and promoted candidates',
    component: lazy(() => import('../features/skills/SkillsPage')),
  },
  {
    id: 'memory',
    label: 'Memory',
    group: 'Build',
    icon: Brain,
    description: 'What Jarvis remembers, and recall',
    keywords: ['recall', 'facts'],
    component: lazy(() => import('../features/memory/MemoryPage')),
  },
  {
    id: 'models',
    label: 'Inference',
    group: 'Build',
    icon: Cpu,
    description: 'Model profiles and inference backends',
    keywords: ['models', 'profiles', 'backend', 'ollama', 'llama.cpp', 'openrouter', 'discover'],
    component: lazy(() => import('../features/models/ModelsPage')),
  },
  {
    id: 'cron',
    label: 'Cron',
    group: 'Automate',
    icon: CalendarClock,
    description: 'Scheduled jobs, runs, and missed-job recovery',
    keywords: ['schedule', 'jobs', 'timer'],
    component: lazy(() => import('../features/cron/CronPage')),
  },
  {
    id: 'actions',
    label: 'Actions',
    group: 'Automate',
    icon: Workflow,
    description: 'The action registry and its alerts',
    keywords: ['registry', 'action-registry'],
    component: lazy(() => import('../features/actions/ActionsPage')),
  },
  {
    id: 'hooks',
    label: 'Hooks',
    group: 'Automate',
    icon: Webhook,
    description: 'Event hooks and their handlers',
    component: lazy(() => import('../features/hooks/HooksPage')),
  },
  {
    id: 'commitments',
    label: 'Commitments',
    group: 'Automate',
    icon: Handshake,
    description: 'Promises Jarvis has made and their status',
    component: lazy(() => import('../features/commitments/CommitmentsPage')),
  },
  {
    id: 'approvals',
    label: 'Approvals',
    group: 'Automate',
    icon: ShieldCheck,
    description: 'Approval history (legacy store — live approvals happen inside a Session turn)',
    keywords: ['permission', 'policy'],
    component: lazy(() => import('../features/approvals/ApprovalsPage')),
  },
  {
    id: 'channels',
    label: 'Channels',
    group: 'Connect',
    icon: Radio,
    description: 'Channel bindings, receipts, and delivery',
    component: lazy(() => import('../features/channels/ChannelsPage')),
  },
  {
    id: 'plugins',
    label: 'Plugins',
    group: 'Connect',
    icon: Plug,
    description: 'Installed plugins',
    component: lazy(() => import('../features/plugins/PluginsPage')),
  },
  {
    id: 'mcp',
    label: 'MCP',
    group: 'Connect',
    icon: Cable,
    description: 'Model Context Protocol servers and tools',
    keywords: ['mcp', 'servers', 'tools'],
    component: lazy(() => import('../features/mcp/McpPage')),
  },
  {
    id: 'devices',
    label: 'Devices',
    group: 'Connect',
    icon: HardDrive,
    description: 'Paired devices',
    component: lazy(() => import('../features/devices/DevicesPage')),
  },
  {
    id: 'nodes',
    label: 'Nodes',
    group: 'Connect',
    icon: Network,
    description: 'Compute nodes',
    component: lazy(() => import('../features/nodes/NodesPage')),
  },
  {
    id: 'health',
    label: 'Health',
    group: 'System',
    icon: Activity,
    description: 'Services, diagnostics, doctor report, restarts, build provenance',
    keywords: ['status', 'doctor', 'diagnostics', 'restart', 'bun', 'telemetry', 'control'],
    component: lazy(() => import('../features/health/HealthPage')),
  },
  {
    id: 'settings',
    label: 'Settings',
    group: 'System',
    icon: Settings2,
    description: 'Configuration, inference backend, keys, theme',
    keywords: ['config', 'configuration', 'preferences', 'theme', 'keys'],
    component: lazy(() => import('../features/settings/SettingsPage')),
  },
  {
    id: 'gateway',
    label: 'Gateway',
    group: 'System',
    icon: Server,
    description: 'Legacy gateway surface',
    legacy: true,
    component: lazy(() => import('../features/legacy/GatewayPage')),
  },
  {
    id: 'hermes',
    label: 'Hermes',
    group: 'System',
    icon: BookMarked,
    description: 'Legacy Hermes bridge (removed from the chat path)',
    legacy: true,
    component: lazy(() => import('../features/legacy/HermesPage')),
  },
];

export const GROUP_ORDER: RouteGroup[] = ['Work', 'Build', 'Automate', 'Connect', 'System'];

/** Every legacy ViewId (and a few natural synonyms) → canonical route. */
export const ALIASES: Record<string, RouteId> = {
  jarvis: 'sessions',
  'jarvis-hub': 'sessions',
  'jarvis-chat': 'sessions',
  'jarvis-sessions': 'sessions',
  'jarvis-companion': 'sessions',
  'chat-feeds': 'sessions',
  chat: 'sessions',
  'jarvis-skills': 'skills',
  'action-registry': 'actions',
  control: 'health',
  'jarvis-tools': 'health',
  'jarvis-status': 'health',
  doctor: 'health',
  logs: 'health',
  config: 'settings',
  'jarvis-config': 'settings',
  instances: 'overview',
  usage: 'overview',
};

export const DEFAULT_ROUTE: RouteId = 'sessions';

const BY_ID = new Map(ROUTES.map((r) => [r.id, r]));

export function resolveRoute(id: string | null | undefined): RouteId {
  if (!id) return DEFAULT_ROUTE;
  if (BY_ID.has(id as RouteId)) return id as RouteId;
  return ALIASES[id] ?? DEFAULT_ROUTE;
}

export function routeById(id: RouteId): RouteDef {
  return BY_ID.get(id)!;
}

/** A small marker used by health/overview widgets to deep-link. */
export const ROUTE_ICON_FALLBACK = Gauge;
