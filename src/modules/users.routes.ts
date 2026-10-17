import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { BCRYPT_COST, PASSWORD_MIN_LENGTH } from '../config.js';
import { Business, User } from '../models/index.js';
import { ah } from '../utils/async.js';
import { conflict, forbidden, notFound } from '../utils/errors.js';
import { newId, randomPassword } from '../utils/ids.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { body, provided } from '../middleware/validate.js';
import { persistImages } from '../middleware/persistImages.js';
import { bulk, email, nonEmpty, phone, trimmed } from './common.js';
import { publicOwnerProfile, serializeUser } from './users.service.js';
import { emailAccountDeactivated, emailAccountInvite } from './emails.service.js';

export const userInput = z.object({
  name: nonEmpty('Name').min(2, 'Enter the full name.'),
  email,
  role: z.enum(['tourist', 'business_owner', 'admin']),
  phone: phone.optional(),
  country: trimmed(80).optional(),
  avatar: z.string().max(2_000_000).optional(),
  businessName: trimmed().optional(),
  bankAccount: trimmed(40).optional(),
  mtnNumber: trimmed(40).optional(),
  airtelNumber: trimmed(40).optional(),
  password: z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters for the password.`).max(200).optional(),
});
type UserInput = z.infer<typeof userInput>;

async function toDoc(input: UserInput) {
  const { password, ...rest } = input;
  // Never give two accounts the same shared password. When the caller does not choose one, make a
  // fresh random password and email it to the person so they can sign in straight away.
  const generated = !password;
  const plain = password ?? randomPassword();
  return {
    doc: { _id: newId('user'), ...rest, passwordHash: await bcrypt.hash(plain, BCRYPT_COST), joinedAt: new Date().toISOString() },
    password: generated ? plain : undefined,
  };
}

/** Everyone an admin creates gets an email; those without a chosen password are sent a temporary one. */
async function inviteIfNeeded(doc: { email: string; name: string; role?: string }, password?: string) {
  await emailAccountInvite({ name: doc.name, email: doc.email, role: doc.role ?? 'tourist' }, password);
}

export const usersRouter = Router();
usersRouter.use(authenticate);

usersRouter.get('/', requireRole('admin'), ah(async (req, res) => {
  const docs = await User.find().sort({ joinedAt: -1 }).lean();
  res.json(docs.map((d) => serializeUser(d, req.user)));
}));

usersRouter.post('/bulk/', requireRole('admin'), persistImages, ah(async (req, res) => {
  const rows = body(req, bulk(userInput));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.email)) throw conflict(`An account with ${row.email} already exists.`);
    seen.add(row.email);
  }
  const existing = await User.findOne({ email: { $in: [...seen] } }).lean<any>();
  if (existing) throw conflict(`An account with ${existing.email} already exists.`);
  const built = await Promise.all(rows.map(toDoc));
  const created = await User.insertMany(built.map((b) => b.doc));
  for (const b of built) await inviteIfNeeded(b.doc, b.password);
  res.status(201).json(created.map((d: any) => serializeUser(d.toObject(), req.user)));
}));

usersRouter.post('/', requireRole('admin'), persistImages, ah(async (req, res) => {
  const input = body(req, userInput);
  if (await User.exists({ email: input.email })) throw conflict(`An account with ${input.email} already exists.`);
  const { doc, password } = await toDoc(input);
  const created = await User.create(doc);
  await inviteIfNeeded(doc, password);
  res.status(201).json(serializeUser(created.toObject(), req.user));
}));

// Travellers need a number to call to confirm an off-platform payment. Any logged-in user may read
// the admins' contact details, but only those fields.
usersRouter.get('/admins/', ah(async (_req, res) => {
  const docs = await User.find({ role: 'admin' }, { name: 1, phone: 1, email: 1 }).lean<any[]>();
  res.json(docs.map((d) => ({ name: d.name, phone: (d.phone ?? '').trim(), email: d.email })));
}));

/** Admin edits a profile (name, email, role, phone, country) and activates or deactivates an account. */
usersRouter.patch('/:id/', requireRole('admin'), ah(async (req, res) => {
  const patch = provided(body(req, z.object({
    name: nonEmpty('Name').min(2, 'Enter the full name.').optional(),
    email: email.optional(),
    role: z.enum(['tourist', 'business_owner', 'admin']).optional(),
    phone: phone.optional(),
    country: trimmed(80).optional(),
    active: z.boolean().optional(),
    reason: trimmed(500).optional(),
  })), req.body);
  const deactivating = patch.active === false;
  if (req.params.id === req.user!.id && deactivating) throw conflict('You cannot deactivate your own account.');
  const existing = await User.findById(req.params.id, { email: 1 }).lean<any>();
  if (!existing) throw notFound('User');
  if (patch.email && patch.email !== existing.email && (await User.exists({ email: patch.email, _id: { $ne: req.params.id } }))) {
    throw conflict(`An account with ${patch.email} already exists.`);
  }
  const { reason, ...fields } = patch;
  const doc = await User.findByIdAndUpdate(req.params.id, { $set: fields }, { new: true }).lean<any>();
  if (deactivating) await emailAccountDeactivated({ name: doc.name, email: doc.email }, reason);
  res.json(serializeUser(doc, req.user));
}));

usersRouter.get('/:id/', ah(async (req, res) => {
  const doc = await User.findById(req.params.id).lean<any>();
  const privileged = req.user!.role === 'admin' || req.user!.id === req.params.id;
  if (privileged) {
    if (!doc) throw notFound('User');
    return res.json(serializeUser(doc, req.user));
  }
  // The frontend reads a host's payout accounts from here before a guest pays. Business owners are
  // therefore visible to any logged-in user, but only as a limited public profile.
  if (!doc || doc.role !== 'business_owner') throw forbidden();
  res.json(publicOwnerProfile(doc));
}));

usersRouter.delete('/:id/', requireRole('admin'), ah(async (req, res) => {
  if (req.params.id === req.user!.id) throw conflict('You cannot delete your own account.');
  const doc = await User.findByIdAndDelete(req.params.id);
  if (!doc) throw notFound('User');
  // Listings stay; they simply lose their owner link (the FE tolerates a missing ownerId).
  await Business.updateMany({ ownerId: req.params.id }, { $unset: { ownerId: 1 } });
  // An owner's staff cannot work without them.
  await User.deleteMany({ role: 'staff', ownerId: req.params.id });
  res.status(204).end();
}));
