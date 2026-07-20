import { existsSync, statSync } from "fs";
import { basename, dirname, extname, isAbsolute, resolve } from "path";
import { toWslPath } from "../fs-scope";

function absoluteToken(token: string): boolean {
  return isAbsolute(token)
    || /^[a-zA-Z]:[\\/]/.test(token)
    || /^\\\\/.test(token)
    || /^\/\//.test(token)
    || /^\//.test(token);
}

function stripSentencePunctuation(token: string): string {
  return token.replace(/^[([{<]+/, "").replace(/[\])}>.,;:!?]+$/, "");
}

function nearestExistingDirectory(token: string): string | undefined {
  const candidate = resolve(process.platform === "win32" ? token : toWslPath(token));
  try {
    if (existsSync(candidate)) {
      return statSync(candidate).isDirectory() ? candidate : dirname(candidate);
    }
  } catch {
    return undefined;
  }

  // A missing directory is not authority. A file-shaped target may grant its
  // nearest existing parent so a requested new file can be created safely.
  if (!extname(basename(candidate))) return undefined;
  let current = dirname(candidate);
  while (current !== dirname(current)) {
    try {
      if (existsSync(current) && statSync(current).isDirectory()) return current;
    } catch {
      return undefined;
    }
    current = dirname(current);
  }
  return undefined;
}

/** Extract filesystem authority only from absolute path tokens in raw user text. */
export function extractRootGrants(message: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const tokens = message.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g);
  for (const match of tokens) {
    const token = stripSentencePunctuation(match[1] ?? match[2] ?? match[3] ?? "");
    if (!absoluteToken(token)) continue;
    const root = nearestExistingDirectory(token);
    if (!root) continue;
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}
