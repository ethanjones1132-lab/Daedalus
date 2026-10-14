// Test-only preload: global retrying rmSync to smooth Windows file-lock delays.
import { rmSync as nodeRmSync } from "fs";

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, ms);
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EBUSY";
}

(globalThis as any).rmSyncRetry = (path: any, options?: any) => {
  const retries = 50;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return nodeRmSync(path, options);
    } catch (error) {
      lastError = error;
      if (!isBusy(error) || attempt === retries) throw error;
      if ((globalThis as any).Bun?.gc) (globalThis as any).Bun.gc(true);
      sleepSync(100);
    }
  }
  throw lastError;
};

console.log("RM-PRELOAD LOADED");
export {};