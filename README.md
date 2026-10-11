# Tourista Rwanda — Backend

Node.js + TypeScript + Express + MongoDB API for the Tourista Rwanda frontend (`../Tourista-rwanda-fe`).
It implements `BACKEND_SPEC.md`, so the frontend works with `VITE_USE_MOCK=false` and
`VITE_API_BASE_URL=http://localhost:8000/api`.

> **⚠️ Simulated payments.** `PAYMENT_PROVIDER=simulated` approves every payment. It exists so the
> booking flow can be built and demoed. **Never use it in production.** With `NODE_ENV=production` the
> server refuses to start unless `ALLOW_SIMULATED_PAYMENTS=true` is set explicitly. Real gateways plug in
> behind `src/providers/payment.ts` (needs webhooks and idempotency keys first).

## Run it

MongoDB must run as a **replica set**: booking and review writes use transactions.

```bash
# Option A: Docker (Mongo replica set + API)
docker compose up --build
docker compose exec api node dist/db/seed/run.js --reset

# Option B: local mongod
mongod --replSet rs0 --dbpath /tmp/tourista-db &
mongosh --eval 'rs.initiate()'
cp .env.example .env
npm install
npm run seed      # idempotent upsert; `npm run seed:reset` drops the database first
npm run dev       # http://localhost:8000/api
```

If Mongo is not a replica set the API still starts but logs a warning, and concurrent bookings are
**not** race-safe.

### Demo accounts (password `password`)

| Role | Email |
|---|---|
| Tourist | `tourist@tourista.rw` |
| Business owner | `business@tourista.rw` |
| Admin | `admin@tourista.rw` |

## API docs (Swagger)

With the server running, open **http://localhost:8000/api/docs**. The raw OpenAPI 3 document is at
`/api/openapi.json`.

1. Run `POST /auth/login/` with a demo account and copy the `token`.
2. Press **Authorize**, paste the token (no `Bearer ` prefix), then try any endpoint.

Request-body schemas are generated from the same zod schemas the server validates with, and a test checks
that the document is valid OpenAPI and that every documented route exists.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | API with reload |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run seed` / `seed:reset` | Load the demo catalogue, users, reviews and a year of bookings (refused in production) |
| `npm run create-admin -- <email> "<name>" <password>` | Create or reset a real admin without demo data (`create-admin:prod` runs the compiled build) |
| `npm test` | Unit + integration tests (spins up an in-memory Mongo replica set) |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint |
| `npm run check` | Typecheck + lint + tests (run this in CI) |

Tests start `mongodb-memory-server`. It uses `$MONGOMS_SYSTEM_BINARY` (or `~/mongodb-macos-x86_64-8.0.4/bin/mongod`
if present) so no download is needed; otherwise it downloads a mongod on first run.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8000` | |
| `MONGODB_URI` | `mongodb://localhost:27017/tourista?replicaSet=rs0` | |
| `JWT_SECRET` | dev value | **Required** (non-default) in production |
| `JWT_EXPIRES_IN` | `7d` | |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allow-list |
| `FRONTEND_URL` | `http://localhost:5173` | Used in password-reset emails |
| `DEFAULT_USER_PASSWORD` | – | Dev only. Used for admin-created users and seeding. Unset in production: users get a random password and a reset email |
| `PAYMENT_PROVIDER` | `simulated` | See warning above |
| `ALLOW_SIMULATED_PAYMENTS` | `false` | Must be `true` to run `simulated` in production |
| `STORAGE_DRIVER` | `disk` | `s3` is a seam, not implemented |
| `UPLOAD_DIR` / `PUBLIC_MEDIA_URL` | `./uploads` / `http://localhost:8000/uploads` | Photos are saved in `<project>/uploads` (resolved from the project root, created at startup, startup fails if it is not writable) and served at `/uploads` |
| `SMTP_URL` / `MAIL_FROM` | empty | Without SMTP, emails are not sent (a warning is logged; bodies are logged only outside production) |
| `TRUST_PROXY` | `1` | Number of reverse proxies in front of the API (needed for correct client IPs / rate limits) |
| `RATE_LIMIT_PER_MIN` | `300` | Per-IP limit across `/api`; `/auth/*` has its own stricter 10/min |
| `LOG_LEVEL` | by `NODE_ENV` | `fatal`…`trace`, `silent` |
| `ALLOW_PRODUCTION_SEED` | `false` | Demo seeding is refused in production unless `true` |

## Endpoints (all under `/api`; trailing slash optional)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register/` · `POST /auth/login/` · `GET,PATCH /auth/me/` · `POST /auth/password-reset/` · `POST /auth/password-reset/confirm/` |
| Users (admin) | `GET,POST /users/` · `POST /users/bulk/` · `GET /users/:id/` (self/admin) · `DELETE /users/:id/` |
| Locations | `GET /locations/` · `GET /locations/:id/` · admin: `POST /locations/` · `POST /locations/bulk/` · `PATCH,DELETE /locations/:id/` |
| Experiences | `GET /experiences/` · `GET /experiences/:id/` · admin: `POST`, `PATCH,DELETE /:id/` |
| Businesses | `GET /businesses/?owner=&category=&locationId=` · `GET /businesses/:id/` · `GET /businesses/:id/payout/` · owner/admin: `POST`, `PATCH /:id/` · admin: `POST /businesses/bulk/` |
| Reviews | `GET /reviews/?targetId=&userId=` · `POST /reviews/` · `DELETE /reviews/:id/` |
| Itineraries | `GET,POST /itineraries/` · `GET,PUT,DELETE /itineraries/:id/` |
| Bookings | `GET /bookings/` (role-scoped) · `GET /bookings/availability/` (public, no PII) · `GET /bookings/:id/` · `POST /bookings/` · `POST /bookings/:id/decision/` (host approve/decline) · `POST /bookings/:id/pay/` (guest transfer proof) · `POST /bookings/:id/confirm-payment/` (host) · `PATCH /bookings/:id/` `{status:"Canceled"}` |
| Refunds | `GET,POST /refunds/` · `GET /refunds/:id/` · `POST /refunds/:id/approve\|reject/` (admin) · `POST /refunds/:id/complete/` (host) · `POST /refunds/:id/cancel/` (traveller) |
| Staff | `GET,POST /staff/` · `PATCH,DELETE /staff/:id/` (business owner; admin with `ownerId`) |
| Notifications | `GET /notifications/` · `GET /notifications/unread-count/` · `POST /notifications/read-all/` · `PATCH /notifications/:id/read/` |
| Fees (admin) | `GET /fees/` |
| Favorites | `GET,POST /favorites/` · `DELETE /favorites/:itemId/` |
| Search | `GET /search/?q=&scope=all\|accommodations\|restaurants\|businesses` |
| Analytics (admin) | `GET /analytics/overview/` · `PUT /analytics/baseline/` |
| Misc | `POST /uploads/` (multipart `file`) · `GET /health` · static `/uploads/*` (alias `/media/*`) · `GET /api/docs` · `GET /api/openapi.json` |

Errors are `{ "message": "...", "status": 409, "errors"?: [{ "path", "message" }] }`.

## Deploying

The API is a stateless Node process plus MongoDB and a directory for uploaded photos.

**Checklist**

1. **MongoDB must be a replica set** (Atlas, or a single-node set via `docker-compose.yml`). Set `MONGODB_URI`.
2. **Set secrets:** `JWT_SECRET` (≥ 32 random chars), `CORS_ORIGINS` and `FRONTEND_URL` (your real site), `PUBLIC_MEDIA_URL`
   (the public URL of `/uploads`), and `SMTP_URL` for password-reset and booking emails.
3. **Payments:** only the simulated provider exists. It approves everything, so the server refuses to start in
   production unless you set `ALLOW_SIMULATED_PAYMENTS=true` (demo/staging only). Do not take real money with it.
4. **Persist the `uploads/` folder** (`UPLOAD_DIR`, a volume or disk). Photos are stored there and served from `/uploads`; `STORAGE_DRIVER=s3` is not implemented.
5. **Put TLS in front** (nginx, Caddy, a cloud load balancer) and set `TRUST_PROXY` to the number of proxies.
6. **Create the first admin** with `npm run create-admin:prod -- <email> "<name>" <password>`. Do not seed demo data.
7. **Probe `/health`**: 200 when MongoDB is connected, 503 otherwise. Logs are JSON (pino), with tokens and
   payment/payout fields redacted.

**Docker**

```bash
cp .env.docker.example .env.docker      # fill in the values
docker compose up -d --build
docker compose exec api node dist/db/createAdmin.js admin@example.com "Admin" 'a-strong-password'
```

The image runs as a non-root user, has a healthcheck, and shuts down cleanly on `SIGTERM`.

**Without Docker**

```bash
npm ci && npm run build
NODE_ENV=production node dist/server.js
```

**Startup guards** (production refuses to start when): `MONGODB_URI` is unset; `JWT_SECRET` is short or a placeholder;
the simulated payment provider is on without `ALLOW_SIMULATED_PAYMENTS=true`; `DEFAULT_USER_PASSWORD` is the demo
password; `STORAGE_DRIVER=s3`.

**Operational notes**

- Request bodies are capped at 256 KB, except photo-carrying routes (locations, businesses, experiences, users,
  `auth/me`) at 30 MB.
- Back up MongoDB and `UPLOAD_DIR` together; booking `payment` records are the financial source of truth.
- Search results are cached in memory for up to 45 s per instance and invalidated on writes in that instance, so
  with several instances a new listing can take up to 45 s to appear in search.

## Booking lifecycle

```
Pending ──host approves──▶ AwaitingPayment ──guest sends ≥30%──▶ PaymentReview ──host confirms──▶ Confirmed
   │                              │ (2 h window)                                                        │
   └─host declines─▶ Declined     └─not paid in time─▶ Expired                  guest asks refund ─▶ RefundPending
                                                                                        │ admin approves, host returns money
                                                                                        ▼
                                                                                    Refunded
```

- **Stock:** every booking except `Canceled`, `Declined`, `Expired` and `Refunded` holds inventory, including
  `Pending`. Availability is checked inside a transaction when the request is created.
- **Payments are off-platform transfers.** The guest sends money to the host's bank/MoMo number (read from the
  owner's profile, never from the client) and uploads a screenshot; the **host** confirms receipt. Admins do not
  approve payments. A 10% subscription fee (`/fees/`) is recorded on each paid booking.
- **Cancel:** unpaid bookings can be canceled by the guest, host or admin. A paid booking must go through a refund.
- **Refunds:** `admin_review → returning → completed` (or `rejected` / `canceled`); a rejected or withdrawn
  request returns the booking to `Confirmed`.
- **Staff** are users with role `staff`, tied to an owner and to assigned branches (one active manager per branch).
  They approve bookings, confirm payments, complete refunds and edit offerings on assigned branches only.
- **Vehicles** are services with `group: "vehicle"` and a list of registration plates; the server assigns free
  plates per hire (`lines[].plateNumbers`) and refuses when the fleet is out.
- **Notifications** are created by the server on booking, payment, refund, review and staff events.
- Admins can still record a desk payment by sending `payment` with `POST /bookings/`; that confirms instantly.

## Behaviour worth knowing

- **Prices are server-authoritative.** Line prices and totals are recomputed from the catalogue with the
  same functions as the frontend (`src/domain/pricing.ts`). A stale client total returns 409.
- **Inventory** is held by every booking that is not canceled, declined, expired or refunded. The availability check and insert run in a
  transaction that also bumps `bookingSeq` on the business document, so two guests paying for the last
  room cannot both succeed (covered by a test).
- **Ratings** are recomputed from the reviews actually stored when a review is added or removed.
  Seeded `rating`/`reviewCount` are marketing figures and are replaced on the first review for that target.
- **Images** sent as base64 data URLs are validated by magic bytes, re-encoded with `sharp`, written to
  `UPLOAD_DIR`, and replaced by a URL before the database write.
- **Dates** (`date`, `endDate`, review dates) are plain `YYYY-MM-DD` strings; "today" is `Africa/Kigali`.
- **Experience and location bookings** have no business owner, so there is no payout account to check;
  the payment is labelled `Tourista Rwanda`.

## Layout

```
src/domain/     pricing, availability, payout, search — pure functions ported from the frontend
src/models/     Mongoose schemas
src/modules/    one folder-level file per resource (routes + service + zod schemas)
src/providers/  payment (simulated + interface), mail, storage
src/db/seed/    seed runner, bookings generator, JSON snapshots of the frontend demo data
test/           vitest + supertest against an in-memory replica set
```
