import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-test-secret', UPLOAD_DIR: '.data/test-uploads' },
  },
});
