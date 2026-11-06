import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
