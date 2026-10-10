import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/index.js';
import { forbidden, unauthorized } from '../utils/errors.js';
import type { UserRole } from '../domain/types.js';
import { ah } from '../utils/async.js';

export interface AuthUser {
  id: string;
  role: UserRole;
  name: string;
  email: string;
  avatar?: string;
  phone?: string;
  country?: string;
  businessName?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const signToken = (user: { id: string; role: string }) =>
  jwt.sign({ role: user.role }, config.JWT_SECRET, { subject: user.id, expiresIn: config.JWT_EXPIRES_IN as any, algorithm: 'HS256' });

async function loadUser(req: Request) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  let sub: string | undefined;
  try {
    sub = jwt.verify(header.slice(7), config.JWT_SECRET, { algorithms: ['HS256'] }).sub as string;
  } catch {
    throw unauthorized('Your session has expired. Log in again.');
  }
  // Re-load per request so deleted users and role changes take effect immediately.
  const doc = await User.findById(sub).lean();
  if (!doc) throw unauthorized('Your session has expired. Log in again.');
  const { _id, name, email, role, avatar, phone, country, businessName } = doc as any;
  req.user = { id: _id, name, email, role, avatar, phone, country, businessName };
  return req.user;
}

export const authenticate = ah(async (req, _res, next) => {
  if (!(await loadUser(req))) throw unauthorized();
  next();
});

/** Identifies the caller if a valid token is sent; a missing, expired or invalid token means anonymous. */
export const optionalAuth = ah(async (req, _res, next) => {
  try {
    await loadUser(req);
  } catch {
    req.user = undefined;
  }
  next();
});

export const requireRole = (...roles: UserRole[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};
