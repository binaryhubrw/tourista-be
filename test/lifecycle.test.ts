import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import type { Express } from 'express';

let app: Express;
const tokens: Record<string, string> = {};
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let seq = 100;
/** A fresh date range per call so tests never compete for the same stock. */
const range = (nights = 1) => { seq += 7; return { date: day(seq), endDate: day(seq + nights) }; };

const as = (who?: string) => (who ? { Authorization: `Bearer ${tokens[who]}` } : {});
const http = {
  get: (url: string, who?: string) => request(app).get(`/api${url}`).set(as(who)),
  post: (url: string, body: unknown, who?: string) => request(app).post(`/api${url}`).set(as(who)).send(body as object),
  patch: (url: string, body: unknown, who?: string) => request(app).patch(`/api${url}`).set(as(who)).send(body as object),
  del: (url: string, who?: string) => request(app).delete(`/api${url}`).set(as(who)),
};

async function login(who: string, email: string, password = 'password') {
  const res = await http.post('/auth/login/', { email, password });
  expect(res.status).toBe(200);
  tokens[who] = res.body.token;
  return res.body.user;
}

const guest = { customerName: 'Amani Kayitesi', customerEmail: 'tourist@tourista.rw', customerPhone: '+250788000111' };
let hotelId = '';
let roomId = '';

async function newRequest(opts: { who?: string; nights?: number; units?: number } = {}) {
  const r = range(opts.nights ?? 1);
  const res = await http.post('/bookings/', {
    ...guest, targetId: hotelId, targetType: 'business', businessId: hotelId, serviceId: roomId, units: opts.units ?? 1, ...r, people: 2,
  }, opts.who ?? 'tourist');
  expect(res.status).toBe(201);
  return res.body;
}

async function approved(opts: Parameters<typeof newRequest>[0] = {}) {
  const b = await newRequest(opts);
  const res = await http.post(`/bookings/${b.id}/decision/`, { approve: true }, 'owner');
  expect(res.status).toBe(200);
  return res.body;
}

const transfer = (amountRwf?: number, extra: object = {}) => ({
  method: 'mtn', senderName: 'Amani Kayitesi', senderAccount: '+250 788 *** 111', screenshot: 'https://example.com/proof.jpg',
  ...(amountRwf !== undefined ? { amountRwf } : {}), ...extra,
});

beforeAll(async () => {
  const { seed } = await import('../src/db/seed/run.js');
  await seed({ reset: true, uri: process.env.TEST_MONGO_URI });
  app = (await import('../src/app.js')).createApp();
  await login('tourist', 'tourist@tourista.rw');
  await login('other', 'lisa@example.com');
  await login('owner', 'business@tourista.rw');
  await login('admin', 'admin@tourista.rw');
  // A rival owner, to prove hosts cannot touch each other's bookings.
  await login('rival', 'eric@kivubikes.rw');

  const created = await http.post('/businesses/', {
    name: 'Lifecycle Lodge', category: 'Accommodation', propertyType: 'Lodge', locationId: 'musanze', description: 'Test lodge.',
    image: 'https://example.com/lodge.jpg', coordinates: { lat: -1.5, lng: 29.6 },
    services: [{ id: 'room-a', name: 'Room A', priceRwf: 100_000, unit: 'per night', capacity: 2, available: 3, group: 'room' }],
  }, 'owner');
  expect(created.status).toBe(201);
  hotelId = created.body.id;
  roomId = 'room-a';
  expect((await http.post(`/businesses/${hotelId}/approve/`, {}, 'admin')).status).toBe(200);
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe('approval → transfer proof → confirmation', () => {
  it('walks a booking from request to confirmed with a partial then final transfer', async () => {
    const pending = await newRequest({ nights: 2 }); // total 200,000
    expect(pending).toMatchObject({ status: 'Pending', totalRwf: 200_000, ownerId: 'user-business-1' });

    // The host is told about the request.
    const hostInbox = (await http.get('/notifications/', 'owner')).body as any[];
    expect(hostInbox.some((n) => n.kind === 'booking' && n.href === `/business-dashboard/bookings/${pending.id}`)).toBe(true);

    // Only that listing's host can decide; a rival owner and the guest cannot.
    expect((await http.post(`/bookings/${pending.id}/decision/`, { approve: true }, 'rival')).status).toBe(404);
    expect((await http.post(`/bookings/${pending.id}/decision/`, { approve: true }, 'tourist')).status).toBe(403);

    const approvedRes = await http.post(`/bookings/${pending.id}/decision/`, { approve: true }, 'owner');
    expect(approvedRes.status).toBe(200);
    expect(approvedRes.body.status).toBe('AwaitingPayment');
    const due = new Date(approvedRes.body.paymentDueAt).getTime() - Date.now();
    expect(due).toBeGreaterThan(115 * 60_000);
    expect(due).toBeLessThanOrEqual(120 * 60_000);
    expect((await http.post(`/bookings/${pending.id}/decision/`, { approve: false }, 'owner')).status).toBe(409);

    // Less than 30% is refused, then 30% goes to review with the host's account filled in by the server.
    const tooLittle = await http.post(`/bookings/${pending.id}/pay/`, transfer(10_000), 'tourist');
    expect(tooLittle.status).toBe(422);
    expect(tooLittle.body.message).toMatch(/30%/);
    const first = await http.post(`/bookings/${pending.id}/pay/`, transfer(60_000, { sentTo: 'spoofed' }), 'tourist');
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('PaymentReview');
    expect(first.body.payment).toMatchObject({ status: 'Pending', ledger: 'pending', amountRwf: 60_000, minDueRwf: 60_000, feeRwf: 20_000 });
    expect(first.body.payment.transfers).toHaveLength(1);
    expect(first.body.payment.sentTo).toBe('+250 788 123 401');
    expect(first.body.payment.sentToLabel).toBe('Virunga Hospitality · MTN Mobile Money');

    // Guests and rivals cannot confirm; the host can.
    expect((await http.post(`/bookings/${pending.id}/confirm-payment/`, {}, 'tourist')).status).toBe(403);
    expect((await http.post(`/bookings/${pending.id}/confirm-payment/`, {}, 'rival')).status).toBe(404);
    const confirmed = await http.post(`/bookings/${pending.id}/confirm-payment/`, {}, 'owner');
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ status: 'Confirmed' });
    expect(confirmed.body.payment).toMatchObject({ status: 'Paid', ledger: 'approved' });
    expect(confirmed.body.payment.transfers.every((t: any) => t.status === 'Paid')).toBe(true);

    // The guest was told, and can send the rest.
    const guestInbox = (await http.get('/notifications/', 'tourist')).body as any[];
    expect(guestInbox.some((n) => n.title === 'Payment approved')).toBe(true);
    const over = await http.post(`/bookings/${pending.id}/pay/`, transfer(150_000), 'tourist');
    expect(over.status).toBe(422);
    const second = await http.post(`/bookings/${pending.id}/pay/`, transfer(140_000), 'tourist');
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('Confirmed');
    expect(second.body.payment).toMatchObject({ status: 'Pending', ledger: 'approved', amountRwf: 200_000 });
    expect(second.body.payment.transfers).toHaveLength(2);
    const final = await http.post(`/bookings/${pending.id}/confirm-payment/`, {}, 'owner');
    expect(final.body.payment.status).toBe('Paid');
    expect((await http.post(`/bookings/${pending.id}/pay/`, transfer(1), 'tourist')).status).toBe(409); // paid in full
  });

  it('declines with a reason and releases the stock', async () => {
    const b = await newRequest();
    const res = await http.post(`/bookings/${b.id}/decision/`, { approve: false, reason: 'Fully booked for a wedding.' }, 'owner');
    expect(res.body).toMatchObject({ status: 'Declined', declinedReason: 'Fully booked for a wedding.' });
    const avail = await http.get(`/bookings/availability/?businessId=${hotelId}`);
    expect(avail.body.some((x: any) => x.id === b.id)).toBe(false);
    const inbox = (await http.get('/notifications/', 'tourist')).body as any[];
    expect(inbox.some((n) => n.title === 'Host declined your booking' && /wedding/.test(n.body))).toBe(true);
  });

  it('expires an unpaid approval after the window and refuses late payment', async () => {
    const b = await approved();
    await mongoose.connection.db!.collection('bookings').updateOne({ _id: b.id as any }, { $set: { paymentDueAt: new Date(Date.now() - 60_000).toISOString() } });
    const late = await http.post(`/bookings/${b.id}/pay/`, transfer(), 'tourist');
    expect(late.status).toBe(409);
    expect(late.body.message).toMatch(/payment window/i);
    expect((await http.get(`/bookings/${b.id}/`, 'tourist')).body.status).toBe('Expired');
    const avail = await http.get(`/bookings/availability/?businessId=${hotelId}`);
    expect(avail.body.some((x: any) => x.id === b.id)).toBe(false);
  });

  it('holds stock for pending and approved requests', async () => {
    const r = range(1);
    const book = (units: number, who = 'tourist') => http.post('/bookings/', {
      ...guest, targetId: hotelId, targetType: 'business', businessId: hotelId, serviceId: roomId, units, ...r, people: 2 }, who);
    expect((await book(2)).status).toBe(201); // 3 rooms in total
    const clash = await book(2, 'other');
    expect(clash.status).toBe(409);
    expect(clash.body.message).toBe('Only 1 Room A left for those dates.');
    expect((await book(1, 'other')).status).toBe(201);
  });
});

describe('refunds', () => {
  async function paidBooking() {
    const b = await approved();
    await http.post(`/bookings/${b.id}/pay/`, transfer(), 'tourist');
    const c = await http.post(`/bookings/${b.id}/confirm-payment/`, {}, 'owner');
    expect(c.body.payment.status).toBe('Paid');
    return c.body;
  }
  const refundBody = (bookingId: string, extra: object = {}) => ({
    bookingId, reason: 'Plans changed', receiveMethod: 'mtn', receiveAccount: '+250 788 000 111', receiveName: 'Amani Kayitesi', ...extra,
  });

  it('runs request → admin approval → host return → refunded, and feeds the fee ledger', async () => {
    const b = await paidBooking();
    expect((await http.post('/refunds/', refundBody(b.id), 'other')).status).toBe(404);
    expect((await http.post('/refunds/', refundBody('bk-nope0000'), 'tourist')).status).toBe(404);
    const created = await http.post('/refunds/', refundBody(b.id, { amountRwf: 999_999_999 }), 'tourist');
    expect(created.status).toBe(422);

    const refund = await http.post('/refunds/', refundBody(b.id, { proof: 'https://example.com/p.jpg' }), 'tourist');
    expect(refund.status).toBe(201);
    expect(refund.body).toMatchObject({ status: 'admin_review', bookingId: b.id, amountRwf: b.payment.amountRwf });
    expect(refund.body.steps).toHaveLength(1);
    expect((await http.get(`/bookings/${b.id}/`, 'tourist')).body.status).toBe('RefundPending');
    expect((await http.post('/refunds/', refundBody(b.id), 'tourist')).status).toBe(409); // already in progress
    expect((await http.patch(`/bookings/${b.id}/`, { status: 'Canceled' }, 'owner')).status).toBe(409);

    // Visibility: the guest, the host and admin see it; another host does not.
    for (const who of ['tourist', 'owner', 'admin']) expect((await http.get(`/refunds/${refund.body.id}/`, who)).status).toBe(200);
    expect((await http.get(`/refunds/${refund.body.id}/`, 'rival')).status).toBe(404);
    expect((await http.get(`/refunds/${refund.body.id}/`, 'other')).status).toBe(404);
    expect((await http.get('/refunds/', 'admin')).body.some((r: any) => r.id === refund.body.id)).toBe(true);
    expect((await http.get('/refunds/', 'rival')).body.some((r: any) => r.id === refund.body.id)).toBe(false);

    // The host cannot complete before admin approves, and only admin can approve.
    const proof = { method: 'mtn', senderName: 'Claudine', senderAccount: '+250 788 123 401', proof: 'https://example.com/r.jpg' };
    expect((await http.post(`/refunds/${refund.body.id}/complete/`, proof, 'owner')).status).toBe(409);
    expect((await http.post(`/refunds/${refund.body.id}/approve/`, {}, 'owner')).status).toBe(403);
    const approvedRefund = await http.post(`/refunds/${refund.body.id}/approve/`, { note: 'Looks right.' }, 'admin');
    expect(approvedRefund.body.status).toBe('returning');
    expect((await http.post(`/refunds/${refund.body.id}/cancel/`, {}, 'tourist')).status).toBe(409);

    const done = await http.post(`/refunds/${refund.body.id}/complete/`, proof, 'owner');
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.returnTransfer).toMatchObject({ sentTo: '+250 788 000 111', sentToName: 'Amani Kayitesi' });
    expect(done.body.steps).toHaveLength(3);
    const after = await http.get(`/bookings/${b.id}/`, 'tourist');
    expect(after.body).toMatchObject({ status: 'Refunded' });
    expect(after.body.payment).toMatchObject({ status: 'Refunded', ledger: 'refunded' });

    const fees = await http.get('/fees/', 'admin');
    expect(fees.status).toBe(200);
    expect(fees.body.rate).toBe(0.1);
    expect(fees.body.wallet.some((w: any) => w.kind === 'out' && w.bookingId === b.id)).toBe(true);
    expect(fees.body.totals.balanceRwf).toBe(fees.body.totals.earnedRwf - fees.body.totals.reversedRwf);
    expect((await http.get('/fees/', 'owner')).status).toBe(403);
  });

  it('lets admin reject (booking returns to Confirmed) and the guest withdraw', async () => {
    const a = await paidBooking();
    const r1 = await http.post('/refunds/', refundBody(a.id), 'tourist');
    const rejected = await http.post(`/refunds/${r1.body.id}/reject/`, { note: 'Outside the policy.' }, 'admin');
    expect(rejected.body.status).toBe('rejected');
    expect((await http.get(`/bookings/${a.id}/`, 'tourist')).body.status).toBe('Confirmed');
    const guestInbox = (await http.get('/notifications/', 'tourist')).body as any[];
    expect(guestInbox.some((n) => n.title === 'Refund rejected')).toBe(true);

    const r2 = await http.post('/refunds/', refundBody(a.id), 'tourist'); // a new request is allowed after a closed one
    expect(r2.status).toBe(201);
    const withdrawn = await http.post(`/refunds/${r2.body.id}/cancel/`, {}, 'tourist');
    expect(withdrawn.body.status).toBe('canceled');
    expect((await http.get(`/bookings/${a.id}/`, 'tourist')).body.status).toBe('Confirmed');
  });

  it('only allows refunds on paid bookings', async () => {
    const b = await approved();
    const res = await http.post('/refunds/', refundBody(b.id), 'tourist');
    expect(res.status).toBe(422);
  });
});

describe('staff', () => {
  let branchB = '';
  let staffId = '';

  it('creates managers with one active manager per branch', async () => {
    const second = await http.post('/businesses/', {
      name: 'Lifecycle Annex', category: 'Accommodation', propertyType: 'Guesthouse', locationId: 'musanze', description: 'Second branch.',
      image: 'https://example.com/annex.jpg', coordinates: { lat: -1.5, lng: 29.6 },
      services: [{ id: 'annex-room', name: 'Annex Room', priceRwf: 40_000, unit: 'per night', available: 2, group: 'room' }],
    }, 'owner');
    branchB = second.body.id;
    await http.post(`/businesses/${branchB}/approve/`, {}, 'admin');

    const staff = { name: 'Alice Mukamana', email: 'Alice.M@virunga.rw', password: 'staff1234', phone: '+250 788 221 002', assignedListingIds: [hotelId] };
    expect((await http.post('/staff/', staff, 'tourist')).status).toBe(403);
    expect((await http.post('/staff/', { ...staff, password: '123' }, 'owner')).status).toBe(400);
    expect((await http.post('/staff/', { ...staff, assignedListingIds: ['biz-not-mine'] }, 'owner')).status).toBe(422);
    const created = await http.post('/staff/', staff, 'owner');
    expect(created.status).toBe(201);
    staffId = created.body.id;
    expect(created.body).toMatchObject({ role: 'staff', email: 'alice.m@virunga.rw', title: 'Manager', active: true, ownerId: 'user-business-1', assignedListingIds: [hotelId] });
    expect(created.body).not.toHaveProperty('passwordHash');
    expect(created.body).not.toHaveProperty('password');

    const clash = await http.post('/staff/', { ...staff, name: 'Eric N', email: 'eric.n@virunga.rw' }, 'owner');
    expect(clash.status).toBe(409);
    expect(clash.body.message).toBe('That branch already has a manager.');
    const sameEmail = await http.post('/staff/', { ...staff, assignedListingIds: [branchB] }, 'owner');
    expect(sameEmail.status).toBe(409);
    expect(sameEmail.body.message).toBe('A staff member already uses that email.');
    expect((await http.get('/staff/', 'owner')).body.map((s: any) => s.id)).toContain(staffId);
    expect((await http.get('/staff/', 'rival')).body.map((s: any) => s.id)).not.toContain(staffId);
  });

  it('logs in and acts only on assigned branches', async () => {
    const user = await login('staff', 'alice.m@virunga.rw', 'staff1234');
    expect(user).toMatchObject({ role: 'staff', ownerId: 'user-business-1', businessName: 'Virunga Hospitality' });
    expect((await http.get('/auth/me/', 'staff')).body.assignedListingIds).toEqual([hotelId]);

    const mine = await newRequest();
    const other = await http.post('/bookings/', {
      ...guest, targetId: 'virunga-hillside-ecolodge', targetType: 'business', businessId: 'virunga-hillside-ecolodge',
      serviceId: (await http.get('/businesses/virunga-hillside-ecolodge/')).body.services.find((s: any) => s.unit === 'per night').id,
      units: 1, ...range(1), people: 1,
    }, 'tourist');
    expect(other.status).toBe(201);

    const list = (await http.get('/bookings/', 'staff')).body as any[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((b) => b.businessId === hotelId)).toBe(true);
    expect(list.some((b) => b.id === mine.id)).toBe(true);
    expect((await http.get(`/bookings/${other.body.id}/`, 'staff')).status).toBe(404);
    expect((await http.post(`/bookings/${other.body.id}/decision/`, { approve: true }, 'staff')).status).toBe(404);
    expect((await http.post(`/bookings/${mine.id}/decision/`, { approve: true }, 'staff')).status).toBe(200);

    // Staff keep offerings up to date but cannot change anything else, add branches or manage the team.
    expect((await http.patch(`/businesses/${hotelId}/`, { description: 'x' }, 'staff')).status).toBe(403);
    const services = (await http.get(`/businesses/${hotelId}/`)).body.services;
    expect((await http.patch(`/businesses/${hotelId}/`, { services: services.map((s: any) => ({ ...s, available: 4 })) }, 'staff')).status).toBe(200);
    expect((await http.patch(`/businesses/${branchB}/`, { services: [] }, 'staff')).status).toBe(403);
    expect((await http.post('/businesses/', { name: 'No', category: 'Restaurants', locationId: 'kigali', image: 'x', coordinates: { lat: -1.9, lng: 30 } }, 'staff')).status).toBe(403);
    expect((await http.get('/staff/', 'staff')).status).toBe(403);
    expect((await http.post('/bookings/', { ...guest }, 'staff')).status).toBe(403);
  });

  it('deactivation blocks login and kills existing sessions at once', async () => {
    expect((await http.patch(`/staff/${staffId}/`, { active: false }, 'owner')).body.active).toBe(false);
    const login2 = await http.post('/auth/login/', { email: 'alice.m@virunga.rw', password: 'staff1234' });
    expect(login2.status).toBe(403);
    expect(login2.body.message).toBe('This staff account is deactivated. Ask the owner to activate it.');
    expect((await http.get('/auth/me/', 'staff')).status).toBe(401);
    expect((await http.patch(`/staff/${staffId}/`, { active: true, password: 'newpass99' }, 'owner')).body.active).toBe(true);
    expect((await http.post('/auth/login/', { email: 'alice.m@virunga.rw', password: 'newpass99' })).status).toBe(200);
    expect((await http.del(`/staff/${staffId}/`, 'rival')).status).toBe(404);
    expect((await http.del(`/staff/${staffId}/`, 'owner')).status).toBe(204);
  });
});

describe('vehicle fleets', () => {
  let hireId = '';
  const fleet = [{
    id: 'corolla', name: 'Toyota Corolla', description: 'Compact sedan', priceRwf: 60_000, unit: 'per day', group: 'vehicle', category: 'Regular',
    brand: 'Toyota', available: 2, capacity: 4,
    units: [{ plate: 'RAD 451 A', level: 'Regular' }, { plate: 'RAD 452 A', level: 'Regular' }],
  }];

  it('stores vehicles and rejects a plate used twice', async () => {
    const created = await http.post('/businesses/', {
      name: 'Kigali Wheels Test', category: 'Transportation', listingKind: 'Transportation', locationId: 'kigali', description: 'Car hire.',
      image: 'https://example.com/w.jpg', coordinates: { lat: -1.95, lng: 30.06 }, services: fleet,
    }, 'owner');
    expect(created.status).toBe(201);
    hireId = created.body.id;
    await http.post(`/businesses/${hireId}/approve/`, {}, 'admin');
    expect(created.body.services[0]).toMatchObject({ group: 'vehicle', brand: 'Toyota' });
    expect(created.body.services[0].units.map((u: any) => u.plate)).toEqual(['RAD 451 A', 'RAD 452 A']);

    const dup = await http.patch(`/businesses/${hireId}/`, {
      services: [...fleet, { ...fleet[0], id: 'prado', name: 'Prado', units: [{ plate: 'rad 451a' }] }] }, 'owner');
    expect(dup.status).toBe(409);
    expect(dup.body.message).toMatch(/already used in this fleet/);
  });

  it('assigns free plates per hire and refuses when the fleet is out', async () => {
    const r = { date: day(500), endDate: day(501) };
    const hire = (units: number, plateNumbers?: string[]) => http.post('/bookings/', {
      ...guest, targetId: hireId, targetType: 'business', businessId: hireId,
      lines: [{ serviceId: 'corolla', units, ...(plateNumbers ? { plateNumbers } : {}) }], ...r, people: 2,
    }, 'tourist');

    const a = await hire(1);
    expect(a.status).toBe(201);
    expect(a.body.lines[0].plateNumbers).toEqual(['RAD 451 A']);
    expect(a.body.totalRwf).toBe(120_000); // 2 days inclusive × 60,000

    // A client-chosen plate that is taken is ignored in favour of a free one.
    const b = await hire(1, ['RAD 451 A']);
    expect(b.status).toBe(201);
    expect(b.body.lines[0].plateNumbers).toEqual(['RAD 452 A']);

    const none = await hire(1);
    expect(none.status).toBe(409);

    // Plates show up in public availability so calendars can grey them out.
    const avail = await http.get(`/bookings/availability/?businessId=${hireId}`);
    expect(avail.body.find((x: any) => x.id === a.body.id).lines[0].plateNumbers).toEqual(['RAD 451 A']);

    // Canceling frees the plate again.
    await http.patch(`/bookings/${a.body.id}/`, { status: 'Canceled' }, 'tourist');
    const again = await hire(1);
    expect(again.body.lines[0].plateNumbers).toEqual(['RAD 451 A']);
  });
});

describe('notifications', () => {
  it('lists newest first, counts unread, and marks read', async () => {
    const list = (await http.get('/notifications/', 'owner')).body as any[];
    expect(list.length).toBeGreaterThan(0);
    expect([...list].map((n) => n.createdAt)).toEqual([...list].map((n) => n.createdAt).sort().reverse());
    const unread = (await http.get('/notifications/unread-count/', 'owner')).body.count;
    expect(unread).toBe(list.filter((n) => !n.readAt).length);

    const one = list.find((n) => !n.readAt)!;
    const read = await http.patch(`/notifications/${one.id}/read/`, {}, 'owner');
    expect(read.body.readAt).toBeTruthy();
    expect((await http.patch(`/notifications/${one.id}/read/`, {}, 'tourist')).status).toBe(404); // not theirs
    expect((await http.get('/notifications/unread-count/', 'owner')).body.count).toBe(unread - 1);

    expect((await http.post('/notifications/read-all/', {}, 'owner')).status).toBe(204);
    expect((await http.get('/notifications/unread-count/', 'owner')).body.count).toBe(0);
    expect((await http.get('/notifications/')).status).toBe(401);
  });

  it('tells hosts and admins about new reviews, and admins about new owners', async () => {
    await http.post('/reviews/', { targetId: hotelId, targetType: 'business', rating: 5, comment: 'Wonderful stay, would return.' }, 'tourist');
    const host = (await http.get('/notifications/', 'owner')).body as any[];
    expect(host.some((n) => n.kind === 'review' && n.href === '/business-dashboard/reviews')).toBe(true);

    await http.post('/auth/register/', {
      name: 'New Host', email: 'newhost@example.com', password: 'secret1', role: 'business_owner', businessName: 'New Host Co',
      bankAccount: '4001234567890000', mtnNumber: '0788111222', airtelNumber: '0733111222',
    });
    const admin = (await http.get('/notifications/', 'admin')).body as any[];
    expect(admin.some((n) => n.title === 'New business owner joined' && /New Host Co/.test(n.body))).toBe(true);
  });
});
