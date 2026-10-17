import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
});
