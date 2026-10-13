import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    // Mail vars are blanked as well as guarded in code, so a developer's real SMTP login can never be used by tests.
    env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-test-secret', UPLOAD_DIR: '.data/test-uploads', MAIL_HOST: '', MAIL_USER: '', MAIL_PASS: '', SMTP_URL: '' },
  },
});
