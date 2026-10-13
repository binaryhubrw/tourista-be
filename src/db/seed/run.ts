import bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config, BCRYPT_COST, isProd } from '../../config.js';
import { connectDb, disconnectDb } from '../connect.js';
import { Baseline, BASELINE_ID, Booking, Business, Experience, Itinerary, Location, Refund, Review, User } from '../../models/index.js';
import { generateBookings } from './bookings.js';
import type { Business as BusinessT, Experience as ExperienceT, User as UserT } from '../../domain/types.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const load = <T,>(name: string) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8')) as T;

/** Idempotent: replaces each seed document by its id, leaving other documents alone. */
async function upsert(model: mongoose.Model<any>, docs: any[]) {
  if (!docs.length) return;
  await model.bulkWrite(
    docs.map(({ id, ...rest }) => ({ replaceOne: { filter: { _id: id }, replacement: { _id: id, ...rest }, upsert: true } })),
  );
}

export async function seed({ reset = false, uri }: { reset?: boolean; uri?: string } = {}) {
  if (isProd && !config.ALLOW_PRODUCTION_SEED) {
    throw new Error('Refusing to seed demo data (accounts with a known password) in production. Set ALLOW_PRODUCTION_SEED=true to override, or use `npm run create-admin`.');
  }
  if (isProd && reset) throw new Error('Refusing to drop the database in production.');
  if (isProd && !config.DEFAULT_USER_PASSWORD) throw new Error('Set DEFAULT_USER_PASSWORD to a non-demo value before seeding in production.');
  await connectDb(uri);
  if (reset) await mongoose.connection.dropDatabase();

  const password = config.DEFAULT_USER_PASSWORD ?? 'password';
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  const users = load<UserT[]>('users');
  const businesses = load<BusinessT[]>('businesses');
  const experiences = load<ExperienceT[]>('experiences');

  // Mongo creates indexes lazily; make sure they exist before data lands.
  await Promise.all([User, Location, Experience, Business, Review, Itinerary, Booking, Refund].map((m) => m.syncIndexes()));

  await upsert(User, users.map((u) => ({ ...u, email: u.email.toLowerCase(), passwordHash: hash })));
  await upsert(Location, load('locations'));
  await upsert(Experience, experiences);
  await upsert(Business, businesses.map((b) => ({ ...b, bookingSeq: 0, approvalStatus: 'approved' })));
  await upsert(Review, load('reviews'));
  await upsert(Itinerary, load('itineraries'));
  const generated = generateBookings(users, businesses, experiences);
  await upsert(Booking, generated.bookings);
  await upsert(Refund, generated.refunds.map((r) => ({ ...r, createdAt: r.steps[0].at })));
  await Baseline.replaceOne({ _id: BASELINE_ID }, { _id: BASELINE_ID, data: load('baseline') }, { upsert: true });

  return {
    locations: await Location.countDocuments(),
    businesses: await Business.countDocuments(),
    users: await User.countDocuments(),
    bookings: await Booking.countDocuments(),
  };
}

// Run directly: `npm run seed` / `npm run seed:reset`.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed({ reset: process.argv.includes('--reset') })
    .then(async (counts) => {
      console.log(`Seeded database "${mongoose.connection.name}" on ${mongoose.connection.host}`, counts);
      await disconnectDb();
    })
    .catch(async (err) => {
      console.error(err);
      await disconnectDb();
      process.exit(1);
    });
}
