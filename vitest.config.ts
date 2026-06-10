import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Forks are the most robust pool under the bun runtime; worker threads can
    // be flaky when vitest is launched by bun.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/index.ts', 'src/**/*.test.ts'],
      reporter: ['text', 'html'],
    },
  },
});
