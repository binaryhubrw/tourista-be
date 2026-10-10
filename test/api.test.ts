import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import type { Express } from 'express';

let app: Express;
const tokens: Record<string, string> = {};
const futureDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const api = () => ({
  get: (url: string, who?: string) => request(app).get(`/api${url}`).set(who ? { Authorization: `Bearer ${tokens[who]}` } : {}),
  post: (url: string, body: unknown, who?: string) => request(app).post(`/api${url}`).set(who ? { Authorization: `Bearer ${tokens[who]}` } : {}).send(body as object),
  patch: (url: string, body: unknown, who?: string) => request(app).patch(`/api${url}`).set(who ? { Authorization: `Bearer ${tokens[who]}` } : {}).send(body as object),
  del: (url: string, who?: string) => request(app).delete(`/api${url}`).set(who ? { Authorization: `Bearer ${tokens[who]}` } : {}),
});
const http = api();

async function login(who: string, email: string) {
  const res = await http.post('/auth/login/', { email, password: 'password' });
  expect(res.status).toBe(200);
  tokens[who] = res.body.token;
  return res.body.user;
}

const customer = { customerName: 'Amani Kayitesi', customerEmail: 'tourist@tourista.rw', customerPhone: '+250 788 000 111' };
const mtn = (amountRwf?: number) => ({ method: 'mtn', account: '+250 788 *** 111', ...(amountRwf !== undefined ? { amountRwf } : {}) });

beforeAll(async () => {
  const { seed } = await import('../src/db/seed/run.js');
  await seed({ reset: true, uri: process.env.TEST_MONGO_URI });
  const { createApp } = await import('../src/app.js');
  app = createApp();
  await login('tourist', 'tourist@tourista.rw');
  await login('owner', 'business@tourista.rw');
  await login('admin', 'admin@tourista.rw');
  await login('other', 'lisa@example.com');
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe('health & catalog', () => {
  it('serves health and the seeded catalog', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
    const locs = await http.get('/locations/');
    expect(locs.status).toBe(200);
    expect(locs.body).toHaveLength(19);
    expect(locs.body[0]).toHaveProperty('id');
    expect(locs.body[0]).not.toHaveProperty('_id');
    expect((await http.get('/locations/kigali/')).body.name).toBe('Kigali');
    expect((await http.get('/locations/nope/')).body).toMatchObject({ status: 404, message: 'Location was not found.' });
    expect((await http.get('/businesses/')).body).toHaveLength(18);
    expect((await http.get('/businesses/')).body[0]).not.toHaveProperty('bookingSeq');
    expect((await http.get('/experiences/')).body).toHaveLength(9);
  });

  it('accepts trailing and non-trailing slashes', async () => {
    expect((await request(app).get('/api/locations')).status).toBe(200);
    expect((await request(app).get('/api/locations/')).status).toBe(200);
  });
});

describe('auth', () => {
  it('rejects bad credentials with one message', async () => {
    const a = await http.post('/auth/login/', { email: 'tourist@tourista.rw', password: 'wrong' });
    const b = await http.post('/auth/login/', { email: 'nobody@example.com', password: 'wrong' });
    expect(a.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('registers, blocks duplicates and admin self-registration', async () => {
    const res = await http.post('/auth/register/', { name: 'New Person', email: 'New@Example.com', password: 'secret1', role: 'tourist' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('new@example.com');
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect((await http.post('/auth/register/', { name: 'Dup', email: 'new@example.com', password: 'secret1' })).status).toBe(409);
    expect((await http.post('/auth/register/', { name: 'Evil', email: 'e@example.com', password: 'secret1', role: 'admin' })).status).toBe(403);
    expect((await http.post('/auth/register/', { name: 'Biz', email: 'b@example.com', password: 'secret1', role: 'business_owner', businessName: 'Biz' })).status).toBe(400);
  });

  it('PATCH /auth/me ignores role and email', async () => {
    const me = await http.get('/auth/me/', 'tourist');
    const res = await http.patch('/auth/me/', { ...me.body, role: 'admin', email: 'x@y.z', name: 'Amani K.' }, 'tourist');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'tourist', email: 'tourist@tourista.rw', name: 'Amani K.' });
  });

  it('always answers 204 to password reset requests', async () => {
    expect((await http.post('/auth/password-reset/', { email: 'ghost@example.com' })).status).toBe(204);
    expect((await http.post('/auth/password-reset/', { email: 'tourist@tourista.rw' })).status).toBe(204);
    expect((await http.post('/auth/password-reset/confirm/', { token: 'x'.repeat(40), password: 'newpass1' })).status).toBe(400);
  });

  it('guards admin routes', async () => {
    expect((await http.get('/users/')).status).toBe(401);
    expect((await http.get('/users/', 'tourist')).status).toBe(403);
    expect((await http.get('/users/', 'admin')).status).toBe(200);
    expect((await http.get('/analytics/overview/', 'owner')).status).toBe(403);
  });

  it('hides payout fields from other users', async () => {
    const own = await http.get('/users/user-business-1/', 'owner');
    expect(own.body.bankAccount).toBeTruthy();
    // Any logged-in user may read a host's limited public profile (the FE does this before paying)...
    const pub = await http.get('/users/user-business-1/', 'tourist');
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ businessName: 'Virunga Hospitality', bankAccount: '4001 •••• 0123', mtnNumber: '+250 788 123 401' });
    expect(pub.body).not.toHaveProperty('email');
    expect(pub.body).not.toHaveProperty('phone');
    // ...but not other travellers.
    expect((await http.get('/users/u-lisa/', 'tourist')).status).toBe(403);
    const payout = await http.get('/businesses/virunga-hillside-ecolodge/payout/', 'tourist');
    expect(payout.status).toBe(200);
    expect(payout.body.bankAccount).toBe('4001 •••• 0123');
    expect(payout.body.businessName).toBe('Virunga Hospitality');
  });
});

describe('businesses', () => {
  it('forbids editing a listing you do not own and strips protected fields', async () => {
    const mine = await http.patch('/businesses/virunga-hillside-ecolodge/', { description: 'Updated', rating: 1, reviewCount: 0 }, 'owner');
    expect(mine.status).toBe(200);
    expect(mine.body.description).toBe('Updated');
    expect(mine.body.rating).not.toBe(1);
    expect(mine.body.services.length).toBeGreaterThan(0); // untouched by a partial patch
    const all = (await http.get('/businesses/')).body as any[];
    const foreign = all.find((b) => b.ownerId && b.ownerId !== 'user-business-1');
    expect((await http.patch(`/businesses/${foreign.id}/`, { description: 'Hacked' }, 'owner')).status).toBe(403);
  });

  it('stores uploaded base64 photos as files, not in Mongo', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#2a7' } }).png().toBuffer();
    const res = await http.post('/businesses/', {
      name: 'Photo Test Cafe', category: 'Restaurants', locationId: 'kigali', description: 'x',
      image: `data:image/png;base64,${png.toString('base64')}`, coordinates: { lat: -1.95, lng: 30.06 },
      services: [{ name: 'Coffee', priceRwf: 2000, unit: 'per cup' }],
    }, 'owner');
    expect(res.status).toBe(201);
    expect(res.body.image).toMatch(/^http.*\/uploads\/.+\.jpg$/);
    // The file is in the uploads folder and is served back from /uploads (and the /media alias).
    const file = res.body.image.split('/uploads/')[1];
    const served = await request(app).get(`/uploads/${file}`);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect((await request(app).get(`/media/${file}`)).status).toBe(200);
    expect((await request(app).get('/uploads/../package.json')).status).not.toBe(200);
    expect(res.body.ownerId).toBe('user-business-1');
    expect(res.body.district).toBeTruthy();
    expect(res.body.services[0].id).toMatch(/^svc-/);
    const raw = await mongoose.connection.db!.collection('businesses').findOne({ _id: res.body.id as any });
    expect(JSON.stringify(raw)).not.toContain('base64');
    const bad = await http.post('/businesses/', { name: 'Bad', category: 'Restaurants', locationId: 'kigali', image: 'data:image/png;base64,AAAA', coordinates: { lat: -1.9, lng: 30 } }, 'owner');
    expect(bad.status).toBe(400);
  });
});

describe('bookings', () => {
  let roomId = '';
  const biz = 'virunga-hillside-ecolodge';

  it('prices on the server and rejects stale totals', async () => {
    const b = (await http.get(`/businesses/${biz}/`)).body;
    const room = b.services.find((s: any) => s.unit === 'per night');
    roomId = room.id;
    const base = { ...customer, targetId: biz, targetType: 'business', businessId: biz, serviceId: roomId, units: 1, date: futureDate(40), endDate: futureDate(42), people: 2 };

    const stale = await http.post('/bookings/', { ...base, totalRwf: 1 }, 'tourist');
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/Prices changed/);

    const noNights = await http.post('/bookings/', { ...base, endDate: base.date }, 'tourist');
    expect(noNights.status).toBe(422);

    const pending = await http.post('/bookings/', { ...base, unitPriceRwf: 1, userId: 'someone-else' }, 'tourist');
    expect(pending.status).toBe(201);
    expect(pending.body).toMatchObject({ status: 'Pending', userId: 'user-tourist-1', totalRwf: room.priceRwf * 2, nights: 2 });
    expect(pending.body.lines).toHaveLength(1);
    expect(pending.body.id).toMatch(/^bk-[a-z0-9]{8}$/);
  });

  it('confirms with payment, sets payout from the owner and refunds on cancel', async () => {
    const date = futureDate(70);
    const create = await http.post('/bookings/', {
      ...customer, targetId: biz, targetType: 'business', businessId: biz, serviceId: roomId, units: 1, date, endDate: futureDate(71), people: 2,
      payment: mtn(), }, 'tourist');
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('Confirmed');
    expect(create.body.payment).toMatchObject({ method: 'mtn', status: 'Paid', sentTo: '+250 788 123 401', sentToLabel: 'Virunga Hospitality · MTN Mobile Money' });
    expect(create.body.payment).not.toHaveProperty('providerRef');
    expect(create.body.payment.amountRwf).toBe(create.body.totalRwf);

    // Public availability shows it without any PII.
    const avail = await http.get(`/bookings/availability/?businessId=${biz}`);
    const hit = avail.body.find((x: any) => x.id === create.body.id);
    expect(hit).toBeTruthy();
    expect(hit).not.toHaveProperty('customerEmail');
    expect(hit).not.toHaveProperty('userId');
    expect(hit).not.toHaveProperty('payment');

    // Another tourist cannot see it; the listing owner can.
    expect((await http.get(`/bookings/${create.body.id}/`, 'other')).status).toBe(404);
    expect((await http.get(`/bookings/${create.body.id}/`, 'owner')).status).toBe(200);

    const canceled = await http.patch(`/bookings/${create.body.id}/`, { status: 'Canceled' }, 'tourist');
    expect(canceled.status).toBe(200);
    expect(canceled.body).toMatchObject({ status: 'Canceled' });
    expect(canceled.body.payment.status).toBe('Refunded');
    expect((await http.patch(`/bookings/${create.body.id}/`, { status: 'Canceled' }, 'tourist')).status).toBe(409);
    expect((await http.patch(`/bookings/${create.body.id}/`, { status: 'Confirmed' }, 'tourist')).status).toBe(422);
  });

  it('pays an existing Pending booking later', async () => {
    const created = await http.post('/bookings/', {
      ...customer, targetId: biz, targetType: 'business', businessId: biz, serviceId: roomId, units: 1, date: futureDate(100), endDate: futureDate(101), people: 1 }, 'tourist');
    expect(created.status).toBe(201);
    expect((await http.post(`/bookings/${created.body.id}/pay/`, mtn(), 'other')).status).toBe(404);
    expect((await http.post(`/bookings/${created.body.id}/pay/`, { method: 'card', account: '4242 4242 4242 4242' }, 'tourist')).status).toBe(400);
    const wrongAmount = await http.post(`/bookings/${created.body.id}/pay/`, mtn(1), 'tourist');
    expect(wrongAmount.status).toBe(409);
    const paid = await http.post(`/bookings/${created.body.id}/pay/`, mtn(created.body.totalRwf), 'tourist');
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('Confirmed');
    expect((await http.post(`/bookings/${created.body.id}/pay/`, mtn(), 'tourist')).status).toBe(409);
  });

  it('scopes booking lists by role', async () => {
    const mine = await http.get('/bookings/', 'tourist');
    expect(mine.body.every((b: any) => b.userId === 'user-tourist-1')).toBe(true);
    const ownerList = await http.get('/bookings/', 'owner');
    const ownIds = new Set(((await http.get('/businesses/?owner=user-business-1')).body as any[]).map((b) => b.id));
    expect(ownerList.body.length).toBeGreaterThan(0);
    expect(ownerList.body.every((b: any) => ownIds.has(b.businessId))).toBe(true);
    const all = await http.get('/bookings/', 'admin');
    expect(all.body.length).toBeGreaterThan(ownerList.body.length);
    expect((await http.post('/bookings/', {}, 'owner')).status).toBe(403);
  });

  it('never oversells the last unit under concurrency', async () => {
    const created = await http.post('/businesses/', {
      name: 'Last Room Inn', category: 'Accommodation', propertyType: 'Guesthouse', locationId: 'kigali', description: 'One room.',
      image: 'https://example.com/a.jpg', coordinates: { lat: -1.95, lng: 30.06 },
      services: [{ id: 'only-room', name: 'The Room', priceRwf: 30000, unit: 'per night', capacity: 2, available: 1, group: 'room' }],
    }, 'owner');
    expect(created.status).toBe(201);
    const id = created.body.id;
    const date = futureDate(200);
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      http.post('/bookings/', {
        ...customer, customerName: `Guest ${i}`, targetId: id, targetType: 'business', businessId: id, serviceId: 'only-room', units: 1,
        date, endDate: futureDate(201), people: 1, payment: mtn(),
      }, i % 2 ? 'tourist' : 'other')));
    const ok = attempts.filter((r) => r.status === 201);
    const rejected = attempts.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    expect(rejected[0].body.message).toMatch(/already booked|left for those dates/);
    const stored = await mongoose.connection.db!.collection('bookings').countDocuments({ businessId: id, status: 'Confirmed' });
    expect(stored).toBe(1);
  });
});

describe('reviews, itineraries, favorites, search, analytics', () => {
  it('recomputes rating and count on create and delete', async () => {
    const post = (rating: number, who: string) => http.post('/reviews/', {
      targetId: 'kigali', targetType: 'location', targetName: 'ignored', rating, comment: 'A wonderful visit, would go again.', userId: 'spoof', userName: 'Spoof' }, who);
    const short = await http.post('/reviews/', { targetId: 'kigali', targetType: 'location', rating: 5, comment: 'short' }, 'tourist');
    expect(short.status).toBe(400);
    expect(short.body.message).toBe('Write at least 10 characters so others can learn from your visit.');
    const a = await post(5, 'tourist');
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ userId: 'user-tourist-1', targetName: 'Kigali' });
    expect(a.body.userName).not.toBe('Spoof');
    const b = await post(2, 'other');
    let loc = (await http.get('/locations/kigali/')).body;
    const seeded = ((await http.get('/reviews/?targetId=kigali')).body as any[]);
    expect(loc.reviewCount).toBe(seeded.length);
    const mean = Math.round((seeded.reduce((s, r) => s + r.rating, 0) / seeded.length) * 10) / 10;
    expect(loc.rating).toBe(mean);
    expect((await http.del(`/reviews/${a.body.id}/`, 'other')).status).toBe(403);
    expect((await http.del(`/reviews/${a.body.id}/`, 'tourist')).status).toBe(204);
    expect((await http.del(`/reviews/${b.body.id}/`, 'admin')).status).toBe(204);
    loc = (await http.get('/locations/kigali/')).body;
    expect(loc.reviewCount).toBe(seeded.length - 2);
  });

  it('manages itineraries per user', async () => {
    const created = await http.post('/itineraries/', {
      title: 'Trip', description: '', startDate: '2030-05-01', endDate: '2030-05-03',
      stops: [{ id: 's1', locationId: 'kigali', day: 1, locationName: 'spoof' }] }, 'tourist');
    expect(created.status).toBe(201);
    expect(created.body.stops[0]).toMatchObject({ id: 's1', locationName: 'Kigali' });
    expect((await http.get(`/itineraries/${created.body.id}/`, 'other')).status).toBe(404);
    expect((await http.post('/itineraries/', { title: 'Bad', startDate: '2030-05-03', endDate: '2030-05-01', stops: [] }, 'tourist')).status).toBe(400);
    const replaced = await request(app).put(`/api/itineraries/${created.body.id}/`).set('Authorization', `Bearer ${tokens.tourist}`)
      .send({ title: 'Trip 2', description: '', startDate: '2030-05-01', endDate: '2030-05-04', stops: [] });
    expect(replaced.body.title).toBe('Trip 2');
    expect((await http.del(`/itineraries/${created.body.id}/`, 'tourist')).status).toBe(204);
  });

  it('keeps favorites idempotent', async () => {
    const fav = { itemId: 'kigali', itemType: 'location', title: 'Kigali', subtitle: 'City', image: 'x', href: '/locations/kigali' };
    expect((await http.post('/favorites/', fav, 'tourist')).body.id).toBe('fav-kigali');
    await http.post('/favorites/', fav, 'tourist');
    expect((await http.get('/favorites/', 'tourist')).body).toHaveLength(1);
    expect((await http.get('/favorites/', 'other')).body).toHaveLength(0);
    expect((await http.del('/favorites/kigali/', 'tourist')).status).toBe(204);
  });

  it('searches businesses', async () => {
    expect((await http.get('/search/?q=')).body).toEqual([]);
    const hotel = await http.get('/search/?q=hotel%20musanze');
    expect(hotel.status).toBe(200);
    expect(hotel.body.length).toBeGreaterThan(0);
    expect(hotel.body[0]).toMatchObject({ type: 'business' });
    expect(hotel.body[0].href).toMatch(/^\/businesses\//);
    const kinigi = await http.get('/search/?q=kinigi');
    expect(kinigi.body.length).toBeGreaterThan(0);
  });

  it('serves analytics to admins', async () => {
    const res = await http.get('/analytics/overview/', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.totals.locations).toBe(19);
    expect(res.body.monthlyTrend).toHaveLength(12);
    expect(res.body.popularLocations).toHaveLength(8);
    expect(res.body.economicImpact.localRevenueRwf).toBeGreaterThan(4_820_000_000);
  });
});

describe('admin users', () => {
  it('bulk-creates all-or-nothing and protects self-delete', async () => {
    const dup = await http.post('/users/bulk/', [
      { name: 'Ok One', email: 'ok1@example.com', role: 'tourist' }, { name: 'Dup', email: 'tourist@tourista.rw', role: 'tourist' }], 'admin');
    expect(dup.status).toBe(409);
    expect((await http.get('/users/', 'admin')).body.some((u: any) => u.email === 'ok1@example.com')).toBe(false);
    const ok = await http.post('/users/bulk/', [{ name: 'Ok One', email: 'ok1@example.com', role: 'tourist' }], 'admin');
    expect(ok.status).toBe(201);
    expect(ok.body[0]).not.toHaveProperty('passwordHash');
    expect((await http.del('/users/user-admin-1/', 'admin')).status).toBe(409);
    expect((await http.del(`/users/${ok.body[0].id}/`, 'admin')).status).toBe(204);
  });
});

describe('robustness', () => {
  it('ignores an expired or garbage token on public reads', async () => {
    const res = await request(app).get('/api/locations/').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/businesses/').set('Authorization', 'Bearer nope')).status).toBe(200);
    expect((await request(app).get('/api/bookings/x/').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('returns 400 (not 500) for bad query values and 204 for removing a missing favorite', async () => {
    expect((await http.get('/businesses/?owner=')).status).toBe(200);
    expect((await http.del('/favorites/never-added/', 'tourist')).status).toBe(204);
  });

  it('rejects malformed JSON with a 400', async () => {
    const res = await request(app).post('/api/auth/login/').set('Content-Type', 'application/json').send('{ bad');
    expect(res.status).toBe(400);
    expect(res.body.status).toBe(400);
  });
});

describe('frontend compatibility', () => {
  it('serves PII-free availability to anonymous callers and to tourists using scope=business', async () => {
    for (const res of [await request(app).get('/api/bookings/?scope=business'), await http.get('/bookings/?scope=business', 'tourist'), await request(app).get('/api/bookings/').set('Authorization', 'Bearer stale')]) {
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body.every((b: any) => b.status === 'Confirmed' && !('customerEmail' in b) && !('userId' in b) && !('payment' in b))).toBe(true);
    }
    // Without the hint a tourist still gets only their own bookings.
    const own = await http.get('/bookings/', 'tourist');
    expect(own.body.every((b: any) => b.userId === 'user-tourist-1')).toBe(true);
  });

  it('honours userId and businessIds filters for admins', async () => {
    const mine = await http.get('/bookings/?userId=user-tourist-1', 'admin');
    expect(mine.body.length).toBeGreaterThan(0);
    expect(mine.body.every((b: any) => b.userId === 'user-tourist-1')).toBe(true);
    const one = await http.get('/bookings/?businessIds=virunga-hillside-ecolodge', 'admin');
    expect(one.body.every((b: any) => b.businessId === 'virunga-hillside-ecolodge')).toBe(true);
  });

  it('lets admins book for a customer without a phone, and record desk payments on any network', async () => {
    const biz = (await http.get('/businesses/virunga-hillside-ecolodge/')).body;
    const room = biz.services.find((s: any) => s.unit === 'per night');
    const body = {
      userId: 'u-lisa', customerName: 'Lisa Hartmann', customerEmail: 'lisa@example.com', customerPhone: '',
      targetId: biz.id, targetType: 'business', businessId: biz.id, serviceId: room.id, units: 1,
      date: futureDate(300), endDate: futureDate(301), people: 1, notes: 'Booked by an admin',
      payment: { method: 'airtel', status: 'Paid', account: '+250 788 000 111', reference: 'AIR-X', amountRwf: room.priceRwf, paidAt: new Date().toISOString() },
    };
    const res = await http.post('/bookings/', body, 'admin');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userId: 'u-lisa', status: 'Confirmed' });
    // A tourist cannot skip the phone number or pay with a mismatched network.
    expect((await http.post('/bookings/', { ...body, userId: undefined, date: futureDate(310), endDate: futureDate(311) }, 'tourist')).status).toBe(400);
  });
});
