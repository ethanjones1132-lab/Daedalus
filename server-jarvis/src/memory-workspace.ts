// ─── Bound memory workspace resolution (Phase 4.2) ───────────────────────────
//
// A native project binding is a scope hint, never a filesystem grant. When the
// current request does not itself name a workspace, an authenticated native
// preparation may supply a working-root candidate for a new bound Session —
// but only after re-running the existing Tool runtime/sandbox authorization.
//
// This module deliberately has no database access and no durable state. It
// consumes references plus the existing `WorkspaceAffinityStore`, `fs-scope`
// authorization, and the owned in-memory native registry.

import type { JarvisConfig } from "./config";
import { resolveSafePath } from "./fs-scope";
import type { MemoryRecallStatus, MemoryScope } from "./memory-contract";
import type {
  NativeMemoryRegistry,
  ScopeCandidateIdentity,
} from "./native-memory";
import { pathsHaveSameIdentity } from "./orchestration/path-identity";
import {
  findExistingWorkspacePath,
  type WorkspaceAffinityStore,
  type WorkspaceHistoryMessage,
} from "./orchestration/workspace-affinity";

export interface BoundWorkspaceInput {
  /** Session whose turn is being resolved. Never a caller-supplied scope. */
  sessionId: string;
  /** Opaque native preparation reference, or null for an ordinary turn. */
  identity: ScopeCandidateIdentity | null;
  registry: NativeMemoryRegistry;
  affinity: WorkspaceAffinityStore;
  cfg: JarvisConfig;
  /** Raw current user message. The only source of a latest explicit choice. */
  rawMessage: string;
  /** Native prompt history for this Session. */
  history: readonly WorkspaceHistoryMessage[];
  /** Roots granted from the exact current request (or its continuation). */
  sessionGrants: readonly string[];
}

export interface BoundWorkspaceResolution {
  /** Effective workspace for this turn as the existing runtime would use it. */
  active_workspace: string;
  /**
   * Observable memory status when the authenticated project candidate could
   * not be used (unauthorized or conflicting). Never a permission decision.
   */
  memory_status: MemoryRecallStatus | null;
}

/**
 * The most recent explicit workspace path named by the user. The current raw
 * message wins; otherwise the latest user-authored history entry. This is the
 * "latest explicit choice" that a binding must never silently override.
 */
function latestExplicitWorkspace(
  rawMessage: string,
  history: readonly WorkspaceHistoryMessage[],
): string | undefined {
  const fromMessage = findExistingWorkspacePath(rawMessage);
  if (fromMessage) return fromMessage;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (!item || item.role !== "user") continue;
    const recovered = findExistingWorkspacePath(item.content);
    if (recovered) return recovered;
  }
  return undefined;
}

function candidateProjectRoot(
  identity: ScopeCandidateIdentity | null,
  registry: NativeMemoryRegistry,
): string | null {
  if (!identity) return null;
  const scope: MemoryScope | null = registry.inspectScopeCandidate(identity);
  if (!scope || scope.kind !== "project") return null;
  return scope.project_root;
}

/**
 * Resolve the turn's effective workspace from an authenticated project
 * candidate only when (a) the current request names no workspace at all and
 * (b) the existing Tool runtime/sandbox authorization accepts the candidate as
 * a write root. The candidate is never passed as its own `workspaceOverride`
 * during authorization, so a bound project cannot authorize itself.
 *
 * A latest explicit user path always wins: the ordinary affinity result is
 * returned and `scope_mismatch` is reported so native recall does not inject
 * the conflicting project's memory.
 */
export function resolveBoundMemoryWorkspace(input: BoundWorkspaceInput): BoundWorkspaceResolution {
  const {
    sessionId,
    identity,
    registry,
    affinity,
    cfg,
    rawMessage,
    history,
    sessionGrants,
  } = input;

  const candidateRoot = candidateProjectRoot(identity, registry);
  const explicit = latestExplicitWorkspace(rawMessage, history);

  if (explicit !== undefined) {
    // Latest explicit user choice is authoritative for this turn. A bound
    // project that conflicts is reported as a mismatch and never forced.
    const active = affinity.resolve(sessionId, rawMessage, [...history], cfg.jarvis_path);
    const conflict = candidateRoot !== null && !pathsHaveSameIdentity(candidateRoot, active);
    return { active_workspace: active, memory_status: conflict ? "scope_mismatch" : null };
  }

  if (candidateRoot !== null) {
    try {
      // No `workspaceOverride` here: the candidate must survive the ordinary
      // roots/grants policy on its own merits. `forWrite: true` forbids a
      // permissive-read path from becoming an implicit write root.
      const resolution = resolveSafePath(candidateRoot, cfg, {
        sessionGrants: [...sessionGrants],
        forWrite: true,
      });
      resolution.revalidate();
      if (pathsHaveSameIdentity(candidateRoot, resolution.canonicalPath)) {
        return { active_workspace: resolution.canonicalPath, memory_status: null };
      }
    } catch {
      // Denied or changed during authorization: fall through to ordinary
      // affinity and report an observable mismatch. No grant is created.
    }
    return {
      active_workspace: affinity.resolve(sessionId, rawMessage, [...history], cfg.jarvis_path),
      memory_status: "scope_mismatch",
    };
  }

  return {
    active_workspace: affinity.resolve(sessionId, rawMessage, [...history], cfg.jarvis_path),
    memory_status: null,
  };
}
