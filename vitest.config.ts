import { defineConfig } from 'vitest/config';

// Scope test discovery to vitest suites. The e2e/ directory holds
// Playwright specs. vitest must not collect or run them.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
