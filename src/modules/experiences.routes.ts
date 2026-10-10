import { Router } from 'express';
import { z } from 'zod';
import { EXPERIENCE_TYPES, INTERESTS } from '../domain/catalog.js';
import { Experience, Location } from '../models/index.js';
import { ah } from '../utils/async.js';
import { notFound, unprocessable } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { toDto, toDtos } from '../utils/dto.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { body, provided } from '../middleware/validate.js';
import { persistImages } from '../middleware/persistImages.js';
import { money, nonEmpty } from './common.js';

export const experienceInput = z.object({
  title: nonEmpty('Title'),
  type: z.enum(EXPERIENCE_TYPES),
  locationId: nonEmpty('Location'),
  description: z.string().trim().max(5000).default(''),
  image: nonEmpty('A cover photo', 2_000_000),
  duration: z.string().trim().max(60).default(''),
  priceRwf: money,
  hostName: z.string().trim().max(120).default(''),
  interests: z.array(z.enum(INTERESTS)).default([]),
  communityLed: z.boolean().default(false),
});

async function locationName(id: string) {
  const loc = await Location.findById(id, { name: 1 }).lean<any>();
  if (!loc) throw unprocessable('Choose a location that exists.');
  return loc.name as string;
}

export const experiencesRouter = Router();

experiencesRouter.get('/', ah(async (_req, res) => {
  res.json(toDtos(await Experience.find().lean()));
}));

experiencesRouter.get('/:id/', ah(async (req, res) => {
  const doc = await Experience.findById(req.params.id).lean();
  if (!doc) throw notFound('Experience');
  res.json(toDto(doc));
}));

experiencesRouter.post('/', authenticate, requireRole('admin'), persistImages, ah(async (req, res) => {
  const input = body(req, experienceInput);
  const doc = await Experience.create({
    ...input, _id: newId('exp'), locationName: await locationName(input.locationId),
    rating: 0, reviewCount: 0, createdAt: new Date().toISOString(),
  });
  res.status(201).json(toDto(doc.toObject()));
}));

experiencesRouter.patch('/:id/', authenticate, requireRole('admin'), persistImages, ah(async (req, res) => {
  const patch: Record<string, unknown> = provided(body(req, experienceInput.partial()), req.body);
  if (typeof patch.locationId === 'string') patch.locationName = await locationName(patch.locationId);
  const doc = await Experience.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true }).lean();
  if (!doc) throw notFound('Experience');
  res.json(toDto(doc));
}));

experiencesRouter.delete('/:id/', authenticate, requireRole('admin'), ah(async (req, res) => {
  if (!(await Experience.findByIdAndDelete(req.params.id))) throw notFound('Experience');
  res.status(204).end();
}));
