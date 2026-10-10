import { z } from 'zod';
import { registerSchema, patchSchema, loginSchema } from '../modules/auth.routes.js';
import { userInput } from '../modules/users.routes.js';
import { locationInput } from '../modules/locations.routes.js';
import { experienceInput } from '../modules/experiences.routes.js';
import { businessInput } from '../modules/businesses.routes.js';
import { reviewInput } from '../modules/reviews.routes.js';
import { itineraryInput } from '../modules/itineraries.routes.js';
import { favoriteInput } from '../modules/favorites.routes.js';
import { bookingInput, paymentInput } from '../modules/bookings.service.js';

type Json = Record<string, any>;

/** Request bodies are generated from the same zod schemas the server validates with, so docs cannot drift. */
const fromZod = (schema: z.ZodType): Json => {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'openapi-3.0' }) as Json;
  return rest;
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const arr = (items: Json) => ({ type: 'array', items });
const str = (extra: Json = {}) => ({ type: 'string', ...extra });
const num = (extra: Json = {}) => ({ type: 'number', ...extra });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const isoDate = str({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', example: '2026-11-12' });
const instant = str({ format: 'date-time' });

const schemas: Json = {
  Error: obj({
    message: str({ example: 'Booking was not found.' }),
    status: { type: 'integer', example: 404 },
    errors: arr(obj({ path: str(), message: str() })),
  }, ['message', 'status']),
  User: obj({
    id: str(), name: str(), email: str({ format: 'email' }), role: str({ enum: ['tourist', 'business_owner', 'admin'] }),
    avatar: str(), phone: str(), country: str(), joinedAt: str(), businessName: str(),
    bankAccount: str({ description: 'Only returned to the user themself and admins.' }),
    mtnNumber: str({ description: 'Only returned to the user themself and admins.' }),
    airtelNumber: str({ description: 'Only returned to the user themself and admins.' }),
    preferences: obj({ bookingEmails: { type: 'boolean' }, reviewReplies: { type: 'boolean' }, newsletter: { type: 'boolean' }, currency: str(), language: str() }),
  }, ['id', 'name', 'email', 'role', 'joinedAt']),
  AuthResult: obj({ token: str(), user: ref('User') }, ['token', 'user']),
  Coordinates: obj({ lat: num(), lng: num() }, ['lat', 'lng']),
  Location: obj({
    id: str({ example: 'volcanoes-national-park' }), name: str(), district: str(), province: str(),
    category: str({ enum: ['City', 'National Park', 'Lake', 'Town', 'Cultural Site', 'Hidden Gem'] }),
    interests: arr(str()), shortDescription: str(), description: str(), image: str(), gallery: arr(str()),
    rating: num(), reviewCount: { type: 'integer' }, coordinates: ref('Coordinates'), thingsToDo: arr(str()),
    sustainability: arr(str()), priceLevel: { type: 'integer', enum: [1, 2, 3] }, isHiddenGem: { type: 'boolean' },
    isPopular: { type: 'boolean' }, visitsLastYear: { type: 'integer' }, createdAt: str(),
  }),
  Experience: obj({
    id: str(), title: str(), type: str(), locationId: str(), locationName: str(), description: str(), image: str(),
    duration: str(), priceRwf: { type: 'integer' }, rating: num(), reviewCount: { type: 'integer' }, hostName: str(),
    interests: arr(str()), communityLed: { type: 'boolean' }, createdAt: str(),
  }),
  Service: obj({
    id: str(), name: str(), description: str(), priceRwf: { type: 'integer' },
    unit: str({ description: '`per night` (stay), `per day` (rental), `per person`, anything else is per unit.', example: 'per night' }),
    capacity: { type: 'integer' }, available: { type: 'integer', description: 'Omitted means unlimited.' },
    bedType: str(), amenities: arr(str()), group: str({ enum: ['room', 'wellness', 'food', 'activity'] }), category: str(),
  }, ['id', 'name', 'priceRwf', 'unit']),
  Business: obj({
    id: str({ example: 'virunga-hillside-ecolodge' }), name: str(), ownerName: str(), ownerId: str(),
    category: str({ enum: ['Tour Guides', 'Restaurants', 'Handcrafts', 'Local Products', 'Accommodation', 'Transportation', 'Community Tourism'] }),
    locationId: str(), district: str(), description: str(), image: str(), gallery: arr(str()), rating: num(),
    reviewCount: { type: 'integer' }, badges: arr(str()), phone: str(), email: str(), coordinates: ref('Coordinates'),
    services: arr(ref('Service')), priceLevel: { type: 'integer', enum: [1, 2, 3] }, listingKind: str(), propertyType: str(),
    roomTypes: arr(str()), ecoFeatures: arr(str()), cuisine: arr(str()), signatureDish: str(), createdAt: str(),
  }),
  Payout: obj({
    businessName: str(), bankAccount: str({ description: 'Masked, e.g. `4001 •••• 0123`.' }),
    mtnNumber: str(), airtelNumber: str(),
  }, ['businessName']),
  Review: obj({
    id: str(), targetId: str(), targetType: str({ enum: ['location', 'experience', 'business'] }), targetName: str(),
    userId: str(), userName: str(), userAvatar: str(), rating: { type: 'integer', minimum: 1, maximum: 5 }, comment: str(), date: isoDate,
  }),
  ItineraryStop: obj({ id: str(), locationId: str(), locationName: str(), image: str(), day: { type: 'integer' }, note: str() }),
  Itinerary: obj({
    id: str(), userId: str(), title: str(), description: str(), startDate: isoDate, endDate: isoDate,
    stops: arr(ref('ItineraryStop')), createdAt: instant, updatedAt: instant,
  }),
  BookingLine: obj({ serviceId: str(), serviceName: str(), units: { type: 'integer' }, unitPriceRwf: { type: 'integer' }, lineTotalRwf: { type: 'integer' } }),
  Payment: obj({
    method: str({ enum: ['card', 'mtn', 'airtel'] }), status: str({ enum: ['Paid', 'Refunded'] }),
    account: str({ description: 'Masked card or mobile number of the guest.' }), reference: str(), amountRwf: { type: 'integer' },
    paidAt: instant, sentTo: str({ description: 'Masked merchant account the money was sent to.' }), sentToLabel: str(),
  }),
  Booking: obj({
    id: str({ example: 'bk-k3j9x2ab' }), userId: str(), customerName: str(), customerEmail: str(), customerPhone: str(),
    targetId: str(), targetType: str({ enum: ['experience', 'business', 'location'] }), targetName: str(), businessId: str(),
    serviceId: str(), serviceName: str(), lines: arr(ref('BookingLine')), date: isoDate, endDate: isoDate,
    nights: { type: 'integer' }, units: { type: 'integer' }, unitPriceRwf: { type: 'integer' }, people: { type: 'integer' },
    totalRwf: { type: 'integer' }, payment: ref('Payment'), status: str({ enum: ['Pending', 'Confirmed', 'Canceled'] }),
    notes: str(), createdAt: instant,
  }),
  AvailabilityEntry: obj({
    id: str(), targetId: str(), targetType: str(), businessId: str(), serviceId: str(), serviceName: str(),
    lines: arr(ref('BookingLine')), date: isoDate, endDate: isoDate, nights: { type: 'integer' }, units: { type: 'integer' },
    status: str({ enum: ['Confirmed'] }),
  }),
  Favorite: obj({
    id: str({ example: 'fav-kigali' }), itemId: str(), itemType: str({ enum: ['location', 'experience', 'business'] }),
    title: str(), subtitle: str(), image: str(), href: str(), addedAt: instant,
  }),
  SearchResult: obj({
    id: str(), type: str({ enum: ['business'] }), title: str(), subtitle: str(), image: str(), href: str(),
    rating: num(), category: str(), description: str(), priceLabel: str({ example: 'From RWF 45,000' }),
  }),
  TourismStatistics: obj({
    totals: obj({ tourists: num(), locations: num(), businesses: num(), reviews: num(), itineraries: num(), bookings: num() }),
    monthlyTrend: arr(obj({ month: str(), domestic: num(), international: num() })),
    popularLocations: arr(obj({ name: str(), visits: num() })),
    userInterests: arr(obj({ name: str(), value: num() })),
    highTrafficLocations: arr(obj({ name: str(), visitsPerDay: num(), capacity: num() })),
    economicImpact: obj({
      localRevenueRwf: num(), jobsSupported: num(), womenLedBusinesses: num(), communityProjects: num(),
      revenueByCategory: arr(obj({ category: str(), revenueRwf: num() })),
    }),
  }),
  // Request bodies, generated from the server's own validation schemas.
  RegisterInput: fromZod(registerSchema),
  LoginInput: fromZod(loginSchema),
  ProfilePatch: fromZod(patchSchema),
  UserInput: fromZod(userInput),
  LocationInput: fromZod(locationInput),
  ExperienceInput: fromZod(experienceInput),
  BusinessInput: fromZod(businessInput),
  ReviewInput: fromZod(reviewInput),
  ItineraryInput: fromZod(itineraryInput),
  FavoriteInput: fromZod(favoriteInput),
  BookingInput: fromZod(bookingInput),
  PaymentInput: fromZod(paymentInput),
};

// ------------------------------------------------------------- helpers ----

const json = (schema: Json) => ({ 'application/json': { schema } });
const errorResponses: Record<string, string> = {
  400: 'Validation failed', 401: 'Not logged in or session expired', 403: 'Not allowed for this role', 404: 'Not found',
  409: 'Conflict (duplicate, sold out, or stale price)', 422: 'Rule violation (dates, ownership, missing payout account)',
};
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((c) => [String(c), { description: errorResponses[c], content: json(ref('Error')) }]));
const idParam = (name = 'id', description = 'Resource id') => ({ name, in: 'path', required: true, description, schema: str() });
const qParam = (name: string, description: string, schema: Json = str()) => ({ name, in: 'query', description, schema });

interface Op {
  tag: string;
  summary: string;
  description?: string;
  auth?: boolean;
  roles?: string;
  params?: Json[];
  body?: Json;
  ok?: [number, Json | null, string?];
  errs?: number[];
}

function op(o: Op): Json {
  const [code, schema, desc] = o.ok ?? [200, null];
  return {
    tags: [o.tag],
    summary: o.summary,
    description: [o.description, o.roles ? `**Access:** ${o.roles}` : undefined].filter(Boolean).join('\n\n') || undefined,
    ...(o.auth ? { security: [{ bearerAuth: [] }] } : {}),
    ...(o.params?.length ? { parameters: o.params } : {}),
    ...(o.body ? { requestBody: { required: true, content: json(o.body) } } : {}),
    responses: {
      [code]: { description: desc ?? (code === 204 ? 'No content' : 'Success'), ...(schema ? { content: json(schema) } : {}) },
      ...errors(...(o.errs ?? [])),
    },
  };
}

const list = (name: string) => arr(ref(name));
const paths: Json = {
  '/health': { get: op({ tag: 'System', summary: 'Health check', ok: [200, obj({ status: str({ example: 'ok' }) })] }) },

  '/auth/register/': { post: op({ tag: 'Auth', summary: 'Create a tourist or business-owner account',
    description: 'Business owners must supply `businessName`, a 10–20 digit `bankAccount`, an MTN (078/079) and an Airtel (072/073) number. Role `admin` is refused. Rate limited to 10/min/IP.',
    body: ref('RegisterInput'), ok: [201, ref('AuthResult')], errs: [400, 403, 409] }) },
  '/auth/login/': { post: op({ tag: 'Auth', summary: 'Log in', description: 'Unknown email and wrong password return the same 401 message. Rate limited.',
    body: ref('LoginInput'), ok: [200, ref('AuthResult')], errs: [400, 401] }) },
  '/auth/me/': {
    get: op({ tag: 'Auth', summary: 'Current user', auth: true, ok: [200, ref('User')], errs: [401] }),
    patch: op({ tag: 'Auth', summary: 'Update own profile',
      description: 'The whole `User` object may be sent; only name, phone, country, avatar, businessName, payout fields and preferences are applied. `id`, `role`, `email` and `joinedAt` are ignored.',
      auth: true, body: ref('ProfilePatch'), ok: [200, ref('User')], errs: [400, 401] }),
  },
  '/auth/password-reset/': { post: op({ tag: 'Auth', summary: 'Request a password-reset email',
    description: 'Always returns 204 so accounts cannot be enumerated.', body: obj({ email: str({ format: 'email' }) }, ['email']), ok: [204, null] }) },
  '/auth/password-reset/confirm/': { post: op({ tag: 'Auth', summary: 'Set a new password with a reset token',
    description: 'Tokens expire after 1 hour and work once.', body: obj({ token: str(), password: str({ minLength: 6 }) }, ['token', 'password']), ok: [204, null], errs: [400] }) },

  '/users/': {
    get: op({ tag: 'Users', summary: 'List users', auth: true, roles: 'admin', ok: [200, list('User')], errs: [401, 403] }),
    post: op({ tag: 'Users', summary: 'Create a user', description: 'Without `password` the `DEFAULT_USER_PASSWORD` is used (dev) or a reset email is sent.',
      auth: true, roles: 'admin', body: ref('UserInput'), ok: [201, ref('User')], errs: [400, 401, 403, 409] }),
  },
  '/users/bulk/': { post: op({ tag: 'Users', summary: 'Create many users (all-or-nothing)', description: 'Up to 1000 rows. Any duplicate email rejects the whole request.',
    auth: true, roles: 'admin', body: arr(ref('UserInput')), ok: [201, list('User')], errs: [400, 401, 403, 409] }) },
  '/users/{id}/': {
    get: op({ tag: 'Users', summary: 'Get a user', description: 'Any logged-in user may read a **business owner** as a limited public profile (name, business name, masked bank account, mobile-money numbers) so guests can see where a payment goes. Other users are visible only to themselves and admins.',
      auth: true, roles: 'the user themself or admin (full); any logged-in user (business owners, limited)', params: [idParam()], ok: [200, ref('User')], errs: [401, 403, 404] }),
    delete: op({ tag: 'Users', summary: 'Delete a user', description: 'Their listings stay but lose `ownerId`. You cannot delete yourself.',
      auth: true, roles: 'admin', params: [idParam()], ok: [204, null], errs: [401, 403, 404, 409] }),
  },

  '/locations/': {
    get: op({ tag: 'Locations', summary: 'List locations', ok: [200, list('Location')] }),
    post: op({ tag: 'Locations', summary: 'Create a location', description: 'The id is a slug of the name (`-2`, `-3` on collision). Photos may be base64 data URLs.',
      auth: true, roles: 'admin', body: ref('LocationInput'), ok: [201, ref('Location')], errs: [400, 401, 403] }),
  },
  '/locations/bulk/': { post: op({ tag: 'Locations', summary: 'Create many locations', description: 'Up to 1000 rows; atomic per request.',
    auth: true, roles: 'admin', body: arr(ref('LocationInput')), ok: [201, list('Location')], errs: [400, 401, 403] }) },
  '/locations/{id}/': {
    get: op({ tag: 'Locations', summary: 'Get a location', params: [idParam()], ok: [200, ref('Location')], errs: [404] }),
    patch: op({ tag: 'Locations', summary: 'Update a location', auth: true, roles: 'admin', params: [idParam()], body: ref('LocationInput'), ok: [200, ref('Location')], errs: [400, 401, 403, 404] }),
    delete: op({ tag: 'Locations', summary: 'Delete a location', auth: true, roles: 'admin', params: [idParam()], ok: [204, null], errs: [401, 403, 404] }),
  },

  '/experiences/': {
    get: op({ tag: 'Experiences', summary: 'List experiences', ok: [200, list('Experience')] }),
    post: op({ tag: 'Experiences', summary: 'Create an experience', auth: true, roles: 'admin', body: ref('ExperienceInput'), ok: [201, ref('Experience')], errs: [400, 401, 403, 422] }),
  },
  '/experiences/{id}/': {
    get: op({ tag: 'Experiences', summary: 'Get an experience', params: [idParam()], ok: [200, ref('Experience')], errs: [404] }),
    patch: op({ tag: 'Experiences', summary: 'Update an experience', auth: true, roles: 'admin', params: [idParam()], body: ref('ExperienceInput'), ok: [200, ref('Experience')], errs: [400, 401, 403, 404, 422] }),
    delete: op({ tag: 'Experiences', summary: 'Delete an experience', auth: true, roles: 'admin', params: [idParam()], ok: [204, null], errs: [401, 403, 404] }),
  },

  '/businesses/': {
    get: op({ tag: 'Businesses', summary: 'List businesses',
      params: [qParam('owner', 'Only listings owned by this user id'), qParam('category', 'Business category'), qParam('locationId', 'Location id')], ok: [200, list('Business')] }),
    post: op({ tag: 'Businesses', summary: 'Create a listing',
      description: 'Owners always own what they create; admins may pass `ownerId`. Service ids are generated when missing.',
      auth: true, roles: 'business_owner, admin', body: ref('BusinessInput'), ok: [201, ref('Business')], errs: [400, 401, 403, 422] }),
  },
  '/businesses/bulk/': { post: op({ tag: 'Businesses', summary: 'Create many listings', auth: true, roles: 'admin', body: arr(ref('BusinessInput')), ok: [201, list('Business')], errs: [400, 401, 403, 422] }) },
  '/businesses/{id}/': {
    get: op({ tag: 'Businesses', summary: 'Get a business', params: [idParam()], ok: [200, ref('Business')], errs: [404] }),
    patch: op({ tag: 'Businesses', summary: 'Update a listing', description: 'Partial. `rating`, `reviewCount`, `createdAt` and `id` cannot be changed; only admins may change `ownerId`.',
      auth: true, roles: 'the listing owner, or admin', params: [idParam()], body: ref('BusinessInput'), ok: [200, ref('Business')], errs: [400, 401, 403, 404, 422] }),
  },
  '/businesses/{id}/payout/': { get: op({ tag: 'Businesses', summary: 'Where a guest’s payment goes',
    description: 'Bank accounts are masked; mobile-money numbers are shown in full so guests can see the merchant.',
    auth: true, params: [idParam()], ok: [200, ref('Payout')], errs: [401, 404] }) },

  '/reviews/': {
    get: op({ tag: 'Reviews', summary: 'List reviews, newest first', params: [qParam('targetId', 'Review target id'), qParam('userId', 'Author id')], ok: [200, list('Review')] }),
    post: op({ tag: 'Reviews', summary: 'Write a review',
      description: 'Author comes from the token (admins may set `userName`). The target’s `rating` and `reviewCount` are recomputed from stored reviews.',
      auth: true, body: ref('ReviewInput'), ok: [201, ref('Review')], errs: [400, 401, 422] }),
  },
  '/reviews/{id}/': { delete: op({ tag: 'Reviews', summary: 'Delete a review', auth: true, roles: 'the author, or admin', params: [idParam()], ok: [204, null], errs: [401, 403, 404] }) },

  '/itineraries/': {
    get: op({ tag: 'Itineraries', summary: 'My itineraries, most recently updated first', auth: true, ok: [200, list('Itinerary')], errs: [401] }),
    post: op({ tag: 'Itineraries', summary: 'Create an itinerary', auth: true, body: ref('ItineraryInput'), ok: [201, ref('Itinerary')], errs: [400, 401, 422] }),
  },
  '/itineraries/{id}/': {
    get: op({ tag: 'Itineraries', summary: 'Get an itinerary', auth: true, roles: 'owner, or admin', params: [idParam()], ok: [200, ref('Itinerary')], errs: [401, 404] }),
    put: op({ tag: 'Itineraries', summary: 'Replace an itinerary', auth: true, roles: 'owner', params: [idParam()], body: ref('ItineraryInput'), ok: [200, ref('Itinerary')], errs: [400, 401, 404, 422] }),
    delete: op({ tag: 'Itineraries', summary: 'Delete an itinerary', auth: true, roles: 'owner', params: [idParam()], ok: [204, null], errs: [401, 404] }),
  },

  '/bookings/': {
    get: op({ tag: 'Bookings', summary: 'List bookings (scoped by role)',
      description: 'Tourists see their own; business owners see bookings for their listings; admins see all. **Anonymous callers, and tourists passing `scope=business`, receive the public availability list** (confirmed bookings without personal data) — this is what the frontend’s public pages request.',
      params: [qParam('userId', 'Filter by customer (admin, business owner)'), qParam('businessIds', 'Comma-separated business ids'), qParam('scope', 'Pass `business` to get the public availability list (tourists)')],
      ok: [200, { oneOf: [list('Booking'), list('AvailabilityEntry')] }], errs: [] }),
    post: op({ tag: 'Bookings', summary: 'Create a booking',
      description: 'Prices and totals are recomputed on the server. Without `payment` the booking is `Pending`; with it the booking is paid and `Confirmed` (availability is checked inside a transaction). A stale `totalRwf` returns 409.',
      auth: true, roles: 'tourist (own), admin (any customer)', body: ref('BookingInput'), ok: [201, ref('Booking')], errs: [400, 401, 403, 404, 409, 422] }),
  },
  '/bookings/availability/': { get: op({ tag: 'Bookings', summary: 'Confirmed bookings for availability calendars',
    description: 'Public and free of personal data (no names, contacts, payments or notes).',
    params: [qParam('businessId', 'Business id'), qParam('targetId', 'Target id')], ok: [200, list('AvailabilityEntry')] }) },
  '/bookings/{id}/': {
    get: op({ tag: 'Bookings', summary: 'Get a booking', description: 'Returns 404 (not 403) when the caller may not see it.',
      auth: true, roles: 'the guest, the listing owner, or admin', params: [idParam()], ok: [200, ref('Booking')], errs: [401, 404] }),
    patch: op({ tag: 'Bookings', summary: 'Cancel a booking',
      description: 'Only `{ "status": "Canceled" }` is accepted. Paying cancels refund the payment. Guests and owners cannot cancel past dates; admins can.',
      auth: true, roles: 'the guest, the listing owner (decline), or admin', params: [idParam()], body: obj({ status: str({ enum: ['Canceled'] }) }, ['status']),
      ok: [200, ref('Booking')], errs: [401, 404, 409, 422] }),
  },
  '/bookings/{id}/pay/': { post: op({ tag: 'Bookings', summary: 'Pay a pending booking',
    description: 'Sends only the masked account. Amount and recipient are set by the server.',
    auth: true, roles: 'the guest, or admin', params: [idParam()], body: ref('PaymentInput'), ok: [200, ref('Booking')], errs: [400, 401, 403, 404, 409, 422] }) },

  '/favorites/': {
    get: op({ tag: 'Favorites', summary: 'My favorites, newest first', auth: true, ok: [200, list('Favorite')], errs: [401] }),
    post: op({ tag: 'Favorites', summary: 'Add a favorite (idempotent)', auth: true, body: ref('FavoriteInput'), ok: [201, ref('Favorite')], errs: [400, 401] }),
  },
  '/favorites/{itemId}/': { delete: op({ tag: 'Favorites', summary: 'Remove a favorite (idempotent)', auth: true, params: [idParam('itemId', 'The favorited item id')], ok: [204, null], errs: [401] }) },

  '/search/': { get: op({ tag: 'Search', summary: 'Search businesses that have availability today',
    params: [qParam('q', 'Search text'), qParam('scope', 'Narrow the results', str({ enum: ['all', 'accommodations', 'restaurants', 'businesses'], default: 'all' }))],
    ok: [200, list('SearchResult')] }) },

  '/analytics/overview/': { get: op({ tag: 'Analytics', summary: 'Platform statistics', auth: true, roles: 'admin', ok: [200, ref('TourismStatistics')], errs: [401, 403] }) },
  '/analytics/baseline/': { put: op({ tag: 'Analytics', summary: 'Edit national baseline figures', description: 'Merged into the stored baseline; send only what changes.',
    auth: true, roles: 'admin', body: { type: 'object', additionalProperties: true }, ok: [200, ref('TourismStatistics')], errs: [400, 401, 403] }) },

  '/uploads/': { post: op({ tag: 'Uploads', summary: 'Upload a photo', description: 'JPEG, PNG or WebP up to 15 MB. Re-encoded to JPEG (≤1600 px, EXIF stripped).',
    auth: true, body: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] }, ok: [201, obj({ url: str() }, ['url'])], errs: [400, 401] }) },
};
// The upload body is multipart, not JSON.
paths['/uploads/'].post.requestBody.content = { 'multipart/form-data': { schema: paths['/uploads/'].post.requestBody.content['application/json'].schema } };

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Tourista Rwanda API',
    version: '1.0.0',
    description: [
      'Backend for the Tourista Rwanda tourism platform.',
      '',
      '**Auth:** call `POST /auth/login/`, copy the `token`, press **Authorize** and paste it (no `Bearer ` prefix).',
      'Demo accounts (password `password`): `tourist@tourista.rw`, `business@tourista.rw`, `admin@tourista.rw`.',
      '',
      '**Conventions:** JSON is camelCase; lists are bare arrays; dates are `YYYY-MM-DD`; money is whole RWF; errors are `{ message, status, errors? }`. Trailing slashes are optional.',
      '',
      '**Payments are simulated** unless a real provider is configured. Do not use in production.',
    ].join('\n'),
  },
  servers: [{ url: '/api', description: 'This server' }],
  tags: ['System', 'Auth', 'Users', 'Locations', 'Experiences', 'Businesses', 'Reviews', 'Itineraries', 'Bookings', 'Favorites', 'Search', 'Analytics', 'Uploads'].map((name) => ({ name })),
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas,
  },
  paths,
};
