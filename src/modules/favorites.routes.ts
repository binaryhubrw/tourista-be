import { Router } from 'express';
import { z } from 'zod';
import { Favorite } from '../models/index.js';
import { ah } from '../utils/async.js';
import { authenticate } from '../middleware/auth.js';
import { body } from '../middleware/validate.js';

export const favoriteInput = z.object({
  itemId: z.string().trim().min(1).max(120),
  itemType: z.enum(['location', 'experience', 'business']),
  title: z.string().trim().max(200).default(''),
  subtitle: z.string().trim().max(300).default(''),
  image: z.string().trim().max(2000).default(''),
  href: z.string().trim().max(500).default(''),
});

const dto = (d: any) => ({ id: `fav-${d.itemId}`, itemId: d.itemId, itemType: d.itemType, title: d.title, subtitle: d.subtitle, image: d.image, href: d.href, addedAt: d.addedAt });

export const favoritesRouter = Router();
favoritesRouter.use(authenticate);

favoritesRouter.get('/', ah(async (req, res) => {
  const docs = await Favorite.find({ userId: req.user!.id }).sort({ addedAt: -1 }).lean();
  res.json(docs.map(dto));
}));

favoritesRouter.post('/', ah(async (req, res) => {
  const data = body(req, favoriteInput);
  const _id = `fav-${data.itemId}:${req.user!.id}`;
  // Idempotent: adding an existing favorite returns it unchanged.
  const doc = await Favorite.findOneAndUpdate(
    { _id },
    { $setOnInsert: { ...data, _id, userId: req.user!.id, addedAt: new Date().toISOString() } },
    { upsert: true, new: true },
  ).lean();
  res.status(201).json(dto(doc));
}));

favoritesRouter.delete('/:itemId/', ah(async (req, res) => {
  // Idempotent: removing something that is already gone is still a success.
  await Favorite.deleteOne({ userId: req.user!.id, itemId: req.params.itemId });
  res.status(204).end();
}));
