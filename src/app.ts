import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { config, corsOrigins, isTest, uploadDir } from './config.js';
import { logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './modules/auth.routes.js';
import { usersRouter } from './modules/users.routes.js';
import { locationsRouter } from './modules/locations.routes.js';
import { experiencesRouter } from './modules/experiences.routes.js';
import { businessesRouter } from './modules/businesses.routes.js';
import { reviewsRouter } from './modules/reviews.routes.js';
import { itinerariesRouter } from './modules/itineraries.routes.js';
import { bookingsRouter } from './modules/bookings.routes.js';
import { favoritesRouter } from './modules/favorites.routes.js';
import { searchRouter } from './modules/search.routes.js';
import { analyticsRouter } from './modules/analytics.routes.js';
import { uploadsRouter } from './modules/uploads.routes.js';
import { refundsRouter } from './modules/refunds.routes.js';
import { staffRouter } from './modules/staff.routes.js';
import { notificationsRouter } from './modules/notifications.routes.js';
import { feesRouter } from './modules/fees.routes.js';
import swaggerUi from 'swagger-ui-express';
import { openApiDocument } from './docs/openapi.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(pinoHttp({ logger, genReqId: (req) => req.headers['x-request-id']?.toString() ?? randomUUID(), autoLogging: { ignore: (r) => r.url === '/health' } }));
  // `upgrade-insecure-requests` is dropped: it stops Swagger UI loading over http://localhost in Safari.
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: { useDefaults: true, directives: { upgradeInsecureRequests: null } },
  }));
  app.use(cors({ origin: corsOrigins, credentials: false }));
  // Only routes that carry photos (base64 data URLs, swapped for stored URLs by persistImages) may be large.
  const photoRoutes = ['/api/locations', '/api/businesses', '/api/experiences', '/api/users', '/api/auth/me', '/api/bookings', '/api/refunds'];
  app.use(photoRoutes, express.json({ limit: '30mb' }));
  app.use(express.json({ limit: '256kb' }));

  // Photos live in the uploads folder. `/media` is kept as an alias so URLs saved earlier keep working.
  const files = express.static(uploadDir, { maxAge: '7d', immutable: true, index: false, dotfiles: 'deny' });
  app.use('/uploads', files);
  app.use('/media', files);

  // Readiness: 503 while MongoDB is unreachable so orchestrators stop routing traffic here.
  const health = (_req: express.Request, res: express.Response) => {
    const ready = mongoose.connection.readyState === 1;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable' });
  };
  app.get('/health', health);

  const api = express.Router();
  api.use(rateLimit({
    windowMs: 60_000, limit: config.RATE_LIMIT_PER_MIN, standardHeaders: true, legacyHeaders: false, skip: () => isTest,
    handler: (_req, res) => res.status(429).json({ message: 'Too many requests. Slow down and try again shortly.', status: 429 }),
  }));
  api.get('/health', health);
  api.get('/openapi.json', (_req, res) => res.json(openApiDocument));
  api.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, { customSiteTitle: 'Tourista Rwanda API', swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' } }));
  api.use('/auth', authRouter);
  api.use('/users', usersRouter);
  api.use('/locations', locationsRouter);
  api.use('/experiences', experiencesRouter);
  api.use('/businesses', businessesRouter);
  api.use('/reviews', reviewsRouter);
  api.use('/itineraries', itinerariesRouter);
  api.use('/bookings', bookingsRouter);
  api.use('/favorites', favoritesRouter);
  api.use('/search', searchRouter);
  api.use('/analytics', analyticsRouter);
  api.use('/uploads', uploadsRouter);
  api.use('/refunds', refundsRouter);
  api.use('/staff', staffRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/fees', feesRouter);
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
