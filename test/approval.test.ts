import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import type { Express } from 'express';
import { clearRecentMail, flushMail, recentMail } from '../src/providers/mail.js';

let app: Express;
const tokens: Record<string, string> = {};
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const as = (who?: string) => (who ? { Authorization: `Bearer ${tokens[who]}` } : {});
const http = {
  get: (url: string, who?: string) => request(app).get(`/api${url}`).set(as(who)),
  post: (url: string, body: unknown, who?: string) => request(app).post(`/api${url}`).set(as(who)).send(body as object),
  patch: (url: string, body: unknown, who?: string) => request(app).patch(`/api${url}`).set(as(who)).send(body as object),
};
async function login(who: string, email: string) {
  const res = await http.post('/auth/login/', { email, password: 'password' });
  expect(res.status).toBe(200);
  tokens[who] = res.body.token;
}

const listing = (name: string, extra: object = {}) => ({
  name, category: 'Accommodation', propertyType: 'Guesthouse', locationId: 'musanze', description: `${name} is a quiet guesthouse.`,
  image: 'https://example.com/g.jpg', coordinates: { lat: -1.5, lng: 29.6 },
  services: [{ id: 'room-1', name: 'Quiet Room', priceRwf: 50_000, unit: 'per night', available: 2, group: 'room' }], ...extra,
});

beforeAll(async () => {
  const { seed } = await import('../src/db/seed/run.js');
  await seed({ reset: true, uri: process.env.TEST_MONGO_URI });
  app = (await import('../src/app.js')).createApp();
  await login('tourist', 'tourist@tourista.rw');
  await login('owner', 'business@tourista.rw');
  await login('rival', 'eric@kivubikes.rw');
  await login('admin', 'admin@tourista.rw');
});
beforeEach(async () => { await flushMail(); clearRecentMail(); });
afterAll(async () => { await mongoose.disconnect(); });

describe('listing approval', () => {
  let id = '';

  it('keeps an owner-created listing pending and hidden from everyone but owner and admin', async () => {
    const created = await http.post('/businesses/', listing('Zebra Guesthouse'), 'owner');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ approvalStatus: 'pending', ownerId: 'user-business-1' });
    id = created.body.id;

    const listed = async (who?: string, qs = '') => ((await http.get(`/businesses/${qs}`, who)).body as any[]).map((b) => b.id);
    expect(await listed()).not.toContain(id);                  // anonymous
    expect(await listed('tourist')).not.toContain(id);         // traveller
    expect(await listed('rival')).not.toContain(id);           // another owner
    expect(await listed('owner')).toContain(id);               // the owner sees their own
    expect(await listed('admin')).toContain(id);               // admin sees everything
    expect(await listed('owner', '?owner=user-business-1')).toContain(id);
    expect(await listed(undefined, '?owner=user-business-1')).not.toContain(id);

    expect((await http.get(`/businesses/${id}/`)).status).toBe(404);
    expect((await http.get(`/businesses/${id}/`, 'tourist')).status).toBe(404);
    expect((await http.get(`/businesses/${id}/`, 'rival')).status).toBe(404);
    expect((await http.get(`/businesses/${id}/`, 'owner')).body.approvalStatus).toBe('pending');
    expect((await http.get(`/businesses/${id}/`, 'admin')).status).toBe(200);
    expect((await http.get(`/businesses/${id}/payout/`, 'tourist')).status).toBe(404);
  });

  it('cannot be found, booked or reviewed while pending', async () => {
    const search = await http.get('/search/?q=zebra%20guesthouse');
    expect(search.body.some((r: any) => r.id === id)).toBe(false);

    const booking = await http.post('/bookings/', {
      customerName: 'Amani Kayitesi', customerEmail: 'tourist@tourista.rw', customerPhone: '+250788000111',
      targetId: id, targetType: 'business', businessId: id, serviceId: 'room-1', units: 1, date: day(60), endDate: day(61), people: 1,
    }, 'tourist');
    expect(booking.status).toBe(404);

    const review = await http.post('/reviews/', { targetId: id, targetType: 'business', rating: 5, comment: 'A really lovely place to stay.' }, 'tourist');
    expect(review.status).toBe(422);
  });

  it('tells admins about the submission, in the app and by email', async () => {
    const created = await http.post('/businesses/', listing('Notified Lodge'), 'owner');
    expect(created.status).toBe(201);
    const inbox = (await http.get('/notifications/', 'admin')).body as any[];
    expect(inbox.some((n) => n.title === 'Listing waiting for approval' && /Notified Lodge/.test(n.body) && n.href === `/admin/businesses/${created.body.id}`)).toBe(true);
    await flushMail();
    const mail = recentMail().find((m) => m.kind === 'listing.submitted')!;
    expect(mail.to).toContain('admin@tourista.rw');
    expect(mail.subject).toBe('Listing to review: Notified Lodge');
  });

  it('lets only admins list the queue and decide', async () => {
    const queue = await http.get('/businesses/?approvalStatus=pending', 'admin');
    expect(queue.body.length).toBeGreaterThan(0);
    expect(queue.body.every((b: any) => b.approvalStatus === 'pending')).toBe(true);
    expect(queue.body.some((b: any) => b.id === id)).toBe(true);

    expect((await http.post(`/businesses/${id}/approve/`, {}, 'owner')).status).toBe(403);
    expect((await http.post(`/businesses/${id}/approve/`, {})).status).toBe(401);
    expect((await http.post('/businesses/biz-nope/approve/', {}, 'admin')).status).toBe(404);
  });

  it('publishes on approval and notifies the owner', async () => {
    clearRecentMail();
    const approved = await http.post(`/businesses/${id}/approve/`, {}, 'admin');
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ approvalStatus: 'approved', reviewedBy: 'user-admin-1' });
    expect((await http.post(`/businesses/${id}/approve/`, {}, 'admin')).status).toBe(409);

    expect((await http.get(`/businesses/${id}/`)).status).toBe(200);
    expect(((await http.get('/businesses/')).body as any[]).some((b) => b.id === id)).toBe(true);
    expect((await http.get('/search/?q=zebra%20guesthouse')).body.some((r: any) => r.id === id)).toBe(true);
    expect((await http.get(`/businesses/${id}/payout/`, 'tourist')).status).toBe(200);

    const booking = await http.post('/bookings/', {
      customerName: 'Amani Kayitesi', customerEmail: 'tourist@tourista.rw', customerPhone: '+250788000111',
      targetId: id, targetType: 'business', businessId: id, serviceId: 'room-1', units: 1, date: day(70), endDate: day(71), people: 1,
    }, 'tourist');
    expect(booking.status).toBe(201);

    expect(((await http.get('/notifications/', 'owner')).body as any[]).some((n) => n.title === 'Your listing is live')).toBe(true);
    await flushMail();
    const mail = recentMail().find((m) => m.kind === 'listing.approved')!;
    expect(mail.to).toEqual(['business@tourista.rw']);
  });

  it('hides a listing again on rejection, shows the reason to the owner, and resubmits when edited', async () => {
    const created = await http.post('/businesses/', listing('Needs Work Inn'), 'owner');
    const rid = created.body.id;
    expect((await http.post(`/businesses/${rid}/reject/`, {}, 'admin')).status).toBe(400);            // reason required
    expect((await http.post(`/businesses/${rid}/reject/`, { reason: 'no' }, 'admin')).status).toBe(400);
    expect((await http.post(`/businesses/${rid}/reject/`, { reason: 'Add photos and a phone number.' }, 'owner')).status).toBe(403);

    clearRecentMail();
    const rejected = await http.post(`/businesses/${rid}/reject/`, { reason: 'Add photos and a phone number.' }, 'admin');
    expect(rejected.body).toMatchObject({ approvalStatus: 'rejected', rejectionReason: 'Add photos and a phone number.' });
    expect((await http.get(`/businesses/${rid}/`)).status).toBe(404);
    expect((await http.get(`/businesses/${rid}/`, 'owner')).body.rejectionReason).toBe('Add photos and a phone number.');
    await flushMail();
    const mail = recentMail().find((m) => m.kind === 'listing.rejected')!;
    expect(mail.text).toContain('Add photos and a phone number.');

    // The owner fixes it: it goes back into the queue without any extra step.
    clearRecentMail();
    const edited = await http.patch(`/businesses/${rid}/`, { phone: '+250788555000' }, 'owner');
    expect(edited.body).toMatchObject({ approvalStatus: 'pending', phone: '+250788555000' });
    expect(edited.body.rejectionReason).toBeUndefined();
    expect(((await http.get('/businesses/?approvalStatus=pending', 'admin')).body as any[]).some((b) => b.id === rid)).toBe(true);
    await flushMail();
    expect(recentMail().some((m) => m.kind === 'listing.submitted')).toBe(true);

    // A rejected listing can be approved later; an approved one can be suspended.
    expect((await http.post(`/businesses/${rid}/approve/`, {}, 'admin')).status).toBe(200);
    const suspended = await http.post(`/businesses/${rid}/reject/`, { reason: 'Reported for wrong pricing.' }, 'admin');
    expect(suspended.body.approvalStatus).toBe('rejected');
    expect((await http.get('/search/?q=needs%20work%20inn')).body.some((r: any) => r.id === rid)).toBe(false);
  });

  it('keeps editing an approved listing live, and sends admin-created listings to review', async () => {
    const edited = await http.patch(`/businesses/${id}/`, { description: 'Updated description.' }, 'owner');
    expect(edited.body.approvalStatus).toBe('approved');
    expect((await http.get(`/businesses/${id}/`)).status).toBe(200);

    const byAdmin = await http.post('/businesses/', listing('Admin Made Lodge', { ownerId: 'user-business-1' }), 'admin');
    expect(byAdmin.body.approvalStatus).toBe('pending');
    expect((await http.get(`/businesses/${byAdmin.body.id}/`)).status).toBe(404);
    expect((await http.get('/businesses/?approvalStatus=pending', 'admin')).body.some((b: any) => b.id === byAdmin.body.id)).toBe(true);

    const bulk = await http.post('/businesses/bulk/', [listing('Bulk One'), listing('Bulk Two')], 'admin');
    expect(bulk.body.every((b: any) => b.approvalStatus === 'pending')).toBe(true);
  });

  it('leaves the seeded catalogue public and reports pending approvals to admins', async () => {
    const all = (await http.get('/businesses/')).body as any[];
    expect(all.filter((b) => b.id === 'virunga-hillside-ecolodge')).toHaveLength(1);
    const stats = await http.get('/analytics/overview/', 'admin');
    expect(stats.body.pendingBusinesses).toBeGreaterThanOrEqual(1);
    expect(stats.body.totals.businesses).toBe(all.length);
  });
});
