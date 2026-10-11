import type { NextFunction, Request, Response } from 'express';
import { storeImage } from '../providers/storage.js';
import { badRequest } from '../utils/errors.js';

const DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/is;
const MAX_PHOTOS = 6;

async function persist(value: unknown): Promise<unknown> {
  if (typeof value !== 'string') return value;
  const m = DATA_URL.exec(value);
  if (!m) {
    if (value.startsWith('data:')) throw badRequest('Photos must be JPEG, PNG or WebP images.');
    return value; // http(s) URLs and relative paths pass through
  }
  return storeImage(Buffer.from(m[2], 'base64'));
}

async function persistRecord(rec: any) {
  if (!rec || typeof rec !== 'object') return;
  if ('image' in rec) rec.image = await persist(rec.image);
  if ('avatar' in rec) rec.avatar = await persist(rec.avatar);
  // Payment and refund proof photos (transfer screenshots, receipts).
  for (const key of ['screenshot', 'proof', 'travelerProof', 'ownerReturnProof', 'travelerReceivedProof']) {
    if (key in rec) rec[key] = await persist(rec[key]);
  }
  if (Array.isArray(rec.services)) {
    for (const service of rec.services) {
      if (!service || typeof service !== 'object') continue;
      if ('image' in service) service.image = await persist(service.image);
      if (Array.isArray(service.units)) {
        for (const unit of service.units) if (unit && typeof unit === 'object' && 'image' in unit) unit.image = await persist(unit.image);
      }
    }
  }
  if (Array.isArray(rec.gallery)) {
    if (rec.gallery.length > MAX_PHOTOS) throw badRequest(`Add up to ${MAX_PHOTOS} photos per listing.`);
    rec.gallery = await Promise.all(rec.gallery.map(persist));
  }
}

/** Replaces base64 data URLs in `image`, `avatar` and `gallery[]` with stored file URLs before the DB write. */
export async function persistImages(req: Request, _res: Response, next: NextFunction) {
  try {
    if (Array.isArray(req.body)) for (const rec of req.body) await persistRecord(rec);
    else await persistRecord(req.body);
    next();
  } catch (e) {
    next(e);
  }
}
