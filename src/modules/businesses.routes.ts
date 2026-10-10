import { Router } from 'express';
import { z } from 'zod';
import { BADGES, BUSINESS_CATEGORIES, LISTING_KINDS, OFFERING_GROUPS, PROPERTY_TYPES } from '../domain/catalog.js';
import { maskBank } from '../domain/payout.js';
import { Business, Location, User } from '../models/index.js';
import { ah } from '../utils/async.js';
import { forbidden, notFound, unprocessable } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { toDto, toDtos } from '../utils/dto.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { body, provided, query } from '../middleware/validate.js';
import { persistImages } from '../middleware/persistImages.js';
import { bulk, coordinates, money, nonEmpty } from './common.js';
import { invalidateSearchIndex } from './search.service.js';

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
  if (input.services) out.services = input.services.map((s) => ({ ...s, id: s.id || newId('svc') }));
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
  return { ...data, _id: newId('biz'), rating: 0, reviewCount: 0, createdAt: new Date().toISOString() };
}

export const businessesRouter = Router();

businessesRouter.get('/', ah(async (req, res) => {
  const q = query(req, z.object({ owner: z.string().optional(), category: z.string().optional(), locationId: z.string().optional() }));
  const filter: Record<string, string> = {};
  if (q.owner) filter.ownerId = q.owner;
  if (q.category) filter.category = q.category;
  if (q.locationId) filter.locationId = q.locationId;
  res.json(toDtos(await Business.find(filter).sort({ createdAt: -1 }).lean(), ['bookingSeq']));
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
}));

businessesRouter.get('/:id/payout/', authenticate, ah(async (req, res) => {
  const biz = await Business.findById(req.params.id, { name: 1, ownerId: 1 }).lean<any>();
  if (!biz) throw notFound('Business');
  const owner = biz.ownerId ? await User.findById(biz.ownerId).lean<any>() : null;
  res.json({
    businessName: owner?.businessName?.trim() || owner?.name || biz.name,
    // Customers need to see where their money goes; bank accounts are shown masked.
    ...(owner?.bankAccount ? { bankAccount: maskBank(owner.bankAccount) } : {}),
    ...(owner?.mtnNumber ? { mtnNumber: owner.mtnNumber } : {}),
    ...(owner?.airtelNumber ? { airtelNumber: owner.airtelNumber } : {}),
  });
}));

businessesRouter.get('/:id/', ah(async (req, res) => {
  const doc = await Business.findById(req.params.id).lean();
  if (!doc) throw notFound('Business');
  res.json(toDto(doc, ['bookingSeq']));
}));

businessesRouter.patch('/:id/', authenticate, requireRole('business_owner', 'admin'), persistImages, ah(async (req, res) => {
  const existing = await Business.findById(req.params.id).lean<any>();
  if (!existing) throw notFound('Business');
  if (req.user!.role !== 'admin' && existing.ownerId !== req.user!.id) throw forbidden('You can only edit your own listings.');
  // rating, reviewCount, createdAt and id are not in the schema, so they are stripped.
  const patch = provided(body(req, businessInput.partial()), req.body);
  const data = await normalise(patch, req.user!, existing);
  if (data.ownerId) data.ownerName = await ownerName(data.ownerId);
  const doc = await Business.findByIdAndUpdate(req.params.id, { $set: data }, { new: true }).lean();
  invalidateSearchIndex();
  res.json(toDto(doc, ['bookingSeq']));
}));
