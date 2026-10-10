import type { Request } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { badRequest } from '../utils/errors.js';

/** Parses with zod; on failure throws a 400 whose message is the first problem, as a sentence. */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const errors = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw badRequest(errors[0]?.message || 'Check the highlighted fields and try again.', errors);
}

/** For PATCH: zod 4 fills defaults even inside `.partial()`, so keep only the keys the client sent. */
export function provided<T extends Record<string, unknown>>(parsed: T, raw: unknown): Partial<T> {
  const sent = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => k in sent)) as Partial<T>;
}

export const body = <T extends ZodTypeAny>(req: Request, schema: T) => parse(schema, req.body);
export const query = <T extends ZodTypeAny>(req: Request, schema: T) => parse(schema, req.query);
