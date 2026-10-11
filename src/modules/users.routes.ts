import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { BCRYPT_COST, PASSWORD_MIN_LENGTH, config } from '../config.js';
import { Business, User } from '../models/index.js';
import { ah } from '../utils/async.js';
import { conflict, forbidden, notFound } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { body } from '../middleware/validate.js';
import { persistImages } from '../middleware/persistImages.js';
import { bulk, email, nonEmpty, phone, trimmed } from './common.js';
import { publicOwnerProfile, serializeUser } from './users.service.js';
import { sendMail } from '../providers/mail.js';

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
  const plain = password ?? config.DEFAULT_USER_PASSWORD;
  // Without a default, generate a random password and email a reset link instead.
  const effective = plain ?? crypto.randomBytes(18).toString('base64url');
  return {
    doc: { _id: newId('user'), ...rest, passwordHash: await bcrypt.hash(effective, BCRYPT_COST), joinedAt: new Date().toISOString() },
    needsReset: !plain,
  };
}

async function inviteIfNeeded(doc: { email: string; name: string }, needsReset: boolean) {
  if (!needsReset) return;
  void sendMail({
    to: doc.email,
    subject: 'Your Tourista Rwanda account',
    text: `Hello ${doc.name},\n\nAn account was created for you. Choose a password here:\n${config.FRONTEND_URL}/forgot-password\n`,
  });
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
  built.forEach((b) => void inviteIfNeeded(b.doc, b.needsReset));
  res.status(201).json(created.map((d: any) => serializeUser(d.toObject(), req.user)));
}));

usersRouter.post('/', requireRole('admin'), persistImages, ah(async (req, res) => {
  const input = body(req, userInput);
  if (await User.exists({ email: input.email })) throw conflict(`An account with ${input.email} already exists.`);
  const { doc, needsReset } = await toDoc(input);
  const created = await User.create(doc);
  void inviteIfNeeded(doc, needsReset);
  res.status(201).json(serializeUser(created.toObject(), req.user));
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
