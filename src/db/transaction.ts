import mongoose, { type ClientSession } from 'mongoose';
import { logger } from '../logger.js';

let supportsTransactions: boolean | undefined;

async function detect() {
  if (supportsTransactions !== undefined) return supportsTransactions;
  try {
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    supportsTransactions = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  } catch {
    supportsTransactions = false;
  }
  if (!supportsTransactions) {
    logger.warn('MongoDB is not a replica set: transactions are unavailable, so concurrent bookings are NOT race-safe. Use a replica set (see docker-compose.yml).');
  }
  return supportsTransactions;
}

/**
 * Runs `fn` in a transaction (retried by the driver on TransientTransactionError).
 * `fn` may run more than once, so it must not have side effects outside the session.
 */
export async function inTransaction<T>(fn: (session?: ClientSession) => Promise<T>): Promise<T> {
  if (!(await detect())) return fn(undefined);
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
