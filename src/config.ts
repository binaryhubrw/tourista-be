import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8000),
  MONGODB_URI: z.string().default('mongodb://localhost:27017/tourista?replicaSet=rs0'),
  JWT_SECRET: z.string().min(8).default('change-me-in-dev'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  DEFAULT_USER_PASSWORD: z.string().optional(),
  PAYMENT_PROVIDER: z.string().default('simulated'),
  ALLOW_SIMULATED_PAYMENTS: bool,
  STORAGE_DRIVER: z.enum(['disk', 's3']).default('disk'),
  UPLOAD_DIR: z.string().default('./uploads'),
  PUBLIC_MEDIA_URL: z.string().default('http://localhost:8000/uploads'),
  /** Either a full URL (`smtp://user:pass@host:587`) or the discrete MAIL_* variables below. */
  SMTP_URL: z.string().optional(),
  MAIL_HOST: z.string().optional(),
  MAIL_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  MAIL_USER: z.string().optional(),
  MAIL_PASS: z.string().optional(),
  /** Implicit TLS (port 465). Defaults to true when the port is 465, otherwise STARTTLS is used. */
  MAIL_SECURE: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
  MAIL_FROM: z.string().default('Tourista Rwanda <no-reply@tourista.rw>'),
  MAIL_REPLY_TO: z.string().optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(300),
  ALLOW_PRODUCTION_SEED: bool,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
/** Project root (this file lives in `src/` or `dist/`, one level below it). */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute folder where uploaded photos are kept: `<project>/uploads` unless UPLOAD_DIR says otherwise. */
export const uploadDir = path.resolve(projectRoot, config.UPLOAD_DIR);

export const corsOrigins = config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

if (isProd) {
  const problems: string[] = [];
  if (!process.env.MONGODB_URI) problems.push('MONGODB_URI must be set explicitly.');
  if (config.JWT_SECRET.length < 32 || /^change-me/.test(config.JWT_SECRET)) {
    problems.push('JWT_SECRET must be a random string of at least 32 characters (e.g. `openssl rand -base64 48`).');
  }
  if (config.PAYMENT_PROVIDER === 'simulated' && !config.ALLOW_SIMULATED_PAYMENTS) {
    problems.push('PAYMENT_PROVIDER=simulated is refused in production unless ALLOW_SIMULATED_PAYMENTS=true.');
  }
  if (config.DEFAULT_USER_PASSWORD === 'password') {
    problems.push('DEFAULT_USER_PASSWORD must not be the demo password in production; unset it.');
  }
  if (config.STORAGE_DRIVER !== 'disk') problems.push('STORAGE_DRIVER=s3 is not implemented yet; use disk with a persistent volume.');
  if (problems.length) {
    console.error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  for (const [name, value] of [['CORS_ORIGINS', config.CORS_ORIGINS], ['FRONTEND_URL', config.FRONTEND_URL], ['PUBLIC_MEDIA_URL', config.PUBLIC_MEDIA_URL]] as const) {
    if (/localhost|127\.0\.0\.1/.test(value)) console.warn(`[config] ${name} still points at localhost: ${value}`);
  }
}

export const PASSWORD_MIN_LENGTH = 6;
export const BCRYPT_COST = isTest ? 4 : 10;
