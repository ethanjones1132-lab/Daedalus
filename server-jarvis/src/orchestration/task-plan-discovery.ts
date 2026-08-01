/**
 * Guarded discovery of durable child plan items from explicit workspace plan
 * documents (GROUP_*_EXECUTION.md, checklist/roadmap/tasks markdown, etc.).
 *
 * Does not infer work from prose paragraphs — only numbered alphanumeric keys
 * under the requested group heading.
 */

import type { TaskPlanAcceptanceCheck } from "./task-run";

export interface DiscoveredPlanItem {
  /** External key from the plan document (e.g. "A1", "B2"). */
  externalKey: string;
  title: string;
  description?: string;
  acceptanceChecks: TaskPlanAcceptanceCheck[];
}

export interface DiscoverPlanItemsInput {
  path: string;
  content: string;
  /** Optional letter/digit group filter (e.g. "A" keeps A1–A4). */
  requestedGroup?: string;
}

const PLAN_BASENAME_RE =
  /(?:^|[/\\])[^/\\]*(?:plan|execution|checklist|roadmap|tasks)[^/\\]*\.(?:md|txt)$/i;

/** True when the path basename looks like an explicit plan/execution document. */
export function isPlanDocumentPath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  return PLAN_BASENAME_RE.test(trimmed.replace(/\\/g, "/"));
}

/**
 * Parse a requested group letter from a user message ("Execute Group A",
 * "GROUP_B tasks", "group-c plan").
 */
export function requestedPlanGroupFromMessage(message: string): string | undefined {
  const text = message.trim();
  if (!text) return undefined;
  const patterns = [
    /\bgroup[\s_-]*([A-Za-z])\b/i,
    /\bGROUP_([A-Za-z])(?:_|$|\b)/i,
    /\b(?:execute|complete|implement)\s+([A-Za-z])\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].toUpperCase();
  }
  return undefined;
}

function codeWorkAcceptanceChecks(externalKey: string): TaskPlanAcceptanceCheck[] {
  const key = externalKey.toLowerCase();
  return [
    {
      id: `ac_${key}_diff`,
      description: `${externalKey} produced a verified workspace mutation`,
      kind: "diff_match",
    },
    {
      id: `ac_${key}_check`,
      description: `${externalKey} passed an authoritative runtime/build check`,
      kind: "test_pass",
    },
  ];
}

/**
 * Heading shapes accepted as durable plan keys:
 *   ### A1 — title
 *   ## A2: title
 *   # B1. title
 *   - A3 Title (checklist line starting with key)
 */
const ITEM_HEADING_RE =
  /^(?:#{1,4}\s+|[-*•]\s*(?:\[[ xX]\]\s*)?)([A-Za-z]+\d+)\s*(?:[—–\-:.]|\s)\s*(.+?)\s*$/;

const GROUP_HEADING_RE = /^#{1,3}\s+Group\s+([A-Za-z0-9]+)\b/i;

/**
 * Extract ordered child items from an explicit plan document for one group.
 * Returns [] for non-plan paths or when fewer than one keyed heading is found.
 */
export function discoverPlanItems(input: DiscoverPlanItemsInput): DiscoveredPlanItem[] {
  if (!isPlanDocumentPath(input.path)) return [];

  const groupFilter = input.requestedGroup?.trim().toUpperCase() || undefined;
  const lines = input.content.split(/\r?\n/);

  const found: DiscoveredPlanItem[] = [];
  const seen = new Set<string>();
  let inRequestedGroup = groupFilter === undefined;
  let sawAnyGroupHeading = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const groupMatch = line.match(GROUP_HEADING_RE);
    if (groupMatch) {
      sawAnyGroupHeading = true;
      const groupKey = groupMatch[1].toUpperCase();
      if (groupFilter) {
        if (inRequestedGroup && groupKey !== groupFilter) {
          // Left the requested group — stop (do not collect later groups).
          break;
        }
        inRequestedGroup = groupKey === groupFilter || groupKey.startsWith(groupFilter);
      }
      continue;
    }

    if (!inRequestedGroup) continue;

    const itemMatch = line.match(ITEM_HEADING_RE);
    if (!itemMatch) continue;

    const externalKey = itemMatch[1].toUpperCase();
    // When no explicit Group heading exists, still filter by key prefix.
    if (groupFilter && !externalKey.startsWith(groupFilter)) continue;
    // If we have group headings and never entered the filter, skip (safety).
    if (groupFilter && sawAnyGroupHeading && !inRequestedGroup) continue;

    const normalizedKey = externalKey.toLowerCase();
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);

    const title = itemMatch[2].replace(/\*+/g, "").trim();
    if (title.length < 2) continue;

    found.push({
      externalKey,
      title,
      acceptanceChecks: codeWorkAcceptanceChecks(externalKey),
    });
  }

  return found;
}
