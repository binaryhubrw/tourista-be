import { createApp } from './app.js';
import { config } from './config.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { logger } from './logger.js';
import { ensureUploadDir } from './providers/storage.js';

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

try {
  logger.info({ dir: await ensureUploadDir() }, 'Uploads folder ready');
} catch (err) {
  logger.fatal({ err }, 'The uploads folder is missing or not writable');
  process.exit(1);
}

try {
  await connectDb();
} catch (err) {
  logger.fatal({ err }, 'Could not connect to MongoDB');
  process.exit(1);
}
const server = createApp().listen(config.PORT, () => logger.info(`Tourista API listening on :${config.PORT} (/api)`));

const shutdown = (signal: string) => {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
