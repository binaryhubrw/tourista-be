import { Router } from 'express';
import { z } from 'zod';
import { INTERESTS, LOCATION_CATEGORIES } from '../domain/catalog.js';
import { Experience, Location } from '../models/index.js';
import { ah } from '../utils/async.js';
import { notFound } from '../utils/errors.js';
import { slugify, uniqueSlug } from '../utils/ids.js';
import { toDto, toDtos } from '../utils/dto.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { body, provided } from '../middleware/validate.js';
import { persistImages } from '../middleware/persistImages.js';
import { bulk, coordinates, nonEmpty } from './common.js';
import { invalidateSearchIndex } from './search.service.js';

const list = (max = 50) => z.array(z.string().trim().min(1).max(300)).max(max);

export const locationInput = z.object({
  name: nonEmpty('Name'),
  district: nonEmpty('District'),
  province: nonEmpty('Province'),
  coordinates,
  category: z.enum(LOCATION_CATEGORIES).default('Town'),
  interests: z.array(z.enum(INTERESTS)).max(INTERESTS.length).default([]),
  shortDescription: z.string().trim().max(300).default(''),
  description: z.string().trim().max(5000).default(''),
  image: z.string().trim().max(2_000_000).default(''),
  gallery: z.array(z.string().max(2_000_000)).max(6).default([]),
  thingsToDo: list().default([]),
  sustainability: list().default([]),
  priceLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  isHiddenGem: z.boolean().optional(),
  isPopular: z.boolean().optional(),
  visitsLastYear: z.number().int().min(0).optional(),
});

async function build(inputs: z.infer<typeof locationInput>[]) {
  const taken = new Set<string>((await Location.find({}, { _id: 1 }).lean<any[]>()).map((l) => l._id));
  const now = new Date().toISOString();
  return inputs.map((input) => {
    const id = uniqueSlug(slugify(input.name), taken);
    taken.add(id);
    return { ...input, _id: id, rating: 0, reviewCount: 0, visitsLastYear: input.visitsLastYear ?? 0, createdAt: now };
  });
}

export const locationsRouter = Router();

locationsRouter.get('/', ah(async (_req, res) => {
  res.json(toDtos(await Location.find().lean()));
}));

locationsRouter.post('/bulk/', authenticate, requireRole('admin'), persistImages, ah(async (req, res) => {
  const rows = await build(body(req, bulk(locationInput)));
  const created = await Location.insertMany(rows);
  invalidateSearchIndex();
  res.status(201).json(created.map((d: any) => toDto(d.toObject())));
}));

locationsRouter.post('/', authenticate, requireRole('admin'), persistImages, ah(async (req, res) => {
  const [row] = await build([body(req, locationInput)]);
  const created = await Location.create(row);
  invalidateSearchIndex();
  res.status(201).json(toDto(created.toObject()));
}));

locationsRouter.get('/:id/', ah(async (req, res) => {
  const doc = await Location.findById(req.params.id).lean();
  if (!doc) throw notFound('Location');
  res.json(toDto(doc));
}));

locationsRouter.patch('/:id/', authenticate, requireRole('admin'), persistImages, ah(async (req, res) => {
  const patch = provided(body(req, locationInput.partial()), req.body);
  const doc = await Location.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true }).lean<any>();
  if (!doc) throw notFound('Location');
  if (patch.name) await Experience.updateMany({ locationId: doc._id }, { $set: { locationName: doc.name } });
  invalidateSearchIndex();
  res.json(toDto(doc));
}));

locationsRouter.delete('/:id/', authenticate, requireRole('admin'), ah(async (req, res) => {
  if (!(await Location.findByIdAndDelete(req.params.id))) throw notFound('Location');
  invalidateSearchIndex();
  res.status(204).end();
}));
