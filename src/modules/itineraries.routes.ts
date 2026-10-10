import { Router } from 'express';
import { z } from 'zod';
import { Itinerary, Location } from '../models/index.js';
import { ah } from '../utils/async.js';
import { badRequest, notFound, unprocessable } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { toDto, toDtos } from '../utils/dto.js';
import { authenticate } from '../middleware/auth.js';
import { body } from '../middleware/validate.js';
import { isoDate, nonEmpty } from './common.js';

const stop = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  locationId: nonEmpty('Location'),
  day: z.number().int().min(1, 'Each stop needs a day of 1 or more.').max(365),
  note: z.string().trim().max(1000).optional(),
});

export const itineraryInput = z.object({
  title: nonEmpty('A title'),
  description: z.string().trim().max(5000).default(''),
  startDate: isoDate,
  endDate: isoDate,
  stops: z.array(stop).max(50).default([]),
});

async function build(input: z.infer<typeof itineraryInput>) {
  if (input.endDate < input.startDate) throw badRequest('The end date cannot be before the start date.');
  const ids = [...new Set(input.stops.map((s) => s.locationId))];
  const locs = await Location.find({ _id: { $in: ids } }, { name: 1, image: 1 }).lean<any[]>();
  const byId = new Map(locs.map((l) => [l._id as string, l]));
  return {
    title: input.title,
    description: input.description,
    startDate: input.startDate,
    endDate: input.endDate,
    stops: input.stops.map((s) => {
      const loc = byId.get(s.locationId);
      if (!loc) throw unprocessable('One of the stops is a place that no longer exists.');
      return { id: s.id || newId('stop'), locationId: s.locationId, locationName: loc.name, image: loc.image, day: s.day, ...(s.note ? { note: s.note } : {}) };
    }),
  };
}

export const itinerariesRouter = Router();
itinerariesRouter.use(authenticate);

itinerariesRouter.get('/', ah(async (req, res) => {
  res.json(toDtos(await Itinerary.find({ userId: req.user!.id }).sort({ updatedAt: -1 }).lean()));
}));

itinerariesRouter.post('/', ah(async (req, res) => {
  const data = await build(body(req, itineraryInput));
  const now = new Date().toISOString();
  const doc = await Itinerary.create({ ...data, _id: newId('itin'), userId: req.user!.id, createdAt: now, updatedAt: now });
  res.status(201).json(toDto(doc.toObject()));
}));

itinerariesRouter.get('/:id/', ah(async (req, res) => {
  const doc = await Itinerary.findById(req.params.id).lean<any>();
  if (!doc || (doc.userId !== req.user!.id && req.user!.role !== 'admin')) throw notFound('Itinerary');
  res.json(toDto(doc));
}));

itinerariesRouter.put('/:id/', ah(async (req, res) => {
  const existing = await Itinerary.findById(req.params.id, { userId: 1 }).lean<any>();
  if (!existing || existing.userId !== req.user!.id) throw notFound('Itinerary');
  const data = await build(body(req, itineraryInput));
  const doc = await Itinerary.findByIdAndUpdate(req.params.id, { $set: { ...data, updatedAt: new Date().toISOString() } }, { new: true }).lean();
  res.json(toDto(doc));
}));

itinerariesRouter.delete('/:id/', ah(async (req, res) => {
  const res2 = await Itinerary.deleteOne({ _id: req.params.id, userId: req.user!.id });
  if (!res2.deletedCount) throw notFound('Itinerary');
  res.status(204).end();
}));
