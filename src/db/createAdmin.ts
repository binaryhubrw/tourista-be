// Bootstraps the first real admin without loading demo data:
//   npm run create-admin -- admin@example.com "Full Name" 'a-strong-password'
// (or ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD in the environment)
import bcrypt from 'bcryptjs';
import { BCRYPT_COST, PASSWORD_MIN_LENGTH } from '../config.js';
import { connectDb, disconnectDb } from './connect.js';
import { User } from '../models/index.js';
import { newId } from '../utils/ids.js';

const [argEmail, argName, argPassword] = process.argv.slice(2);
const email = (argEmail ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const name = (argName ?? process.env.ADMIN_NAME ?? 'Administrator').trim();
const password = argPassword ?? process.env.ADMIN_PASSWORD ?? '';

async function main() {
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Provide a valid email: npm run create-admin -- <email> "<name>" <password>');
  if (password.length < Math.max(PASSWORD_MIN_LENGTH, 10)) throw new Error('Use a password of at least 10 characters.');
  await connectDb();
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  const existing = await User.findOne({ email });
  if (existing) {
    await User.updateOne({ _id: existing._id }, { $set: { role: 'admin', passwordHash: hash } });
    console.log(`Updated ${email}: role admin, password reset.`);
  } else {
    await User.create({ _id: newId('user'), name, email, role: 'admin', passwordHash: hash, joinedAt: new Date().toISOString() });
    console.log(`Created admin ${email}.`);
  }
}

main()
  .then(() => disconnectDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await disconnectDb();
    process.exit(1);
  });
