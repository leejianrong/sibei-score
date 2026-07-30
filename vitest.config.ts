import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Rendering the nasty chart through jsdom + VexFlow is not fast.
    testTimeout: 30_000,
  },
});
