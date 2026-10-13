import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { config, BCRYPT_COST, PASSWORD_MIN_LENGTH, isTest } from '../config.js';
import { User } from '../models/index.js';
import { ah } from '../utils/async.js';
import { conflict, forbidden, HttpError, badRequest } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { authenticate, signToken } from '../middleware/auth.js';
import { body } from '../middleware/validate.js';
import { persistImages } from '../middleware/persistImages.js';
import { airtelNumber, bankAccount, email, mtnNumber, nonEmpty, phone, trimmed } from './common.js';
import { serializeUser, withStaffOwner } from './users.service.js';
import { adminIds, notify } from './notifications.service.js';
import { emailPasswordChanged, emailPasswordReset, emailWelcome } from './emails.service.js';

const password = z.string({ error: 'Enter a password.' }).min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters for your password.`).max(200);

export const registerSchema = z.object({
  name: nonEmpty('Your name').min(2, 'Enter your full name.'),
  email,
  password,
  role: z.enum(['tourist', 'business_owner']).default('tourist'),
  phone: phone.optional(),
  country: trimmed(80).optional(),
  businessName: trimmed().optional(),
  bankAccount: z.string().trim().optional(),
  mtnNumber: z.string().trim().optional(),
  airtelNumber: z.string().trim().optional(),
});

const preferences = z.object({
  bookingEmails: z.boolean().optional(),
  reviewReplies: z.boolean().optional(),
  newsletter: z.boolean().optional(),
  currency: trimmed(8).optional(),
  language: trimmed(8).optional(),
});

export const patchSchema = z.object({
  name: nonEmpty('Your name').min(2, 'Enter your full name.').optional(),
  phone: z.string().trim().max(40).optional(),
  country: trimmed(80).optional(),
  avatar: z.string().max(2_000_000).optional(),
  businessName: trimmed().optional(),
  bankAccount: z.string().trim().max(40).optional(),
  mtnNumber: z.string().trim().max(40).optional(),
  airtelNumber: z.string().trim().max(40).optional(),
  preferences: preferences.optional(),
});

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res) => res.status(429).json({ message: 'Too many attempts. Wait a minute and try again.', status: 429 }),
});

export const loginSchema = z.object({ email: z.string().trim().toLowerCase(), password: z.string() });

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const BAD_LOGIN = 'That email and password don’t match. Check them and try again.';
// Pre-computed so unknown emails cost the same as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

export const authRouter = Router();

authRouter.post('/register/', limiter, ah(async (req, res) => {
  if (req.body?.role === 'admin') throw forbidden('Admin accounts cannot be created here.');
  const input = body(req, registerSchema);
  if (input.role === 'business_owner') {
    const problems: { path: string; message: string }[] = [];
    if (!input.businessName || input.businessName.length < 2) problems.push({ path: 'businessName', message: 'Enter your business name.' });
    for (const [path, schema] of [['bankAccount', bankAccount], ['mtnNumber', mtnNumber], ['airtelNumber', airtelNumber]] as const) {
      const r = schema.safeParse((input as any)[path] ?? '');
      if (!r.success) problems.push({ path, message: r.error.issues[0].message });
    }
    if (problems.length) throw badRequest(problems[0].message, problems);
  }
  if (await User.exists({ email: input.email })) throw conflict('An account with this email already exists. Log in instead.');
  const { password: plain, ...rest } = input;
  const doc = await User.create({
    _id: newId('user'),
    ...rest,
    ...(input.role === 'tourist' ? { businessName: undefined, bankAccount: undefined, mtnNumber: undefined, airtelNumber: undefined } : {}),
    passwordHash: await bcrypt.hash(plain, BCRYPT_COST),
    joinedAt: new Date().toISOString(),
  });
  const user = serializeUser(doc.toObject(), { id: doc._id, role: doc.role });
  if (user.role === 'business_owner') {
    await notify(await adminIds(), { kind: 'staff', title: 'New business owner joined', body: `${user.businessName || user.name} created an account.`, path: '/users' });
  }
  await emailWelcome({ name: user.name, email: user.email, role: user.role });
  res.status(201).json({ token: signToken(user), user });
}));

authRouter.post('/login/', limiter, ah(async (req, res) => {
  const { email: addr, password: plain } = body(req, loginSchema);
  const doc = await User.findOne({ email: addr }).lean<any>();
  const ok = await bcrypt.compare(plain, doc?.passwordHash ?? DUMMY_HASH);
  if (!doc || !ok) throw new HttpError(401, BAD_LOGIN);
  if (doc.role === 'staff' && doc.active === false) throw forbidden('This staff account is deactivated. Ask the owner to activate it.');
  const user = await withStaffOwner(serializeUser(doc, { id: doc._id, role: doc.role }));
  res.json({ token: signToken(user), user });
}));

authRouter.get('/me/', authenticate, ah(async (req, res) => {
  const doc = await User.findById(req.user!.id).lean();
  res.json(await withStaffOwner(serializeUser(doc, req.user)));
}));

authRouter.patch('/me/', authenticate, persistImages, ah(async (req, res) => {
  // The FE sends the whole User object; the schema strips everything not whitelisted (id, role, email, joinedAt…).
  const input = body(req, patchSchema);
  const problems: { path: string; message: string }[] = [];
  for (const [path, schema] of [['bankAccount', bankAccount], ['mtnNumber', mtnNumber], ['airtelNumber', airtelNumber]] as const) {
    const value = (input as any)[path];
    if (value) {
      const r = schema.safeParse(value);
      if (!r.success) problems.push({ path, message: r.error.issues[0].message });
    }
  }
  if (problems.length) throw badRequest(problems[0].message, problems);
  const { preferences: prefs, ...fields } = input;
  // Staff may change how they appear, but payout accounts and the trading name belong to the owner.
  if (req.user!.role === 'staff') for (const k of ['businessName', 'bankAccount', 'mtnNumber', 'airtelNumber'] as const) delete (fields as any)[k];
  const set: Record<string, unknown> = { ...fields };
  for (const [k, v] of Object.entries(prefs ?? {})) set[`preferences.${k}`] = v;
  const doc = await User.findByIdAndUpdate(req.user!.id, { $set: set }, { new: true }).lean();
  res.json(await withStaffOwner(serializeUser(doc, req.user)));
}));

authRouter.post('/password-reset/', limiter, ah(async (req, res) => {
  const { email: addr } = body(req, z.object({ email: z.string().trim().toLowerCase() }));
  const doc = await User.findOne({ email: addr });
  if (doc) {
    const token = crypto.randomBytes(32).toString('hex');
    doc.passwordResetTokenHash = hashToken(token);
    doc.passwordResetExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await doc.save();
    await emailPasswordReset({ name: doc.name, email: doc.email }, `${config.FRONTEND_URL}/reset-password?token=${token}`);
  }
  res.status(204).end(); // always 204: no account enumeration
}));

authRouter.post('/password-reset/confirm/', limiter, ah(async (req, res) => {
  const input = body(req, z.object({ token: z.string().min(10), password }));
  const doc = await User.findOne({ passwordResetTokenHash: hashToken(input.token) });
  if (!doc || !doc.passwordResetExpiresAt || doc.passwordResetExpiresAt < new Date().toISOString()) {
    throw badRequest('This reset link is invalid or has expired.');
  }
  doc.passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  doc.passwordResetTokenHash = undefined;
  doc.passwordResetExpiresAt = undefined;
  await doc.save();
  await emailPasswordChanged({ name: doc.name, email: doc.email });
  res.status(204).end();
}));
