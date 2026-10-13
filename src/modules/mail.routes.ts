import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../utils/async.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { body } from '../middleware/validate.js';
import { flushMail, mailStatus, verifyMail } from '../providers/mail.js';
import { emailTest } from './emails.service.js';
import { email } from './common.js';

export const mailRouter = Router();
mailRouter.use(authenticate, requireRole('admin'));

/** Is email configured, can we log in, and how have recent deliveries gone? Passwords are never returned. */
mailRouter.get('/status/', ah(async (_req, res) => {
  await verifyMail();
  res.json(mailStatus());
}));

/** Sends a short test message to the given address (default: the admin's own). */
mailRouter.post('/test/', ah(async (req, res) => {
  const { to } = body(req, z.object({ to: email.optional() }));
  const recipient = to ?? req.user!.email;
  emailTest(recipient, req.user!.email);
  await flushMail(20_000);
  res.status(202).json({ to: recipient, ...mailStatus() });
}));
