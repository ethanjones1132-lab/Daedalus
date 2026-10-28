import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // tsc -b already typechecks the app; keep the unit run focused on *.test.tsx.
    include: ['src/**/*.test.{ts,tsx}'],
    // Run in worker threads instead of forking a child process per test file:
    // under full-suite load the forks pool fails to start workers ("worker failed
    // to respond" / worker-start timeouts). Threads keep isolation per file (each
    // file still gets its own module registry) without the process spawn cost.
    pool: 'threads',
    // Bound concurrency at two workers so the run stays inside the gate's 900 s
    // budget instead of serialising all files.
    maxWorkers: 2,
    minWorkers: 1,
    // Explicit: each test file keeps its own module registry.
    isolate: true,
  },
});
