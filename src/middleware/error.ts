import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../utils/errors.js';
import { logger } from '../logger.js';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ message: 'That endpoint was not found.', status: 404 });
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message, status: err.status, ...(err.errors ? { errors: err.errors } : {}) });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'That upload is too large. Use fewer or smaller photos.', status: 413 });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'The request body is not valid JSON.', status: 400 });
  }
  if (err?.name === 'MulterError') {
    return res.status(400).json({ message: 'That file is too large or not allowed. Photos must be JPEG, PNG or WebP up to 15 MB.', status: 400 });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ message: 'That record already exists.', status: 409 });
  }
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ message: 'Something went wrong on our side. Please try again.', status: 500 });
}
