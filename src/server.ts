import { createApp } from './app.js';
import { config } from './config.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { seedPlaces } from './db/seed/places.js';
import { logger } from './logger.js';
import { ensureUploadDir } from './providers/storage.js';
import { expireStaleBookings, sendPaymentReminders } from './modules/bookings.service.js';
import { flushMail, mailStatus, verifyMail } from './providers/mail.js';

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
try {
  const placed = await seedPlaces();
  logger.info(placed, 'Location seed applied');
} catch (err) {
  logger.fatal({ err }, 'Location seed failed');
  process.exit(1);
}
const server = createApp().listen(config.PORT, () => logger.info(`Tourista API listening on :${config.PORT} (/api)`));

// Check the mail login once at startup. A problem is reported loudly but never stops the API.
void verifyMail().then((ok) => {
  const m = mailStatus();
  if (m.mode === 'json') logger.warn({ transport: m.transport }, 'Email is not configured: set MAIL_HOST/MAIL_USER/MAIL_PASS (or SMTP_URL). Messages are rendered but not delivered.');
  else if (ok) logger.info({ transport: m.transport, from: m.from }, 'Email transport verified');
  else logger.error({ transport: m.transport, err: m.lastError }, 'Email transport could not log in; emails will fail until this is fixed');
});

// Approved bookings that were not paid inside the two-hour window expire and release their stock.
// Reads also expire lazily, so this timer only makes it prompt and sends the notification on time.
const sweeper = setInterval(() => {
  expireStaleBookings().catch((err) => logger.warn({ err }, 'expiry sweep failed'));
  sendPaymentReminders().catch((err) => logger.warn({ err }, 'reminder sweep failed'));
}, 60_000);
sweeper.unref();

const shutdown = (signal: string) => {
  logger.info(`${signal} received, shutting down`);
  clearInterval(sweeper);
  server.close(async () => {
    await flushMail(5000); // let queued emails go out
    await disconnectDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
