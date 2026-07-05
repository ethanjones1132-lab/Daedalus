import { existsSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute } from "path";

export interface WorkspaceHistoryMessage {
  role: string;
  content: string;
}

function existingRoot(candidate: string): string | undefined {
  let value = candidate.trim().replace(/[),.;:!?]+$/, "");
  while (value) {
    if (isAbsolute(value) && existsSync(value)) {
      try {
        const resolved = realpathSync(value);
        return statSync(resolved).isDirectory() ? resolved : dirname(resolved);
      } catch {
        return undefined;
      }
    }

    const shorter = value.replace(/\s+\S+$/, "").trim();
    if (shorter === value) break;
    value = shorter.replace(/[),.;:!?]+$/, "");
  }
  return undefined;
}

/** Return an existing directory explicitly named by the user, if any. */
export function findExistingWorkspacePath(message: string): string | undefined {
  const candidates: string[] = [];

  for (const match of message.matchAll(/(["'])(.*?)\1/g)) {
    if (match[2]) candidates.push(match[2]);
  }
  for (const pattern of [
    /[a-zA-Z]:[\\/][^\r\n"'<>|?*]*/g,
    /\\\\[^\\/\s]+[\\/][^\r\n"'<>|?*]*/g,
    /\/(?:[^\r\n"'<>|?*])*/g,
  ]) {
    for (const match of message.matchAll(pattern)) {
      if (match[0]) candidates.push(match[0]);
    }
  }

  for (const candidate of candidates) {
    const root = existingRoot(candidate);
    if (root) return root;
  }
  return undefined;
}

/** Bounded per-session root selection, recoverable from recent user history. */
export class WorkspaceAffinityStore {
  private readonly roots = new Map<string, string>();

  constructor(private readonly maxSessions = 256) {}

  resolve(
    sessionId: string,
    message: string,
    history: WorkspaceHistoryMessage[],
    fallbackRoot: string,
  ): string {
    const explicit = findExistingWorkspacePath(message);
    if (explicit) {
      this.remember(sessionId, explicit);
      return explicit;
    }

    const remembered = this.roots.get(sessionId);
    if (remembered && existsSync(remembered)) {
      this.remember(sessionId, remembered);
      return remembered;
    }

    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i];
      if (item.role !== "user") continue;
      const recovered = findExistingWorkspacePath(item.content);
      if (recovered) {
        this.remember(sessionId, recovered);
        return recovered;
      }
    }

    return fallbackRoot;
  }

  clear(sessionId: string): void {
    this.roots.delete(sessionId);
  }

  private remember(sessionId: string, root: string): void {
    this.roots.delete(sessionId);
    this.roots.set(sessionId, root);
    while (this.roots.size > this.maxSessions) {
      const oldest = this.roots.keys().next().value;
      if (!oldest) break;
      this.roots.delete(oldest);
    }
  }
}
