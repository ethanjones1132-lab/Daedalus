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
  },
});
