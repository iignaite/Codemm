import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  // Mermaid's optional ELK layout is left out (src/renderer/stubs/elk.ts says why).
  resolve: { alias: { 'elkjs/lib/elk.bundled.js': fileURLToPath(new URL('./src/renderer/stubs/elk.ts', import.meta.url)) } },
  // The licenses of everything the renderer bundles travel with the app (packaging.cjs), as the MIT and ISC terms ask.
  build: { outDir: '../../out/renderer', emptyOutDir: true, license: { fileName: 'licenses.md' } },
  test: {
    root: '.',
    include: ['src/**/*.test.{ts,tsx}', '*.test.ts'],
    environment: 'jsdom',
    // Journey tests type and click through several screens; slow CI runners need room.
    testTimeout: 20_000,
    setupFiles: ['src/renderer/test-setup.ts'],
  },
});
