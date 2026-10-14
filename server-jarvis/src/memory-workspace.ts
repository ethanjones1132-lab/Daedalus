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
 * candidate only when the current raw request names no workspace and the
 * existing Tool runtime/sandbox authorization accepts the candidate as a write
 * root. The candidate is never passed as its own `workspaceOverride` during
 * authorization, so a bound project cannot authorize itself.
 *
 * Precedence: a path the user names in the CURRENT raw message wins outright —
 * the ordinary affinity result is returned and `scope_mismatch` is reported
 * when it conflicts with the binding. Otherwise a valid authenticated binding
 * supersedes any older explicit path recovered from conversation history. When
 * there is no usable binding, ordinary history-based affinity fallback is
 * preserved.
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
  // Only a path named in the CURRENT raw message outranks an authenticated
  // binding. An older explicit path from history does not: a valid binding
  // supersedes that stale choice, while a current explicit message still wins.
  const explicitInMessage = findExistingWorkspacePath(rawMessage);

  if (explicitInMessage !== undefined) {
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
