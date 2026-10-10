import { Router } from 'express';
import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Business, Experience, Location, Review, User } from '../models/index.js';
import { ah } from '../utils/async.js';
import { forbidden, notFound, unprocessable } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { todayIso } from '../utils/dates.js';
import { toDto, toDtos } from '../utils/dto.js';
import { authenticate } from '../middleware/auth.js';
import { body, query } from '../middleware/validate.js';
import { invalidateSearchIndex } from './search.service.js';

const targetModels = { location: Location, experience: Experience, business: Business } as const;

export const reviewInput = z.object({
  targetId: z.string().trim().min(1),
  targetType: z.enum(['location', 'experience', 'business']),
  rating: z.number({ error: 'Choose a rating from 1 to 5.' }).int().min(1, 'Choose a rating from 1 to 5.').max(5, 'Choose a rating from 1 to 5.'),
  comment: z.string().trim().min(10, 'Write at least 10 characters so others can learn from your visit.').max(1000, 'Keep your review under 1,000 characters.'),
  userName: z.string().trim().max(120).optional(),
});

/** Sets the target's rating (mean, 1 decimal) and reviewCount from its actual reviews. */
async function recompute(targetType: keyof typeof targetModels, targetId: string, session: ClientSession) {
  const [agg] = await Review.aggregate([
    { $match: { targetId } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]).session(session);
  const rating = agg ? Math.round(agg.avg * 10) / 10 : 0;
  await targetModels[targetType].updateOne({ _id: targetId }, { $set: { rating, reviewCount: agg?.count ?? 0 } }, { session });
}

export const reviewsRouter = Router();

reviewsRouter.get('/', ah(async (req, res) => {
  const q = query(req, z.object({ targetId: z.string().optional(), userId: z.string().optional() }));
  const filter: Record<string, string> = {};
  if (q.targetId) filter.targetId = q.targetId;
  if (q.userId) filter.userId = q.userId;
  res.json(toDtos(await Review.find(filter).sort({ date: -1, _id: -1 }).lean()));
}));

reviewsRouter.post('/', authenticate, ah(async (req, res) => {
  const input = body(req, reviewInput);
  const target = await targetModels[input.targetType].findById(input.targetId, { name: 1, title: 1 }).lean<any>();
  if (!target) throw unprocessable('That place or listing could not be found, so it cannot be reviewed.');
  const author = await User.findById(req.user!.id, { avatar: 1 }).lean<any>();
  const review = {
    _id: newId('rev'),
    targetId: input.targetId,
    targetType: input.targetType,
    targetName: target.name ?? target.title,
    userId: req.user!.id,
    // Only admins may publish feedback under another name (collected offline).
    userName: req.user!.role === 'admin' && input.userName ? input.userName : req.user!.name,
    ...(req.user!.role !== 'admin' && author?.avatar ? { userAvatar: author.avatar } : {}),
    rating: input.rating,
    comment: input.comment,
    date: todayIso(),
  };
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Review.create([review], { session });
      await recompute(input.targetType, input.targetId, session);
    });
  } finally {
    await session.endSession();
  }
  invalidateSearchIndex();
  res.status(201).json(toDto(review));
}));

reviewsRouter.delete('/:id/', authenticate, ah(async (req, res) => {
  const review = await Review.findById(req.params.id).lean<any>();
  if (!review) throw notFound('Review');
  if (req.user!.role !== 'admin' && review.userId !== req.user!.id) throw forbidden('You can only delete your own reviews.');
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Review.deleteOne({ _id: review._id }, { session });
      await recompute(review.targetType, review.targetId, session);
    });
  } finally {
    await session.endSession();
  }
  invalidateSearchIndex();
  res.status(204).end();
}));
