import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { BCRYPT_COST, PASSWORD_MIN_LENGTH } from '../config.js';
import { Business, User } from '../models/index.js';
import { ah } from '../utils/async.js';
import { badRequest, conflict, notFound, unprocessable } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { authenticate, requireRole, type AuthUser } from '../middleware/auth.js';
import { body, provided, query } from '../middleware/validate.js';
import { email, nonEmpty, phone } from './common.js';
import { notify } from './notifications.service.js';
import { emailStaffAdded, emailStaffStatus } from './emails.service.js';

const SHAPE = ['passwordHash', 'passwordResetTokenHash', 'passwordResetExpiresAt', 'preferences', 'bankAccount', 'mtnNumber', 'airtelNumber'];

export const staffInput = z.object({
  name: nonEmpty('Name').min(2, 'Enter the full name.'),
  email,
  password: z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters for the password.`).max(200),
  phone: phone.optional(),
  /** Only "Manager" exists today; kept for forward compatibility. */
  title: z.string().trim().max(60).optional(),
  assignedListingIds: z.array(z.string().trim().min(1)).max(100).default([]),
  active: z.boolean().optional(),
});

const dto = (doc: any) => {
  const { _id, ...rest } = doc;
  for (const k of SHAPE) delete rest[k];
  return { id: _id, ...rest, title: 'Manager', active: rest.active ?? true, assignedListingIds: rest.assignedListingIds ?? [] };
};

/** Owners manage their own team; admins may act for any owner by passing `ownerId`. */
function ownerFor(user: AuthUser, requested?: string) {
  if (user.role === 'business_owner') return user.id;
  if (!requested) throw badRequest('Say which business owner this is for (ownerId).');
  return requested;
}

/** One active manager per branch. Returns the first branch that already has one. */
async function managerClash(ownerId: string, listingIds: string[], exceptStaffId?: string) {
  if (!listingIds.length) return null;
  return User.findOne({
    role: 'staff', ownerId, active: { $ne: false }, _id: { $ne: exceptStaffId ?? '' }, assignedListingIds: { $in: listingIds },
  }, { _id: 1 }).lean<any>();
}

async function assertOwnListings(ownerId: string, listingIds: string[]) {
  if (!listingIds.length) return;
  const found = await Business.countDocuments({ _id: { $in: listingIds }, ownerId });
  if (found !== new Set(listingIds).size) throw unprocessable('You can only assign your own branches.');
}

async function assertEmailFree(address: string, exceptId?: string) {
  const taken = await User.findOne({ email: address, _id: { $ne: exceptId ?? '' } }, { role: 1 }).lean<any>();
  if (!taken) return;
  throw conflict(taken.role === 'staff' ? 'A staff member already uses that email.' : 'An account with this email already exists.');
}

export const staffRouter = Router();
staffRouter.use(authenticate, requireRole('business_owner', 'admin'));

staffRouter.get('/', ah(async (req, res) => {
  const q = query(req, z.object({ ownerId: z.string().optional() }));
  const filter: Record<string, unknown> = { role: 'staff' };
  if (req.user!.role === 'business_owner') filter.ownerId = req.user!.id;
  else if (q.ownerId) filter.ownerId = q.ownerId;
  res.json((await User.find(filter).sort({ joinedAt: -1 }).lean<any[]>()).map(dto));
}));

staffRouter.post('/', ah(async (req, res) => {
  const input = body(req, staffInput);
  const ownerId = ownerFor(req.user!, typeof req.body?.ownerId === 'string' ? req.body.ownerId : undefined);
  await assertEmailFree(input.email);
  await assertOwnListings(ownerId, input.assignedListingIds);
  if (await managerClash(ownerId, input.assignedListingIds)) throw conflict('That branch already has a manager.');
  const doc = await User.create({
    _id: newId('staff'),
    name: input.name,
    email: input.email,
    passwordHash: await bcrypt.hash(input.password, BCRYPT_COST),
    role: 'staff',
    phone: input.phone,
    title: 'Manager',
    ownerId,
    assignedListingIds: [...new Set(input.assignedListingIds)],
    active: input.active ?? true,
    joinedAt: new Date().toISOString(),
  });
  await notify([doc._id], { kind: 'staff', title: 'You were added as a manager', body: `You can now manage ${doc.assignedListingIds.length} branch${doc.assignedListingIds.length === 1 ? '' : 'es'}.`, path: '/business' });
  const owner = await User.findById(ownerId, { name: 1, businessName: 1 }).lean<any>();
  const branches = (await Business.find({ _id: { $in: doc.assignedListingIds } }, { name: 1 }).lean<any[]>()).map((b) => b.name as string);
  await emailStaffAdded({ name: doc.name, email: doc.email }, owner?.businessName || owner?.name || 'The owner', branches);
  res.status(201).json(dto(doc.toObject()));
}));

staffRouter.patch('/:id/', ah(async (req, res) => {
  const existing = await User.findOne({ _id: req.params.id, role: 'staff' }).lean<any>();
  if (!existing || (req.user!.role === 'business_owner' && existing.ownerId !== req.user!.id)) throw notFound('Staff member');
  const patch = provided(body(req, staffInput.partial()), req.body);
  if (patch.email && patch.email !== existing.email) await assertEmailFree(patch.email, existing._id);
  if (patch.assignedListingIds) await assertOwnListings(existing.ownerId, patch.assignedListingIds);
  const willBeActive = patch.active ?? existing.active ?? true;
  const listings = patch.assignedListingIds ?? existing.assignedListingIds ?? [];
  if (willBeActive && (await managerClash(existing.ownerId, listings, existing._id))) throw conflict('That branch already has a manager.');

  const { password, ...rest } = patch;
  const set: Record<string, unknown> = { ...rest, title: 'Manager' };
  if (password) set.passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  if (rest.assignedListingIds) set.assignedListingIds = [...new Set(rest.assignedListingIds)];
  const doc = await User.findByIdAndUpdate(existing._id, { $set: set }, { new: true }).lean<any>();
  if (patch.active !== undefined && patch.active !== (existing.active ?? true)) {
    await emailStaffStatus({ name: doc.name, email: doc.email }, patch.active);
  }
  res.json(dto(doc));
}));

staffRouter.delete('/:id/', ah(async (req, res) => {
  const existing = await User.findOne({ _id: req.params.id, role: 'staff' }, { ownerId: 1 }).lean<any>();
  if (!existing || (req.user!.role === 'business_owner' && existing.ownerId !== req.user!.id)) throw notFound('Staff member');
  await User.deleteOne({ _id: existing._id });
  res.status(204).end();
}));
