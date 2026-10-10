import mongoose from 'mongoose';
import { config } from '../config.js';
import { logger } from '../logger.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connects, retrying for a while so the API can start before MongoDB is ready (containers, restarts). */
export async function connectDb(uri = config.MONGODB_URI, { attempts = 15, delayMs = 2000 } = {}) {
  mongoose.set('strictQuery', true);
  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 20 });
      logger.info({ host: mongoose.connection.host, db: mongoose.connection.name }, 'MongoDB connected');
      return mongoose.connection;
    } catch (err) {
      if (attempt >= attempts) throw err;
      logger.warn({ attempt, attempts }, 'MongoDB not reachable yet, retrying');
      await sleep(delayMs);
    }
  }
}

export const disconnectDb = () => mongoose.disconnect();
