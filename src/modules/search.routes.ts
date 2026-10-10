import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../utils/async.js';
import { query } from '../middleware/validate.js';
import { runSearch } from './search.service.js';

export const searchRouter = Router();

searchRouter.get('/', ah(async (req, res) => {
  const { q, scope } = query(req, z.object({
    q: z.string().trim().max(200).default(''),
    scope: z.enum(['all', 'accommodations', 'restaurants', 'businesses']).default('all'),
  }));
  res.json(await runSearch(q, scope));
}));
