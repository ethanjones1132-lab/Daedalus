# Daedalus — the Jarvis UI design system

Status: adopted with the ground-up UI rebuild (2026-10). Code lives in `src-ui/src/`.
Supersedes the "Mythos" OLED/violet/cyan glass aesthetic.

## 1. Concept

**A craftsman's drafting table, not a sci-fi HUD.** Jarvis is an instrument for
someone who builds things. The UI behaves like well-made tools: quiet until
something is happening, precise when it reports, never decorative at the cost
of truth.

- **Ink & bone.** A warm near-black canvas, layered by *value* (sunken → canvas →
  surface → raised → overlay), not by blur. Text in four strengths of bone.
- **One brass accent.** Brass means *live or chosen*: the active route, focus,
  the turn that is running, the primary action. If everything is brass,
  nothing is.
- **Hairlines carry structure.** 1px rules, a faint 32px drafting grid on page
  canvases, small corner registration ticks on the one hero panel per page.
- **Editorial type.** Instrument Serif for display (page titles, big numbers,
  empty-state headlines). Geist for UI. Geist Mono, uppercase, tracked, for
  annotations (`.d-label`), ids, and numbers.
- **Honest state.** Pending is not empty. Failed is not empty. Stale data says
  it is stale and offers Retry. Colour is never the only signal.

The labyrinth spiral mark (`<Mark/>`) is the signature. The companion is drawn
as a small brass automaton (`<Familiar/>`).

## 2. Tokens (Tailwind utilities)

Defined in `src/styles/app.css` (`:root` = dark "Ink", `[data-theme=light]` = "Vellum").

| Role | Utilities |
|---|---|
| Surfaces | `bg-sunken` (rail, wells, inputs) · `bg-canvas` (page) · `bg-surface` (panels) · `bg-raised` (selected rows, buttons) · `bg-overlay` (dialogs, popovers) · `bg-hover` / `bg-press` |
| Lines | `border-line` (default hairline) · `border-line-strong` (controls, emphasis) |
| Text | `text-ink` (primary) · `text-ink-2` (body secondary) · `text-ink-3` (meta) · `text-ink-4` (disabled, faint) |
| Accent | `text-accent` · `text-accent-hot` · `bg-accent` + `text-accent-ink` · `bg-accent-wash` · `border-accent-line` |
| Tones | `ok` (verdigris) · `warn` (flame) · `err` (ember) · `info` (sky), each with `-wash` |
| Type | `font-display` / `.d-display` · `font-mono` · `.d-label` (mono caps annotation) · `.tabular` |
| Texture | `.d-drafting` (grid) · `.d-ticks` (corner marks) · `.d-wire` (live filament) · `.d-skeleton` |
| Motion | `.d-rise` (enter) · `.d-pulse` · `.d-spin` · `.d-caret`; all disabled under `prefers-reduced-motion` |

Type scale: page title 38px serif · panel title 13px/600 · body 13.5px · meta 12px · label 10.5px mono caps · readout numbers 34px serif tabular.
Radii: controls 7px, panels 10px, dialogs 12px. Spacing on a 4px grid; page gutter 32px.

Never hard-code hex colours or Tailwind palette colours (`red-500`, `cyan-400`…) in features.

## 3. Components (`import { … } from '../../design'`)

| Component | Use |
|---|---|
| `Page`, `PageHeader` | Every routed page: `<Page><PageHeader eyebrow={group} title description actions>{tabs}</PageHeader>…</Page>` |
| `Panel`, `PanelHeader`, `Stat`, `KeyValue`, `RowList`, `Divider` | Surfaces and readouts. `Panel flush` + `RowList` for edge-to-edge lists |
| `Button` (`primary`/`secondary`/`ghost`/`danger`/`quiet`, sizes `xs`/`sm`/`md`, `icon`, `busy`), `IconButton` (requires `aria-label`) | Actions. One `primary` per view region |
| `Badge` (tone or legacy `variant`), `Chip`, `StatusDot` (`live`), `ToneText` | Status words, metadata, dots (always beside text) |
| `Input`, `Textarea`, `Select`, `Field` (render-prop id), `SearchInput`, `Switch`, `Segmented` | Forms |
| `Tabs` (real tablist, roving focus), `Disclosure` | Sub-navigation, expandable rows |
| `StatusLine` (role=status), `AlertLine` (role=alert + Retry), `EmptyState`, `Skeleton`, `VisuallyHidden` | **The only way** to express pending / failed / stale / empty |
| `Dialog`, `ConfirmModal`, `useDialogFocus`, `useDialogKeys` | Modals with the shared focus contract |
| `ToastProvider`, `useToast` | `info/success/warn/error(message, title?, options?, action?)` |
| `Meter`, `Dial`, `Sparkline`, `loadTone` | Instrument readouts |
| `Spinner`, `Kbd`, `Mark`, `ErrorBoundary` | Misc |
| `formatAge`, `formatIsoAge`, `formatCount`, `cn`, `toneOf` | Helpers |

If a feature needs a primitive that does not exist, build it locally in the feature
folder and propose it for `design/` in your report — do not edit `design/` or `shell/`.

## 4. Shell & navigation

`src/shell/`: `Rail` (collapsible, ⌘\\), titlebar (breadcrumb, ⌘K trigger, build badge,
theme), `HealthBanner` slot, page viewport, status strip (`SystemStatusBar`), `CommandPalette`.
Routes and every legacy ViewId alias live in `shell/routes.ts`. Pages navigate with
`useNavigation().navigate(routeId, params?)`; `params` carry one-shot intents
(e.g. `navigate('sessions', { sessionId })`).

Route groups: **Work** (Sessions, Overview) · **Build** (Agents, Skills, Memory, Inference)
· **Automate** (Cron, Actions, Hooks, Commitments, Approvals) · **Connect** (Channels,
Plugins, MCP, Devices, Nodes) · **System** (Health, Settings, legacy Gateway & Hermes).

## 5. Page anatomy & patterns

- **Masthead**: eyebrow = rail group, serif title, one-line description in CONTEXT.md
  vocabulary, actions right (Refresh as `ghost` + icon; primary create action).
- **Entity lists**: a `Panel flush` with a toolbar row (search, filters, count) and
  `RowList` rows (`px-4 py-3`, title 13px ink, meta line 12px ink-3, badges right,
  row actions as `IconButton`s that appear on hover *and* focus). Delete/remove
  controls are siblings of select controls, never nested.
- **Master–detail** when an entity has depth: list column (~380px) + detail panel.
- **Create/edit**: `Dialog` with `Field`s and a footer (Cancel `ghost`, Save `primary` `busy`).
  Freeze fields with `<fieldset disabled>` while pending.
- **Readouts**: `Stat` rows across the top of dashboards; `Dial`/`Meter` for utilisation
  (`loadTone`), always with the number as text.
- **Feedback placement**: `StatusLine`/`AlertLine` directly under the masthead or at the
  top of the panel they describe — never toasts alone for state that persists.

## 6. Voice (from CONTEXT.md)

Say **Session** (not chat/conversation), **Session turn**, **Inference backend** (not
provider/model when you mean the backend), **Agent**, **soul.md**, **Agent directory**,
**Bun server** (not gateway/API), **Tool runtime**, **Runtime projection**,
**Activation boundary**. The Hermes bridge is legacy and is not the chat path. The
Approvals page reads a legacy store; live tool approvals happen inside a Session turn.

Keep every existing accessible name, live-region label, and user-visible honest-state
sentence that tests pin. Restyle freely; do not reword pinned strings.

## 7. Motion

Enter with `.d-rise` (420ms, out-quint). Shared-layout indicators via framer-motion
`layoutId` (rail, tabs). Live work: `.d-wire`, `StatusDot live`, `.d-caret`. No
bounces, no parallax, no tilt. Everything respects `prefers-reduced-motion`.

## 8. Signature surfaces

- **Sessions** — three panes: Session index (left), transcript as a *document* (center,
  760px measure: user turns as brass-ruled prompts, answers as prose with a mark in the
  gutter, outcomes as tinted rules), **Inspector** (right: Activity, Run, Scope & grants,
  Recorded runs). A *live wire* runs above the composer while a turn streams, carrying
  the turn-progress sentence.
- **Overview** — "Pulse": a serif verdict sentence, companion, dials, stat row, recent
  Sessions, cron awareness, alerts.
- **Agents** — lifecycle rendered as a four-station track: discover → validate → project → activate.
- **Health** — an instrument panel of subsystem gauges, doctor checklist, build provenance.

## 9. Verification

- `npm run build` (tsc + vite) and `npx vitest run` must pass.
- Legacy behavioural tests are ported next to the new components and must pass; only
  imports/render plumbing and deliberately redesigned *non-pinned* visuals may change.
- Visual check: `npm run dev` then open `http://localhost:5173/?mock` — `src/dev/` serves
  Tauri IPC and Bun-server HTTP/SSE from fixtures (`src/dev/fixtures/<domain>.ts`).
