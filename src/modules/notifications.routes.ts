import { Router } from 'express';
import { Notification } from '../models/index.js';
import { ah } from '../utils/async.js';
import { notFound } from '../utils/errors.js';
import { toDto } from '../utils/dto.js';
import { authenticate } from '../middleware/auth.js';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get('/', ah(async (req, res) => {
  const docs = await Notification.find({ userId: req.user!.id }).sort({ createdAt: -1 }).limit(200).lean<any[]>();
  res.json(docs.map((d) => toDto(d)));
}));

notificationsRouter.get('/unread-count/', ah(async (req, res) => {
  res.json({ count: await Notification.countDocuments({ userId: req.user!.id, readAt: { $exists: false } }) });
}));

notificationsRouter.post('/read-all/', ah(async (req, res) => {
  await Notification.updateMany({ userId: req.user!.id, readAt: { $exists: false } }, { $set: { readAt: new Date().toISOString() } });
  res.status(204).end();
}));

notificationsRouter.patch('/:id/read/', ah(async (req, res) => {
  const doc = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user!.id },
    [{ $set: { readAt: { $ifNull: ['$readAt', new Date().toISOString()] } } }],
    { new: true },
  ).lean<any>();
  if (!doc) throw notFound('Notification');
  res.json(toDto(doc));
}));
