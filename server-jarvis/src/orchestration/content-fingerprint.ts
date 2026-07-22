import { createHash } from "crypto";
import { promises as fs } from "fs";

export interface ContentFingerprint {
  path: string;
  exists: boolean;
  bytes: number;
  sha256: string | null;
}

export interface WriteEffectObservation {
  toolName: string;
  path: string;
  before: ContentFingerprint;
  after: ContentFingerprint;
  changed: boolean;
}

export interface WriteEffectSink {
  write_effects?: WriteEffectObservation[];
}

export function fingerprintBytes(content: string | Uint8Array, path: string): ContentFingerprint {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return {
    path,
    exists: true,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function fingerprintFile(path: string): Promise<ContentFingerprint> {
  try {
    return fingerprintBytes(await fs.readFile(path), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    return { path, exists: false, bytes: 0, sha256: null };
  }
}

export function recordWriteEffect(
  sink: WriteEffectSink,
  observation: Omit<WriteEffectObservation, "changed">,
): void {
  if (!sink.write_effects) return;
  sink.write_effects.push({
    ...observation,
    changed: observation.before.sha256 !== observation.after.sha256
      || observation.before.exists !== observation.after.exists,
  });
}

export function hasContentDelta(observations: readonly WriteEffectObservation[]): boolean {
  return observations.some((observation) => observation.changed);
}
