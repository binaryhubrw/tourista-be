# Tourista Rwanda — Backend Build Spec (Node.js + MongoDB)

> **Audience:** Claude Code, building the backend from scratch in this directory (`tourista-be/`).
> **Source of truth:** the frontend at `../Tourista-rwanda-fe` (React + TS + Vite). Read it; do not modify it unless a change is listed in §15 and the user approves.
> Key frontend files: `src/types/index.ts` (data shapes), `src/services/*.ts` (every API call), `src/utils/{pricing,availability,payment,catalog}.ts` (business rules), `src/data/*.ts` (seed data), `src/routes/AppRoutes.tsx` (roles/pages).

The frontend currently runs on an in-browser mock DB (`VITE_USE_MOCK=true`). Every service function already has the real call written (`api.get('/locations/')` …). **The job is to implement an API that makes `VITE_USE_MOCK=false` work**, with the same behaviour the mock has — including its business rules (pricing, availability, refunds).

---

## 1. Product summary

Tourism platform for Rwanda. Three roles:

| Role | Can do |
|---|---|
| `tourist` | Browse, search, favorite, build itineraries, book + pay, review, cancel own bookings |
| `business_owner` | Everything public + manage own business listings (hotels, restaurants, guides…), their rooms/services, see bookings and reviews of own listings, decline (cancel) bookings, set payout accounts |
| `admin` ("tourism authority") | Everything: users, locations, businesses, bookings, reviews, analytics, bulk import |

Public (no login): explore/search/map, locations, experiences, businesses, reviews, availability.

Currency is **RWF, integers only**. Languages in UI: en/rw/fr/sw (UI only; API is English).

---

## 2. Stack & conventions

- **Node.js ≥ 20, TypeScript (strict), Express 4/5, Mongoose 8, MongoDB 6+ (replica set — needed for transactions, see §8.4).**
- Validation: **zod** on every request body/query. Auth: **JWT** (access token only — the FE has no refresh flow), `bcryptjs` or `argon2` for passwords.
- Security: `helmet`, `cors` (origin from env, default `http://localhost:5173`), `express-rate-limit` (stricter on `/auth/*`), no stack traces in responses.
- Uploads: `multer` (memory) + `sharp`. Email: `nodemailer` (console/JSON transport in dev). Logging: `pino`.
- Tests: `vitest` + `supertest` + `mongodb-memory-server` (**`MongoMemoryReplSet`**, so transactions work).
- Default **port 8000**, base path **`/api`** (matches FE `.env.example`: `VITE_API_BASE_URL=http://localhost:8000/api`).

### 2.1 Wire-contract rules (must match the FE exactly)

1. **Trailing slashes.** FE calls `/locations/`, `/bookings/:id/pay/`. Express with default non-strict routing accepts both `/x` and `/x/`; keep it that way.
2. **JSON is camelCase**, identical to `src/types/index.ts`. Responses are the TS interfaces, nothing wrapped. List endpoints return **bare arrays** (no `{data, meta}` envelope). If you add pagination, accept optional `?limit&page` and return the total in an `X-Total-Count` header; default = everything (the FE filters/sorts client-side).
3. **IDs are strings, exposed as `id`.** Use string `_id`s (not ObjectId) so seed ids survive and deep links keep working:
   - `Location`: slug of name (`kigali`, `volcanoes-national-park`); on collision append `-2`, `-3`… (FE mock does this).
   - Seeds keep their original ids (`virunga-hillside-ecolodge`, `user-tourist-1`, `u-lisa` …).
   - New records: prefix + `nanoid(10)` → `user-…`, `biz-…`, `exp-…`, `rev-…`, `itin-…`.
   - **Bookings**: `bk-` + 8 chars of base36 uppercase-safe (`bk-k3j9x2ab`). The FE shows `id.toUpperCase()` as the customer-facing reference, so keep it short and unambiguous.
   - A Mongoose `toJSON` transform maps `_id → id`, drops `__v`, `passwordHash`, and other internal fields.
4. **Dates.** `booking.date`, `booking.endDate`, `review.date`, `itinerary.startDate/endDate` are plain **`YYYY-MM-DD` strings** — store them as strings, never `Date` (the FE compares them lexicographically and a timezone shift would corrupt availability). `createdAt/updatedAt/joinedAt/payment.paidAt` are full ISO-8601 strings. "Today" = date in `Africa/Kigali`.
5. **Errors.** Non-2xx responses: `{ "message": "<human readable>", "status": <code>, "errors"?: [{ "path": "...", "message": "..." }] }`. The FE shows `body.detail ?? body.message` straight to the user, so `message` must be a polished sentence. 400 validation, 401 unauthenticated, 403 forbidden, 404 `"<Thing> was not found."`, 409 conflict (e.g. availability, duplicate email), 422 semantic.
6. **Auth header:** `Authorization: Bearer <jwt>`. JWT payload `{ sub: userId, role }`, expiry 7 days (configurable). Re-load the user from DB per request (so deleted users / role changes take effect).
7. **Never trust the client** for identity, prices, totals, ratings, counts, or payment status (see §8).
8. **Body size:** the FE sends photos as base64 data URLs inside JSON (§11). Allow `express.json({ limit: '30mb' })`.

---

## 3. Data model (Mongoose collections)

Shapes below are additions/clarifications on top of `src/types/index.ts` — implement every field there.

### `users`
`_id`, `name`, `email` (unique, lowercased, trimmed), `passwordHash`, `role` (`tourist|business_owner|admin`), `avatar?`, `phone?`, `country?`, `joinedAt` (ISO), and for business owners: `businessName`, `bankAccount`, `mtnNumber`, `airtelNumber`. Optional `preferences { bookingEmails, reviewReplies, newsletter, currency, language }` (FE Settings page has these but doesn't persist yet). Also `passwordResetTokenHash?`, `passwordResetExpiresAt?`.
Index: unique `email`.

### `locations`
Exactly `Location` (`gallery[]`, `coordinates{lat,lng}`, `interests[]`, `thingsToDo[]`, `sustainability[]`, `priceLevel 1|2|3`, `isHiddenGem?`, `isPopular?`, `visitsLastYear`, `rating`, `reviewCount`, `createdAt`).
Indexes: `province`, `category`, text/regex support on name/district/description.

### `experiences`
Exactly `Experience`. `locationId` → locations; `locationName` denormalized (refresh when location renamed).

### `businesses`
Exactly `Business` including embedded `services: Service[]`, `badges[]`, `gallery?`, `listingKind?`, `propertyType?`, `ownerId?`, `ownerName`, `locationId`, `district`.
- `Service.id` is **client-generated and stable** — keep it (bookings reference it). Assign `svc-<nanoid>` if missing.
- `Accommodation` / `Restaurant` in the types are just narrowed views (`roomTypes`, `ecoFeatures`, `cuisine`, `signatureDish`); store them as optional fields on the same document.
- Indexes: `ownerId`, `locationId`, `category`, `createdAt`.

### `reviews`
`Review` (`targetId`, `targetType`, `targetName`, `userId`, `userName`, `userAvatar?`, `rating 1..5`, `comment`, `date`). Indexes: `{targetId, date:-1}`, `{userId, date:-1}`.

### `itineraries`
`Itinerary` with embedded `stops: ItineraryStop[]`. Index `{userId, updatedAt:-1}`.

### `bookings`
`Booking` exactly, plus:
- Always persist `lines[]` (even for single-service bookings) and mirror the first line into legacy `serviceId/serviceName/unitPriceRwf`; `units` = sum of line units.
- `payment?: Payment`.
- Indexes: `{userId, createdAt:-1}`, `{businessId, status, date}`, `{targetId, status, date}`, `{'lines.serviceId':1, status:1}`.

### `favorites` (not in FE services yet, see §9.9)
`{ _id: 'fav-<itemId>:<userId>', userId, itemId, itemType, title, subtitle, image, href, addedAt }`, unique `{userId,itemId}`.

### `tourism_baseline` (singleton)
Holds national-level figures the platform cannot derive from its own data (see §10). Seeded from `src/data/statistics.ts`.

---

## 4. Roles & authorization matrix

| Resource / action | public | tourist | business_owner | admin |
|---|:-:|:-:|:-:|:-:|
| GET locations / experiences / businesses / reviews / search / availability | ✅ | ✅ | ✅ | ✅ |
| POST locations, bulk, experiences (extra) | | | | ✅ |
| POST business | | | ✅ (ownerId forced = self) | ✅ (any ownerId) |
| PATCH business | | | own only | ✅ |
| POST reviews | | ✅ | ✅ | ✅ (may set `userName`) |
| DELETE review | | own | own | ✅ |
| Itineraries CRUD | | own | own | own (+ read any) |
| POST booking | | ✅ (own) | ❌ | ✅ (for any customer) |
| GET bookings | | own | bookings of own listings | all (+filters) |
| GET booking by id | | own | if for own listing | ✅ |
| PAY booking | | own | | ✅ |
| Cancel booking | | own | for own listings (= "decline") | ✅ |
| Users list / get / create / bulk / delete | | self-get only | self-get only | ✅ |
| Analytics overview | | | | ✅ |
| Favorites | | own | own | own |

Return **404 (not 403)** for a booking/itinerary the caller isn't allowed to see (the FE does the same).

---

## 5. API reference

All paths are under `/api`. `Auth` = Bearer required.

### 5.1 Auth

| Method & path | Auth | Body → Response |
|---|---|---|
| `POST /auth/register/` | – | `{name,email,password,role:'tourist'\|'business_owner',businessName?,bankAccount?,mtnNumber?,airtelNumber?}` → **201** `{token,user}` |
| `POST /auth/login/` | – | `{email,password}` → `{token,user}` |
| `GET /auth/me/` | ✅ | → `User` (extra: lets the FE refresh its cached user) |
| `PATCH /auth/me/` | ✅ | **The FE sends the entire `User` object.** Whitelist: `name, phone, country, avatar, businessName, bankAccount, mtnNumber, airtelNumber, preferences`. Ignore `id, role, email, joinedAt`. → updated `User` |
| `POST /auth/password-reset/` | – | `{email}` → **204**. Always 204 (no account enumeration). Email a link `${FRONTEND_URL}/reset-password?token=<token>` |
| `POST /auth/password-reset/confirm/` | – | `{token,password}` → **204**. Token: 32 random bytes, store only a SHA-256 hash, 1 h expiry, single use. Bad/expired → 400 "This reset link is invalid or has expired." |

Rules:
- `role: 'admin'` on register → 403. Admins are created by seed or by another admin.
- Duplicate email → **409** `"An account with this email already exists. Log in instead."`
- Bad credentials → **401** `"That email and password don’t match. Check them and try again."` (same message for unknown email and wrong password).
- Password min length **6** (the FE's stated rule; make it a constant).
- Business-owner registration mirrors FE `payoutErrors()`: `businessName` ≥ 2 chars; `bankAccount` 10–20 digits; `mtnNumber` Rwandan mobile starting `078/079`; `airtelNumber` starting `072/073` (accept `+250 …`, `250…`, `0…`, spaces). Required on **public** register; optional when an admin creates the user.
- `User` responses never include `passwordHash`/reset fields. Payout fields (`bankAccount`, `mtnNumber`, `airtelNumber`) are included only for the user themself and admins.

### 5.2 Locations

| | Auth | |
|---|---|---|
| `GET /locations/` | – | `Location[]` |
| `GET /locations/:id/` | – | `Location` / 404 |
| `POST /locations/` | admin | `LocationInput` → **201** `Location` (`rating:0, reviewCount:0, visitsLastYear: input ?? 0`, slug id, `createdAt`) |
| `POST /locations/bulk/` | admin | `LocationInput[]` (≤ 1000) → `Location[]` (slug-id collision handling across the batch too) |

Validate: `name`, `district`, `province`, `shortDescription`, non-empty `image`; `category` ∈ City, National Park, Lake, Town, Cultural Site, Hidden Gem; `interests` ⊆ Nature, Culture, Adventure, Food, Wildlife, History, Relaxation; `priceLevel` ∈ 1..3; coordinates inside Rwanda (lat −3.0…−1.0, lng 28.8…31.0).
*Extra (cheap, recommended):* `PATCH/DELETE /locations/:id/` admin.

### 5.3 Experiences

`GET /experiences/`, `GET /experiences/:id/` public. *Extra:* admin `POST/PATCH/DELETE` so content isn't seed-only.

### 5.4 Businesses

| | Auth | |
|---|---|---|
| `GET /businesses/` | – | `Business[]`. Optional `?owner=<userId>` (FE: `getBusinessesByOwner`), `?category=`, `?locationId=` |
| `GET /businesses/:id/` | – | `Business` |
| `POST /businesses/` | owner/admin | `BusinessInput` (= Business minus `id, rating, reviewCount, createdAt`) → **201** `Business` |
| `PATCH /businesses/:id/` | owner(own)/admin | partial `Business`. FE sends `{services}` from "My services" and full input from the editor. Forbid changing `ownerId`(non-admin), `rating`, `reviewCount`, `createdAt`, `id`. |
| `POST /businesses/bulk/` | admin | `BusinessInput[]` (≤ 1000) → `Business[]`. FE already resolved `locationId` and `ownerId`/`ownerName`; verify they exist. |
| `GET /businesses/:id/payout/` | ✅ | `{ businessName, bankAccount?, mtnNumber?, airtelNumber? }` — the owner's payout accounts, so a paying customer can see where money goes (see §8.3, §15) |

Validate: `category` ∈ Tour Guides, Restaurants, Handcrafts, Local Products, Accommodation, Transportation, Community Tourism; `badges` ⊆ Eco-certified, Community-owned, Women-led, Plastic-free, Solar-powered; `propertyType` ∈ Hotel, Lodge, Guesthouse, House, Apartment (accommodation only); `priceLevel` 1..3; `locationId` exists and `district` is copied from it if blank; `ownerName` filled from owner user. Services: `priceRwf` int ≥ 0, `unit` non-empty string, `available` int ≥ 0 (optional), `capacity` int ≥ 1 (optional), `group` ∈ room, wellness, food, activity.
`listingKind` valid values: Hotel, Lodge, Guesthouse, House, Apartment, Restaurant, Bar, Coffee shop, Tour guide, Transportation, Handcraft, Local product, Community tourism, Wellness.

### 5.5 Reviews

| | Auth | |
|---|---|---|
| `GET /reviews/?targetId=&userId=` | – | `Review[]` newest first (`date` desc, then `_id`) |
| `POST /reviews/` | ✅ | `{targetId,targetType,targetName,rating,comment,userId,userName}` → **201** `Review` |
| `DELETE /reviews/:id/` | author/admin | **204** |

Rules: `rating` integer 1–5; `comment` trimmed, **10–1000 chars** (message: `"Write at least 10 characters so others can learn from your visit."`); target must exist (`targetName` is re-read from the DB). `userId`/`userName`/`userAvatar` come from the token — **ignore the body values**, except an admin may supply `userName` (FE "publish feedback collected offline"). `date` = today. After create/delete, **recompute the target's `rating` (mean, 1 decimal) and `reviewCount`** on the location/experience/business inside the same transaction. One review per user per target is *not* enforced by the FE; don't enforce it either (optionally log).

### 5.6 Itineraries

| | |
|---|---|
| `GET /itineraries/` | caller's itineraries, `updatedAt` desc |
| `GET /itineraries/:id/` | owner or admin |
| `POST /itineraries/` | `ItineraryInput` (= Itinerary minus `id, createdAt, updatedAt`) → **201**. `userId` forced = caller |
| `PUT /itineraries/:id/` | full replace by owner; bump `updatedAt` |
| `DELETE /itineraries/:id/` | owner → 204 |

Validate: `title` non-empty, `endDate >= startDate`, each stop `day ≥ 1`, `locationId` exists; refresh `locationName`/`image` from the DB. Stop `id`s are client-generated — keep.

### 5.7 Bookings — see §8 for the rules engine

| | Auth | |
|---|---|---|
| `GET /bookings/` | ✅ | Role-scoped list, `createdAt` desc. tourist → own. business_owner → bookings where `businessId`/`targetId` ∈ own listings. admin → all. Optional filters (admin, and owner for own ids): `?userId=`, `?businessIds=a,b,c`. Ignore the FE's `?scope=business` hint. |
| `GET /bookings/availability/` | – | **Public**, PII-free. Confirmed bookings only. `?businessId=` / `?targetId=` optional. Returns `{id,targetId,targetType,businessId?,serviceId?,serviceName?,lines,date,endDate?,nights?,units?,status}[]` (see §8.2) |
| `GET /bookings/:id/` | ✅ | `Booking` (404 if not allowed) |
| `POST /bookings/` | tourist/admin | `BookingInput & { payment? }` → **201** `Booking` |
| `POST /bookings/:id/pay/` | owner/admin | `Payment` → `Booking` (Confirmed) |
| `PATCH /bookings/:id/` | owner / listing owner / admin | `{status:'Canceled'}` → `Booking` |

### 5.8 Users (admin)

| | Auth | |
|---|---|---|
| `GET /users/` | admin | `User[]` newest `joinedAt` first |
| `GET /users/:id/` | self/admin | `User` |
| `POST /users/` | admin | `UserInput {name,email,role,phone?,country?,password?}` → **201** `User` |
| `POST /users/bulk/` | admin | `UserInput[]` ≤ 1000, **all-or-nothing**: any duplicate (existing or within the batch) → 409 `"An account with <email> already exists."` |
| `DELETE /users/:id/` | admin | **204**. Can't delete yourself (409). Their bookings/reviews stay (denormalized names). If they own listings, **unset `ownerId`** (FE tolerates missing owner) — don't delete listings. |

Default password when `password` omitted: env `DEFAULT_USER_PASSWORD` (FE hint says "password"). In production leave it unset → generate a random one and send a password-reset email.

### 5.9 Favorites (FE currently localStorage-only; "swap for /favorites/ API calls later")

`GET /favorites/` → `Favorite[]` (addedAt desc) · `POST /favorites/` `{itemId,itemType,title,subtitle,image,href}` (idempotent) → 201 `Favorite` · `DELETE /favorites/:itemId/` → 204.
Favorite `id` format used by the FE: `fav-<itemId>`.

### 5.10 Search

`GET /search/?q=&scope=all|accommodations|restaurants|businesses` → `SearchResult[]` — **businesses only** (`type:'business'`). Algorithm in §9.

### 5.11 Analytics

`GET /analytics/overview/` (admin) → `TourismStatistics`. See §10.

### 5.12 Uploads & misc

`POST /uploads/` (auth, multipart `file`) → `{ url }`; `GET /health` → `{status:'ok'}`; static `/media/*` (or S3/Cloudinary URLs). See §11.

---

## 6. Request validation highlights (mirror the FE)

- Email: `/^\S+@\S+\.\S+$/`. Name ≥ 2 chars. Phone ≥ 9 digits (booking form: "+250 788 000 000").
- Rwandan mobile: strip non-digits; remove leading `250` or `0`; must be 9 digits; `7[89]…` → MTN, `7[23]…` → Airtel (`src/utils/payment.ts#mobileNetwork`).
- Bank account: 10–20 digits.
- Card checks are FE-only (Luhn etc.) — the backend never receives a card number (FE sends only a masked `account`). Keep it that way: **reject any request containing a 13–19 digit PAN-looking string in `payment.account`** and never log payment bodies.
- Strip unknown fields (`zod.strict()` or `.strip()`), trim strings, cap lengths (names 120, descriptions 5 000, comment 1 000, arrays ≤ 50).

---

## 7. Seed data & dev experience

- `npm run seed` (idempotent upsert) and `npm run seed:reset` (drop + seed). Port **the arrays in `../Tourista-rwanda-fe/src/data/*.ts`** (locations, experiences, businesses, reviews, itineraries, users; images are Unsplash URLs in `images.ts`). Keep the original ids.
- Users: hash `password` for all seeded accounts. Demo logins that must work:
  `tourist@tourista.rw`, `business@tourista.rw`, `admin@tourista.rw` — all password `password`.
- Bookings: `src/data/bookings.ts` is a deterministic generator (seeded PRNG, relative to today). Reuse that logic (or equivalent) so dashboards have a year of Confirmed/Pending/Canceled data; every Confirmed one has a `Paid` payment, Canceled-after-paid has `Refunded`.
- After seeding, recompute `rating`/`reviewCount` from reviews is **not** required — seed values are authoritative until a new review arrives (then recompute from actual reviews for that target, as in §5.5). Consider recomputing for all targets at seed time for consistency; if you do, do it for everything.
- `docker-compose.yml`: `mongo:7` started with `--replSet rs0` + an init script (`rs.initiate()`), plus the API. `.env.example` (see §13).

---

## 8. Booking, pricing, availability and payment rules (the core logic)

**Port these frontend files verbatim into a shared, framework-free module (`src/domain/`) and unit-test them** — they are pure TS (only `todayIso` touches `Date`):
`src/utils/pricing.ts`, `src/utils/availability.ts`, and the `guidedVisitPrice` constant. Server code must call the *same* functions the FE uses so quotes agree to the franc.

### 8.1 Pricing

Pricing mode comes from `service.unit`:

| `unit` | mode | total |
|---|---|---|
| `per night` | `stay` | `price × nights × rooms` (nights = checkout − checkin; units = rooms) |
| `per day` | `rental` | `price × days × quantity` (days = end − start **+ 1**, inclusive) |
| `per person` | `perPerson` | `price × people` |
| anything else | `perUnit` | `price × quantity` |

Booking targets (`targetType`):
- `business` → services from the business document (`businessId = targetId`).
- `experience` → a single virtual service `{ id:'main', name: experience.title, priceRwf: experience.priceRwf, unit:'per person' }`.
- `location` → virtual `{ id:'guided', name:'Guided visit to <name>', unit:'per person', priceRwf: guidedVisitPrice(priceLevel) }` where guided fee = `[10000, 30000, 80000][priceLevel-1]`.

For each line the server recomputes `unitPriceRwf` (from DB), `lineTotalRwf` (via `quote()`), and `totalRwf = Σ lineTotalRwf`. **Ignore client prices.** If the client's `totalRwf` differs, respond **409** `"Prices changed while you were booking. Review the new total and try again."`. Reject a line whose total ≤ 0 (e.g. checkout ≤ checkin) with 422 `"Those dates do not cover a chargeable stay."`.

Validation: `date >= today` (also for admin: "Choose today or later"); stay needs `endDate > date`; rental needs `endDate >= date`; `people ≥ 1` (≤ 30); every `serviceId` belongs to the business; `units ≥ 1`. `nights` = periods charged (stay nights or rental days). For `perPerson` lines the line's `units` = `people`.

### 8.2 Availability (inventory)

- `service.available == null` → unlimited, never blocks.
- Only **`Confirmed`** bookings consume inventory (Pending requests don't block anyone).
- Occupied window of a confirmed booking: no `endDate` → `[date, date+1)`; stay → `[date, endDate)` (checkout morning is free); other ranged → `[date, endDate+1)`. Overlap = `start < otherEnd && otherStart < end`.
- Requested window (`requestWindow` in `bookingService.ts`): no endDate → `[date, date+1)`; stay → `[date, endDate)`; else `[date, endDate+1)`.
- `remaining = max(0, available − Σ units of overlapping confirmed lines for that serviceId)`. Violations → **409** `"Only N <service> left for those dates."` / `"<service> is already booked for those dates."`.
- Applies when a booking is created **with payment** and when a Pending booking is **paid**. Also re-validate `date >= today` on pay.
- `GET /bookings/availability/` exists because public pages (explore, business details, booking wizard) compute "what's still free" client-side with `utils/availability.ts` from the raw confirmed bookings. Return minimal fields, **no names/emails/phones/payment/notes/userId**. Always include `lines`.

### 8.3 Payment

FE flow: Step 3 shows `PaymentForm` → on success calls `POST /bookings/` with the booking **and** a `Payment` object, or `POST /bookings/:id/pay/` for an existing Pending booking. In v1 the FE payment is **simulated** (decline test card `4000 0000 0000 0002`, fake mobile-money approval). Implement a provider seam:

```ts
interface PaymentProvider {
  name: 'simulated' | 'flutterwave' | 'mtn_momo' | 'airtel_money' | string;
  charge(input: { amountRwf; method; account; reference; bookingId; payout }): Promise<{ status: 'Paid' | 'Failed'; providerRef: string }>;
  refund(payment): Promise<void>;
}
```
`PAYMENT_PROVIDER=simulated` (default): accept the client's `Payment` as the "authorization" but **override server-side**: `status='Paid'`, `amountRwf = booking.totalRwf` (reject mismatch 409), `reference = generated`, `paidAt = now`, `sentTo`/`sentToLabel` recomputed from the business owner's payout account for that method (`payout` = owner's `bankAccount` for card, `mtnNumber` for mtn, `airtelNumber` for airtel; `sentTo` = masked: bank → first 4 + ` •••• ` + last 4; mobile → `+250 XXX XXX XXX` formatted; `sentToLabel` = `"<businessName> · bank account | MTN Mobile Money | Airtel Money"`). If the owner has no account for that method → 422 `"<business> has not added a <method> yet. Choose another method."`. `method` ∈ `card|mtn|airtel`; for mtn/airtel, `account` network must match the method.
Real providers are a later phase (webhooks + idempotency keys + `PENDING_PAYMENT` state). Design the seam now; do not hard-code "Paid" outside the simulated provider. **Document in the README that simulated mode must not be used in production.**

### 8.4 Concurrency (important)

Two guests paying for the last room at once must not both succeed. Do the "check availability → insert/confirm" step inside a **MongoDB transaction** that also **writes to the business document** (e.g. `$inc: { bookingSeq: 1 }` on `businesses`). Mongo's snapshot isolation alone allows write-skew; the shared-document write forces a write conflict so one transaction retries/fails. Retry on `TransientTransactionError`. Add a test that fires N parallel bookings at `available: 1` and asserts exactly one Confirmed.

### 8.5 Status & cancellation

`Pending` (awaiting payment) → `Confirmed` (paid) → `Canceled`; `Pending` → `Canceled`. Rules:
- No payment ⇒ `Pending`; with payment ⇒ `Confirmed`. `PATCH` can only set `Canceled` (reject `Confirmed`/`Pending` with 422).
- Cancel allowed only if not already Canceled and `booking.date >= today` for tourists and business owners (admins may bypass). Canceling a paid booking sets `payment.status = 'Refunded'` and calls `provider.refund()`.
- Tourist may pay only own Pending, unpaid booking with `date >= today`.
- Business owner "decline" = same cancel (FE `BusinessBookingsPage` bulk-cancels).
- Send emails (nodemailer) on confirm (receipt: reference, lines, dates, total, paid-with, sent-to) and on cancel/refund; respect `preferences.bookingEmails !== false`.

### 8.6 Who the booking belongs to

Tourist: `userId` = token user (ignore body). `customerName/email/phone` from body (validated). Admin: `userId` from body must be an existing user; fill missing customer fields from that user; `notes` as given (FE sets "Booked by an admin"). Business owners cannot create bookings.

---

## 9. Search algorithm (port of `src/services/searchService.ts`)

Index = every business that **has availability today** (≥ 1 service where `remaining(service, confirmedBookings, today, tomorrow) > 0`; services without `available` count as open). Per business build:
- `kind = listingKind ?? propertyType ?? (first LISTING_KINDS entry for the category without propertyType)?.id ?? category` (`src/utils/catalog.ts#listingKindOf`).
- `scope`: Accommodation→`accommodations`, Restaurants→`restaurants`, else `businesses`.
- `haystack` = normalize(`name kind category district description ownerName badges… + for each open service "name category description" + location haystack`) where location haystack = `name district province shortDescription description category thingsToDo`.
- `normalize` = lowercase + NFD + strip diacritics.

Query: `terms = normalize(q).split(/\s+/)`; empty → `[]`. `placeHits` = locations whose haystack contains **every** term (with plural stripping: term ends with `s` and length > 3 → also try without the `s`). Filter by `scope` (`all` or equal; `businesses` accepts all businesses). For each candidate:
```
hits       = terms where haystack includes t (or singular form)
nearPlace  = some placeHit has id == b.locationId || district == b.district
serviceHit = some open service category/name includes some term
score = (hits == terms.length || nearPlace)
      ? (hits||1)*2 + (title.startsWith(terms[0]) ? 3 : title.includes(terms[0]) ? 2 : 0)
        + (serviceHit?2:0) + (nearPlace?1:0) + rating/5
      : 0
```
Drop score 0, sort desc, `limit 50`. Result: `{ id, type:'business', title:name, subtitle:"<kind> in <district>", image, href:"/businesses/<id>", rating, category:kind, description: serviceHit&&matchedName ? "Offers <name>. <description>" : description, priceLabel: open.length ? "From RWF 45,000" : undefined }`. Price formatting = `RWF ` + `Intl.NumberFormat('en-US')` (matches `formatRwf`).
Implement in application code (datasets are small); cache the index for ~30–60 s and invalidate on business/booking writes if convenient.

---

## 10. Analytics — `GET /analytics/overview/` (admin)

Returns `TourismStatistics`. Mirror the mock (`src/services/statisticsService.ts`), improved with live data:

- `totals`: `tourists` = `baseline.tourists` + count(users role=tourist created after seeding) — or simply baseline + live tourist count; `locations`, `businesses`, `reviews`, `itineraries`, `bookings` = **live counts** (+ baseline for itineraries/bookings, as the mock adds seed + live).
- `popularLocations`: top 8 locations by `visitsLastYear` → `{ name: name.replace(' National Park',' NP'), visits }`.
- `monthlyTrend`: last 12 months `{month:'Jan'…, domestic, international}`. Derive from bookings/itineraries by traveller `country` (`Rwanda` ⇒ domestic) and add the baseline monthly figures so the chart isn't empty on a young platform; if you only keep baseline, say so in the README.
- `userInterests`: % share of interests across locations in users' itineraries (rounded to sum ≈ 100); fall back to baseline when there are < 20 data points.
- `highTrafficLocations`: baseline (admin-editable) — `{name, visitsPerDay, capacity}[]`.
- `economicImpact`: `localRevenueRwf` = baseline + Σ paid-not-refunded booking totals; `jobsSupported`, `womenLedBusinesses` (= count businesses with badge `Women-led`, ≥ baseline), `communityProjects` (count of `Community-owned` or `Community Tourism`), `revenueByCategory[]` = paid booking revenue grouped by business category (+ baseline).
- *Extra:* `PUT /analytics/baseline/` (admin) to edit `tourism_baseline`.

The admin and business dashboards also compute many charts **client-side** from `GET /bookings/`, `/businesses/`, `/locations/`, `/reviews/` — those must return complete lists for their role.

---

## 11. Images

The FE's `ImageUpload` converts photos to JPEG data URLs (≤ 1280 px) and puts them **inside JSON fields** (`image`, `gallery[]`, `avatar`) on Location/Business/Experience/User. For v1 compatibility:

1. Accept `data:image/(jpeg|png|webp);base64,…` in those fields. A request middleware/normalizer (`persistImages`) decodes, **sniffs magic bytes**, re-encodes with `sharp` (max 1600 px, JPEG q80, strip EXIF), stores it (disk `./uploads` served at `/media`, or S3 via `STORAGE_DRIVER`), and **replaces the field with the public URL** before the DB write. `http(s)://` URLs pass through unchanged (seed uses Unsplash).
2. Otherwise list endpoints would balloon (FE fetches all businesses/locations at once) — never store base64 in Mongo.
3. Also provide `POST /uploads/` (multipart) → `{url}` for the cleaner path later. Limits: JPEG/PNG/WebP, ≤ 15 MB (matches FE copy), max 6 photos per listing.

---

## 12. Non-functional requirements

- **Security:** bcrypt cost ≥ 10; constant-time-ish login; rate-limit `/auth/login|register|password-reset` (e.g. 10/min/IP); helmet; CORS allow-list; request IDs; mask payout accounts in logs; no card data ever stored; `NODE_ENV=production` refuses `PAYMENT_PROVIDER=simulated` unless `ALLOW_SIMULATED_PAYMENTS=true`.
- **Authorization at the data layer:** every query that returns bookings/itineraries/favorites is scoped by the caller; don't rely on route guards alone.
- **Performance:** lean queries + indexes in §3; `Cache-Control: public, max-age=30` on public GET lists is fine.
- **Observability:** pino JSON logs, `/health`, graceful shutdown (close Mongo).
- **Time:** treat "today" in `Africa/Kigali`; all stored instants UTC ISO.
- **Docs:** README with run instructions, env table, endpoint table, demo accounts, the simulated-payments warning.

---

## 13. Environment variables (`.env.example`)

```
NODE_ENV=development
PORT=8000
MONGODB_URI=mongodb://localhost:27017/tourista?replicaSet=rs0
JWT_SECRET=change-me
JWT_EXPIRES_IN=7d
CORS_ORIGINS=http://localhost:5173
FRONTEND_URL=http://localhost:5173
DEFAULT_USER_PASSWORD=password        # dev only
PAYMENT_PROVIDER=simulated
ALLOW_SIMULATED_PAYMENTS=false         # must be true to use simulated when NODE_ENV=production
STORAGE_DRIVER=disk                    # disk | s3
UPLOAD_DIR=./uploads
PUBLIC_MEDIA_URL=http://localhost:8000/media
SMTP_URL=                              # empty → log emails to console
MAIL_FROM="Tourista Rwanda <no-reply@tourista.rw>"
```

---

## 14. Suggested layout & build order

```
tourista-be/
├─ src/
│  ├─ app.ts  server.ts  config.ts
│  ├─ db/ (connect.ts, seed/…)
│  ├─ models/        # user, location, experience, business, review, itinerary, booking, favorite, baseline
│  ├─ domain/        # pricing.ts, availability.ts (ported from FE), search.ts, payout.ts
│  ├─ modules/       # auth, users, locations, experiences, businesses, reviews, itineraries, bookings, favorites, search, analytics, uploads
│  │   └─ <name>.routes.ts / .controller.ts / .service.ts / .schema.ts (zod)
│  ├─ middleware/    # auth, requireRole, validate, error, rateLimit, persistImages
│  └─ providers/     # payment (simulated + interface), mail, storage
├─ test/ (unit + integration)
├─ docker-compose.yml  Dockerfile  .env.example  README.md
```

Build in this order; each milestone must have passing tests before moving on:

1. **Scaffold + infra** — TS, lint, error handler, config validation (zod), health, Mongo connect, docker-compose replica set.
2. **Auth & users** — models, register/login/me/PATCH me, password reset, admin user CRUD + bulk, role middleware.
3. **Catalog** — locations, experiences, businesses (+ payout, bulk, ownership rules), image persistence, **seed script**. At this point the FE explore/map/details pages should work with `VITE_USE_MOCK=false`.
4. **Domain port** — pricing + availability modules with unit tests copied/derived from FE logic (stay/rental/perPerson/perUnit, checkout-morning-free, overlap edges, `available == null`).
5. **Bookings** — create (paid/unpaid), pay, cancel/refund, availability endpoint, role-scoped list, transaction + concurrency test, emails.
6. **Reviews + rating recompute**, **itineraries**, **favorites**.
7. **Search**, **analytics**, baseline.
8. **Hardening** — rate limits, helmet, logging, README, OpenAPI (optional), final smoke run against the real FE.

### Acceptance checklist (definition of done)

- [ ] `npm run seed && npm run dev` starts the API on :8000; `GET /api/locations/` returns the 19 seeded locations.
- [ ] Logging in as each demo account works from the FE login page (and the one-click demo buttons).
- [ ] Tourist: book a room → pay (MTN/Airtel/card) → Confirmed; dates become unselectable for others; cancel → payment `Refunded`; unpaid booking can be paid later from "My bookings".
- [ ] Booking the last unit twice concurrently yields exactly one success and a clear 409 message.
- [ ] Business owner sees only bookings/reviews for own listings; cannot PATCH another owner's business; can edit services and prices (history keeps old line prices).
- [ ] Admin: users list/create/bulk-import/delete, locations & businesses bulk import (partial-valid rows handled by FE; endpoint is atomic per request), bookings for any customer, review create/delete, analytics page renders.
- [ ] Review create/delete updates target `rating` + `reviewCount`.
- [ ] Search "kinigi", "massage", "hotel musanze" return plausible businesses ordered by score.
- [ ] Tourist cannot read another tourist's booking/itinerary (404), cannot call admin routes (403).
- [ ] Uploading a base64 photo via business create stores a file and returns a URL; the Mongo document holds no base64.
- [ ] `tsc --noEmit`, lint, and tests pass; no secrets committed.

---

## 15. Known mismatches in the current FE (ask before changing; small edits)

These are places where the mock works but a real backend needs a slightly different call. Backend is designed so each fix is a few lines in `../Tourista-rwanda-fe/src/services/*`:

1. **`getBookings()` with no args is used by public pages** (`BookingPage`, `BusinessDetailsPage`, `BusinessesPage`, `ExploreBrowser`) to compute availability from *everyone's* bookings. With real auth that would be PII or 401. → add `getAvailability()` calling `GET /bookings/availability/` and use it on those pages. Admin pages keep `getBookings()`.
2. **`getBookings(filter)` maps to `/bookings/` or `/bookings/?scope=business`** and drops `businessIds`/`userId` for admin views. → send `?userId=` / `?businessIds=a,b` (backend supports both).
3. **`getPayoutForBusiness()` calls `GET /users/:id/`**, which is admin-only. → call `GET /businesses/:id/payout/`. The backend returns bank accounts pre-masked in the same `1234 •••• 5678` form `maskBank()` outputs (idempotent), and mobile numbers in full (customers must see the merchant number they pay).
4. **Favorites** are localStorage-only → optional `/favorites/` swap (§5.9).
5. **No 401 handling** in `apiClient.ts` → on `401` clear token/user and redirect to `/login`.
6. **README / `.env.example` mention Django** (`djangorestframework-simplejwt`, `django-cors-headers`) → update text; the endpoint paths are unchanged on purpose.
7. **Client-supplied `userId`/`userName` on reviews and bookings** are ignored by the backend; harmless to keep sending.
8. **Settings preferences** (notifications/language/currency) only live in component state; persisting via `PATCH /auth/me/ {preferences}` is supported by the backend if the FE wires it.

---

## 16. Out of scope for v1 (leave seams)

Real payment gateway integration & webhooks, refresh tokens / OAuth, review replies (Settings mentions "review replies"), owner-initiated booking edits, multi-currency conversion (UI has a USD/EUR selector, amounts stay RWF), i18n of API messages, push/SMS notifications, admin audit log.
