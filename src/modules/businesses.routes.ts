import { Router } from 'express';
import { z } from 'zod';
import { BADGES, BUSINESS_CATEGORIES, LISTING_KINDS, OFFERING_GROUPS, PROPERTY_TYPES, vehiclePlates } from '../domain/catalog.js';
import { Business, Location, User } from '../models/index.js';
import { ah } from '../utils/async.js';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { toDto, toDtos } from '../utils/dto.js';
import { authenticate, optionalAuth, requireRole } from '../middleware/auth.js';
import { body, provided, query } from '../middleware/validate.js';
import { persistImages } from '../middleware/persistImages.js';
import { bulk, coordinates, money, nonEmpty } from './common.js';
import { invalidateSearchIndex } from './search.service.js';
import { APPROVED_FILTER, canSeeListing, visibleListings } from './listingVisibility.js';
import { adminIds, notify } from './notifications.service.js';
import { emailListingDecision, emailListingSubmitted } from './emails.service.js';

const serviceInput = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  name: nonEmpty('Service name'),
  description: z.string().trim().max(2000).default(''),
  priceRwf: money,
  unit: nonEmpty('Unit', 40),
  capacity: z.number().int().min(1).optional(),
  available: z.number().int().min(0).optional(),
  bedType: z.string().trim().max(60).optional(),
  amenities: z.array(z.string().trim().max(80)).max(50).optional(),
  group: z.enum(OFFERING_GROUPS).optional(),
  category: z.string().trim().max(60).optional(),
  // Vehicles
  brand: z.string().trim().max(60).optional(),
  image: z.string().max(2_000_000).optional(),
  plateNumber: z.string().trim().max(20).optional(),
  plates: z.array(z.string().trim().min(1).max(20)).max(100).optional(),
  units: z.array(z.object({
    plate: z.string().trim().min(1, 'Every car needs a registration plate.').max(20),
    image: z.string().max(2_000_000).optional(),
    level: z.string().trim().max(60).optional(),
  })).max(100).optional(),
});

const kinds = LISTING_KINDS.map((k) => k.id) as [string, ...string[]];

export const businessInput = z.object({
  name: nonEmpty('Business name'),
  ownerName: z.string().trim().max(120).optional(),
  ownerId: z.string().trim().max(80).optional(),
  category: z.enum(BUSINESS_CATEGORIES),
  locationId: nonEmpty('Location'),
  district: z.string().trim().max(120).default(''),
  description: z.string().trim().max(5000).default(''),
  image: nonEmpty('A cover photo', 2_000_000),
  gallery: z.array(z.string().max(2_000_000)).max(6).optional(),
  badges: z.array(z.enum(BADGES)).default([]),
  phone: z.string().trim().max(40).default(''),
  email: z.string().trim().max(200).default(''),
  coordinates,
  services: z.array(serviceInput).max(50).default([]),
  priceLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  listingKind: z.enum(kinds).optional(),
  propertyType: z.enum(PROPERTY_TYPES).optional(),
  roomTypes: z.array(z.string().trim().max(80)).max(50).optional(),
  ecoFeatures: z.array(z.string().trim().max(120)).max(50).optional(),
  cuisine: z.array(z.string().trim().max(80)).max(50).optional(),
  signatureDish: z.string().trim().max(120).optional(),
});
type BusinessInput = z.infer<typeof businessInput>;

async function normalise(input: Partial<BusinessInput>, actor: { id: string; role: string }, existing?: any) {
  const out: Record<string, any> = { ...input };
  const category = input.category ?? existing?.category;
  if (input.propertyType && category !== 'Accommodation') throw unprocessable('Property type only applies to accommodation.');
  if (input.locationId) {
    const loc = await Location.findById(input.locationId, { district: 1 }).lean<any>();
    if (!loc) throw unprocessable('Choose a location that exists.');
    if (!input.district && !existing?.district) out.district = loc.district;
  }
  if (input.services) {
    out.services = input.services.map((s) => ({ ...s, id: s.id || newId('svc') }));
    // A registration plate identifies one physical car, so it can appear only once in a listing.
    const seen = new Set<string>();
    for (const s of out.services) {
      for (const plate of vehiclePlates(s)) {
        const key = plate.replace(/\s+/g, '').toUpperCase();
        if (seen.has(key)) throw conflict(`Plate ${plate} is already used in this fleet.`);
        seen.add(key);
      }
    }
  }
  // Owners always own what they create; only admins may assign someone else.
  if (actor.role !== 'admin') delete out.ownerId;
  return out;
}

async function ownerName(ownerId: string) {
  const owner = await User.findById(ownerId, { name: 1, role: 1 }).lean<any>();
  if (!owner) throw unprocessable('That owner account does not exist.');
  return owner.name as string;
}

async function prepareNew(input: BusinessInput, actor: { id: string; role: string }) {
  const data = await normalise(input, actor);
  const ownerId = actor.role === 'admin' ? input.ownerId : actor.id;
  if (ownerId) {
    data.ownerId = ownerId;
    data.ownerName = await ownerName(ownerId);
  }
  const now = new Date().toISOString();
  // Admins publish immediately; everything an owner creates waits for an admin.
  const approval = actor.role === 'admin'
    ? { approvalStatus: 'approved', reviewedAt: now, reviewedBy: actor.id }
    : { approvalStatus: 'pending', submittedAt: now };
  return { ...data, ...approval, _id: newId('biz'), rating: 0, reviewCount: 0, createdAt: now };
}

/** Tells admins (in the app and by email) that a listing is waiting. */
async function announceSubmission(business: any) {
  await notify(await adminIds(), {
    kind: 'system', title: 'Listing waiting for approval', body: `${business.ownerName || 'An owner'} submitted ${business.name}.`,
    path: `/businesses/${business._id}`,
  });
  await emailListingSubmitted(business, business.ownerName || 'A business owner');
}

export const businessesRouter = Router();

/**
 * Public listing. Only approved businesses are shown to travellers; owners also see their own
 * pending and rejected ones, staff their assigned branches, and admins everything.
 */
businessesRouter.get('/', optionalAuth, ah(async (req, res) => {
  const q = query(req, z.object({
    owner: z.string().optional(), category: z.string().optional(), locationId: z.string().optional(),
    approvalStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
  }));
  const conditions: Record<string, unknown>[] = [visibleListings(req.user)];
  if (q.owner) conditions.push({ ownerId: q.owner });
  if (q.category) conditions.push({ category: q.category });
  if (q.locationId) conditions.push({ locationId: q.locationId });
  if (q.approvalStatus === 'approved') conditions.push({ ...APPROVED_FILTER });
  else if (q.approvalStatus) conditions.push({ approvalStatus: q.approvalStatus });
  res.json(toDtos(await Business.find({ $and: conditions }).sort({ createdAt: -1 }).lean(), ['bookingSeq']));
}));

businessesRouter.post('/bulk/', authenticate, requireRole('admin'), persistImages, ah(async (req, res) => {
  const rows = body(req, bulk(businessInput));
  const prepared = [];
  for (const row of rows) prepared.push(await prepareNew(row, req.user!));
  const created = await Business.insertMany(prepared);
  invalidateSearchIndex();
  res.status(201).json(created.map((d: any) => toDto(d.toObject(), ['bookingSeq'])));
}));

businessesRouter.post('/', authenticate, requireRole('business_owner', 'admin'), persistImages, ah(async (req, res) => {
  const created = await Business.create(await prepareNew(body(req, businessInput), req.user!));
  invalidateSearchIndex();
  res.status(201).json(toDto(created.toObject(), ['bookingSeq']));
  // Notice admins after the owner already has a success response. A slow or failed email must not leave Submit spinning or turn a saved branch into an error.
  if (created.approvalStatus === 'pending') void announceSubmission(created.toObject()).catch(() => undefined);
}));

businessesRouter.get('/:id/payout/', authenticate, ah(async (req, res) => {
  const biz = await Business.findById(req.params.id, { name: 1, ownerId: 1, approvalStatus: 1 }).lean<any>();
  if (!biz || !canSeeListing(biz, req.user)) throw notFound('Business');
  const owner = biz.ownerId ? await User.findById(biz.ownerId).lean<any>() : null;
  res.json({
    businessName: owner?.businessName?.trim() || owner?.name || biz.name,
    // Customers need to see where their money goes; bank accounts are shown in full.
    ...(owner?.bankAccount ? { bankAccount: owner.bankAccount } : {}),
    ...(owner?.mtnNumber ? { mtnNumber: owner.mtnNumber } : {}),
    ...(owner?.airtelNumber ? { airtelNumber: owner.airtelNumber } : {}),
  });
}));

businessesRouter.get('/:id/', optionalAuth, ah(async (req, res) => {
  const doc = await Business.findById(req.params.id).lean<any>();
  // A pending or rejected listing does not exist as far as the public is concerned.
  if (!doc || !canSeeListing(doc, req.user)) throw notFound('Business');
  res.json(toDto(doc, ['bookingSeq']));
}));

/** Admin publishes a pending (or previously rejected) listing. */
businessesRouter.post('/:id/approve/', authenticate, requireRole('admin'), ah(async (req, res) => {
  const existing = await Business.findById(req.params.id).lean<any>();
  if (!existing) throw notFound('Business');
  if (existing.approvalStatus !== 'pending' && existing.approvalStatus !== 'rejected') throw conflict('This listing is already approved.');
  const doc = await Business.findOneAndUpdate(
    { _id: existing._id, approvalStatus: existing.approvalStatus },
    { $set: { approvalStatus: 'approved', reviewedAt: new Date().toISOString(), reviewedBy: req.user!.id }, $unset: { rejectionReason: 1 } },
    { new: true },
  ).lean<any>();
  if (!doc) throw conflict('This listing changed. Refresh and try again.');
  invalidateSearchIndex();
  await notify([doc.ownerId], { kind: 'system', title: 'Your listing is live', body: `${doc.name} was approved and is now visible to travellers.`, path: '/business' });
  await emailListingDecision(doc, true);
  res.json(toDto(doc, ['bookingSeq']));
}));

/** Admin hides a listing (new submission or one already live) and tells the owner why. */
businessesRouter.post('/:id/reject/', authenticate, requireRole('admin'), ah(async (req, res) => {
  const { reason } = body(req, z.object({ reason: z.string({ error: 'Tell the owner why.' }).trim().min(5, 'Tell the owner why (at least 5 characters).').max(500) }));
  const existing = await Business.findById(req.params.id).lean<any>();
  if (!existing) throw notFound('Business');
  if (existing.approvalStatus === 'rejected') throw conflict('This listing is already rejected.');
  const doc = await Business.findOneAndUpdate(
    { _id: existing._id },
    { $set: { approvalStatus: 'rejected', rejectionReason: reason, reviewedAt: new Date().toISOString(), reviewedBy: req.user!.id } },
    { new: true },
  ).lean<any>();
  invalidateSearchIndex();
  await notify([doc.ownerId], { kind: 'system', title: 'Your listing needs changes', body: `${doc.name} was not approved: ${reason}`, path: '/business' });
  await emailListingDecision(doc, false, reason);
  res.json(toDto(doc, ['bookingSeq']));
}));

/** Admin hides a live listing from travellers (or brings it back) without rejecting it. */
businessesRouter.patch('/:id/active/', authenticate, requireRole('admin'), ah(async (req, res) => {
  const { active } = body(req, z.object({ active: z.boolean() }));
  const doc = await Business.findByIdAndUpdate(req.params.id, { $set: { active } }, { new: true }).lean<any>();
  if (!doc) throw notFound('Business');
  invalidateSearchIndex();
  res.json(toDto(doc, ['bookingSeq']));
}));

/** Admin removes a company branch for good. Bookings and reviews keep their stored copy of the name. */
businessesRouter.delete('/:id/', authenticate, requireRole('admin'), ah(async (req, res) => {
  const doc = await Business.findByIdAndDelete(req.params.id);
  if (!doc) throw notFound('Business');
  invalidateSearchIndex();
  res.status(204).end();
}));

businessesRouter.patch('/:id/', authenticate, requireRole('business_owner', 'staff', 'admin'), persistImages, ah(async (req, res) => {
  const existing = await Business.findById(req.params.id).lean<any>();
  if (!existing) throw notFound('Business');
  const user = req.user!;
  if (user.role === 'staff') {
    // Staff keep their branch's offerings and fleet up to date; everything else belongs to the owner.
    if (existing.ownerId !== user.ownerId || !(user.assignedListingIds ?? []).includes(existing.id ?? existing._id)) {
      throw forbidden('You can only edit the branches assigned to you.');
    }
    const extra = Object.keys(req.body ?? {}).filter((k) => !['services', 'id', 'rating', 'reviewCount', 'createdAt'].includes(k));
    if (extra.length) throw forbidden('Staff can update services and vehicles only. Ask the owner to change other details.');
  } else if (user.role !== 'admin' && existing.ownerId !== user.id) {
    throw forbidden('You can only edit your own listings.');
  }
  // rating, reviewCount, createdAt and id are not in the schema, so they are stripped.
  const patch = provided(body(req, businessInput.partial()), req.body);
  const data = await normalise(patch, req.user!, existing);
  if (data.ownerId) data.ownerName = await ownerName(data.ownerId);
  // An owner who fixes a rejected listing sends it back for review.
  const resubmit = user.role === 'business_owner' && existing.approvalStatus === 'rejected';
  if (resubmit) Object.assign(data, { approvalStatus: 'pending', submittedAt: new Date().toISOString() });
  const doc = await Business.findByIdAndUpdate(req.params.id, { $set: data, ...(resubmit ? { $unset: { rejectionReason: 1 } } : {}) }, { new: true }).lean<any>();
  invalidateSearchIndex();
  if (resubmit) await announceSubmission(doc);
  res.json(toDto(doc, ['bookingSeq']));
}));
