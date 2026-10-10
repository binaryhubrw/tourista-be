import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import { ah } from '../utils/async.js';
import { badRequest } from '../utils/errors.js';
import { MAX_IMAGE_BYTES, storeImage } from '../providers/storage.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});

export const uploadsRouter = Router();

uploadsRouter.post('/', authenticate, upload.single('file'), ah(async (req, res) => {
  if (!req.file) throw badRequest('Choose a JPEG, PNG or WebP photo up to 15 MB.');
  res.status(201).json({ url: await storeImage(req.file.buffer) });
}));
