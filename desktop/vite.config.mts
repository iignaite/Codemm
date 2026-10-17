import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../out/renderer', emptyOutDir: true },
  test: {
    root: '.',
    include: ['src/**/*.test.{ts,tsx}', '*.test.ts'],
    environment: 'jsdom',
    // Journey tests type and click through several screens; slow CI runners need room.
    testTimeout: 20_000,
    setupFiles: ['src/renderer/test-setup.ts'],
  },
});
