import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { existsSync } from 'node:fs';
import type { Express } from 'express';
import { clearRecentMail, flushMail, mailStatus, recentMail, type SentRecord } from '../src/providers/mail.js';

let app: Express;
const tokens: Record<string, string> = {};
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let seq = 900;
const range = () => { seq += 5; return { date: day(seq), endDate: day(seq + 1) }; };
const as = (who?: string) => (who ? { Authorization: `Bearer ${tokens[who]}` } : {});
const http = {
  get: (url: string, who?: string) => request(app).get(`/api${url}`).set(as(who)),
  post: (url: string, body: unknown, who?: string) => request(app).post(`/api${url}`).set(as(who)).send(body as object),
  patch: (url: string, body: unknown, who?: string) => request(app).patch(`/api${url}`).set(as(who)).send(body as object),
};

async function login(who: string, email: string, password = 'password') {
  const res = await http.post('/auth/login/', { email, password });
  expect(res.status).toBe(200);
  tokens[who] = res.body.token;
}

/** Waits for the queue, then returns what was sent since the last clear. */
async function sent(kind?: string): Promise<SentRecord[]> {
  await flushMail();
  return recentMail().filter((m) => !kind || m.kind === kind);
}

const guest = { customerName: 'Amani Kayitesi', customerEmail: 'amani.guest@example.com', customerPhone: '+250788000111' };
let hotelId = '';
const transfer = (extra: object = {}) => ({ method: 'mtn', senderName: 'Amani Kayitesi', senderAccount: '+250 788 *** 111', ...extra });

async function request_(extra: object = {}) {
  const res = await http.post('/bookings/', {
    ...guest, targetId: hotelId, targetType: 'business', businessId: hotelId, serviceId: 'room-e', units: 1, ...range(), people: 2, ...extra,
  }, 'tourist');
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  const { seed } = await import('../src/db/seed/run.js');
  await seed({ reset: true, uri: process.env.TEST_MONGO_URI });
  app = (await import('../src/app.js')).createApp();
  await login('tourist', 'tourist@tourista.rw');
  await login('owner', 'business@tourista.rw');
  await login('admin', 'admin@tourista.rw');
  const created = await http.post('/businesses/', {
    name: 'Email Lodge', category: 'Accommodation', propertyType: 'Lodge', locationId: 'musanze', description: 'Mail test lodge.',
    image: 'https://example.com/e.jpg', coordinates: { lat: -1.5, lng: 29.6 }, phone: '+250788123401', email: 'frontdesk@emaillodge.rw',
    services: [{ id: 'room-e', name: 'Garden Room', priceRwf: 100_000, unit: 'per night', capacity: 2, available: 5, group: 'room' }],
  }, 'owner');
  expect(created.status).toBe(201);
  hotelId = created.body.id;
  expect((await http.post(`/businesses/${hotelId}/approve/`, {}, 'admin')).status).toBe(200);
});

beforeEach(async () => {
  await flushMail();
  clearRecentMail();
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe('mail transport', () => {
  it('reports its status to admins only and can send a test message', async () => {
    expect((await http.get('/mail/status/', 'tourist')).status).toBe(403);
    const status = await http.get('/mail/status/', 'admin');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ mode: 'json' });
    expect(JSON.stringify(status.body)).not.toMatch(/pass/i);

    const test = await http.post('/mail/test/', { to: 'ops@example.com' }, 'admin');
    expect(test.status).toBe(202);
    const [mail] = await sent('mail.test');
    expect(mail.to).toEqual(['ops@example.com']);
    expect(mail.html).toContain('Email is working');
    expect(mailStatus().sent).toBeGreaterThan(0);
  });
});

describe('booking emails', () => {
  it('emails the guest and the host when a request arrives', async () => {
    const b = await request_({ customerName: '<script>alert(1)</script> Amani' });
    const mails = await sent();
    const ack = mails.find((m) => m.kind === 'booking.requested')!;
    const hostMail = mails.find((m) => m.kind === 'booking.requested.host')!;
    expect(ack.to).toEqual(['amani.guest@example.com']);
    expect(ack.subject).toContain(b.id.toUpperCase());
    expect(hostMail.to).toContain('business@tourista.rw');
    expect(hostMail.subject).toMatch(/New booking request: Email Lodge/);
    // User-supplied text is escaped in HTML and never rendered as markup.
    expect(hostMail.html).not.toContain('<script>');
    expect(hostMail.html).toContain('&lt;script&gt;');
    // Both versions exist, and the plain text carries the facts.
    expect(ack.text).toContain('Reference');
    expect(ack.html).toContain('View your booking');
  });

  it('tells an approved guest how and when to pay', async () => {
    const b = await request_();
    clearRecentMail();
    await http.post(`/bookings/${b.id}/decision/`, { approve: true }, 'owner');
    const [mail] = await sent('booking.approved');
    expect(mail.to).toEqual(['amani.guest@example.com']);
    expect(mail.text).toMatch(/Minimum to confirm: RWF 30,000/);
    expect(mail.text).toContain('+250 788 123 401');       // the host's MTN number, so the guest can pay
    expect(mail.text).toMatch(/Pay before/);
  });

  it('sends the declined reason', async () => {
    const b = await request_();
    clearRecentMail();
    await http.post(`/bookings/${b.id}/decision/`, { approve: false, reason: 'Closed for renovation.' }, 'owner');
    const [mail] = await sent('booking.declined');
    expect(mail.text).toContain('Closed for renovation.');
  });

  it('sends payment proof to the host with the screenshot, and a receipt with an invoice to the guest', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#0a5' } }).png().toBuffer();
    const up = await request(app).post('/api/uploads/').set(as('tourist')).attach('file', png, { filename: 'proof.png', contentType: 'image/png' });
    expect(up.status).toBe(201);

    const b = await request_();
    await http.post(`/bookings/${b.id}/decision/`, { approve: true }, 'owner');
    clearRecentMail();
    const paid = await http.post(`/bookings/${b.id}/pay/`, transfer({ amountRwf: 60_000, screenshot: up.body.url }), 'tourist');
    expect(paid.status).toBe(200);

    const mails = await sent();
    const receipt = mails.find((m) => m.kind === 'payment.proof')!;
    const hostMail = mails.find((m) => m.kind === 'payment.proof.host')!;
    expect(receipt.to).toEqual(['amani.guest@example.com']);
    expect(receipt.attachments.map((a) => a.filename)).toEqual([`INV-${b.id.toUpperCase()}.pdf`, `RCT-${b.id.toUpperCase()}.pdf`]);
    expect(receipt.attachments[0].contentType).toBe('application/pdf');
    expect(receipt.attachments[0].size).toBeGreaterThan(1500);

    expect(hostMail.to).toContain('business@tourista.rw');
    expect(hostMail.attachments.map((a) => a.filename)).toEqual(expect.arrayContaining([`INV-${b.id.toUpperCase()}.pdf`, `RCT-${b.id.toUpperCase()}.pdf`, `payment-proof-${b.id.toUpperCase()}.jpg`]));
    const shot = hostMail.attachments.find((a) => a.path)!;
    expect(existsSync(shot.path!)).toBe(true);
    expect(hostMail.text).toMatch(/Amount sent: RWF 60,000/);
  });

  it('emails the invoice when the host confirms, even if the guest turned booking emails off', async () => {
    // The tourist account turns off booking emails; invoices are still sent.
    await http.patch('/auth/me/', { preferences: { bookingEmails: false } }, 'tourist');
    const b = await request_();
    await http.post(`/bookings/${b.id}/decision/`, { approve: true }, 'owner');
    await http.post(`/bookings/${b.id}/pay/`, transfer({ amountRwf: 60_000 }), 'tourist');
    clearRecentMail();
    const confirmed = await http.post(`/bookings/${b.id}/confirm-payment/`, {}, 'owner');
    expect(confirmed.status).toBe(200);

    const mails = await sent();
    const invoice = mails.find((m) => m.kind === 'payment.confirmed')!;
    expect(invoice.to).toEqual(['amani.guest@example.com']);
    expect(invoice.subject).toMatch(/Payment received/);
    expect(invoice.text).toMatch(/Balance due: RWF 40,000/);
    expect(invoice.attachments[0].filename).toBe(`INV-${b.id.toUpperCase()}.pdf`);
    expect(invoice.attachments.map((a) => a.filename)).toContain(`RCT-${b.id.toUpperCase()}.pdf`);
    expect(mails.some((m) => m.kind === 'payment.confirmed.host')).toBe(true);

    await http.patch('/auth/me/', { preferences: { bookingEmails: true } }, 'tourist');
  });

  it('suppresses informational emails when the guest turned them off', async () => {
    await http.patch('/auth/me/', { preferences: { bookingEmails: false } }, 'tourist');
    clearRecentMail();
    const b = await request_();
    await http.post(`/bookings/${b.id}/decision/`, { approve: true }, 'owner');
    const mails = await sent();
    expect(mails.some((m) => m.kind === 'booking.requested')).toBe(false); // guest ack suppressed
    expect(mails.some((m) => m.kind === 'booking.approved')).toBe(false);
    expect(mails.some((m) => m.kind === 'booking.requested.host')).toBe(true); // host still hears about it
    await http.patch('/auth/me/', { preferences: { bookingEmails: true } }, 'tourist');
  });

  it('emails the other party on cancellation', async () => {
    const b = await request_();
    clearRecentMail();
    await http.patch(`/bookings/${b.id}/`, { status: 'Canceled' }, 'tourist');
    const [mail] = await sent('booking.canceled.host');
    expect(mail.to).toContain('business@tourista.rw');
    clearRecentMail();
    const b2 = await request_();
    clearRecentMail();
    await http.patch(`/bookings/${b2.id}/`, { status: 'Canceled' }, 'owner');
    const [guestMail] = await sent('booking.canceled');
    expect(guestMail.to).toEqual(['amani.guest@example.com']);
  });

  it('sends one reminder before the window closes, then an expiry notice', async () => {
    const { sendPaymentReminders, expireStaleBookings } = await import('../src/modules/bookings.service.js');
    const b = await request_();
    await http.post(`/bookings/${b.id}/decision/`, { approve: true }, 'owner');
    const col = mongoose.connection.db!.collection('bookings');
    await col.updateOne({ _id: b.id as any }, { $set: { paymentDueAt: new Date(Date.now() + 10 * 60_000).toISOString() } });
    clearRecentMail();

    expect(await sendPaymentReminders()).toBeGreaterThanOrEqual(1);
    expect((await sent('booking.reminder')).filter((m) => m.subject.includes(b.id.toUpperCase()))).toHaveLength(1);
    clearRecentMail();
    await sendPaymentReminders();
    expect((await sent('booking.reminder')).filter((m) => m.subject.includes(b.id.toUpperCase()))).toHaveLength(0); // not twice

    await col.updateOne({ _id: b.id as any }, { $set: { paymentDueAt: new Date(Date.now() - 1000).toISOString() } });
    clearRecentMail();
    await expireStaleBookings();
    const expired = (await sent('booking.expired')).filter((m) => m.subject.includes(b.id.toUpperCase()));
    expect(expired).toHaveLength(1);
  });
});

describe('invoices', () => {
  it('serves a PDF to people on the booking and refuses everyone else', async () => {
    const b = await request_();
    expect((await http.get(`/bookings/${b.id}/invoice/`, 'tourist')).status).toBe(409); // nothing paid yet
    await http.post(`/bookings/${b.id}/decision/`, { approve: true }, 'owner');
    await http.post(`/bookings/${b.id}/pay/`, transfer({ amountRwf: 60_000 }), 'tourist');

    const pdf = await request(app).get(`/api/bookings/${b.id}/invoice/`).set(as('tourist')).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(`INV-${b.id.toUpperCase()}.pdf`);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    expect((await http.get(`/bookings/${b.id}/invoice/`, 'owner')).status).toBe(200);
    expect((await http.get(`/bookings/${b.id}/invoice/`, 'admin')).status).toBe(200);
    expect((await http.get(`/bookings/${b.id}/invoice/`)).status).toBe(401);
  });

  it('re-emails the invoice and receipt to the traveller and the host, limited to once a minute', async () => {
    const b = await request_();
    await http.post(`/bookings/${b.id}/decision/`, { approve: true }, 'owner');
    await http.post(`/bookings/${b.id}/pay/`, transfer({ amountRwf: 60_000 }), 'tourist');
    clearRecentMail();
    const first = await http.post(`/bookings/${b.id}/invoice/send/`, {}, 'tourist');
    expect(first.status).toBe(202);
    expect(first.body.sentTo).toContain('amani.guest@example.com');
    expect(first.body.sentTo).toContain('business@tourista.rw');
    const [mail] = await sent('invoice.resend');
    expect(mail.attachments[0].contentType).toBe('application/pdf');
    expect(mail.attachments.map((a) => a.filename)).toEqual([`INV-${b.id.toUpperCase()}.pdf`, `RCT-${b.id.toUpperCase()}.pdf`]);
    expect((await http.post(`/bookings/${b.id}/invoice/send/`, {}, 'tourist')).status).toBe(429);
  });
});

describe('receipts', () => {
  it('serves a receipt PDF to people on the booking and refuses everyone else', async () => {
    const b = await request_();
    expect((await http.get(`/bookings/${b.id}/receipt/`, 'tourist')).status).toBe(409); // nothing paid yet
    await http.post(`/bookings/${b.id}/decision/`, { approve: true }, 'owner');
    await http.post(`/bookings/${b.id}/pay/`, transfer({ amountRwf: 60_000 }), 'tourist');

    const pdf = await request(app).get(`/api/bookings/${b.id}/receipt/`).set(as('tourist')).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(`RCT-${b.id.toUpperCase()}.pdf`);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    expect((await http.get(`/bookings/${b.id}/receipt/`, 'owner')).status).toBe(200);
    expect((await http.get(`/bookings/${b.id}/receipt/`, 'admin')).status).toBe(200);
    expect((await http.get(`/bookings/${b.id}/receipt/`)).status).toBe(401);
  });

  it('re-emails the receipt, limited to once a minute', async () => {
    const b = await request_();
    await http.post(`/bookings/${b.id}/decision/`, { approve: true }, 'owner');
    await http.post(`/bookings/${b.id}/pay/`, transfer({ amountRwf: 60_000 }), 'tourist');
    clearRecentMail();
    const first = await http.post(`/bookings/${b.id}/receipt/send/`, {}, 'tourist');
    expect(first.status).toBe(202);
    expect(first.body.sentTo).toContain('amani.guest@example.com');
    expect(first.body.sentTo).toContain('business@tourista.rw');
    const [mail] = await sent('receipt.resend');
    expect(mail.attachments[0].contentType).toBe('application/pdf');
    expect(mail.attachments.map((a) => a.filename)).toContain(`RCT-${b.id.toUpperCase()}.pdf`);
    expect((await http.post(`/bookings/${b.id}/receipt/send/`, {}, 'tourist')).status).toBe(429);
  });
});

describe('refund emails', () => {
  it('keeps everyone informed through the refund', async () => {
    const b = await request_();
    await http.post(`/bookings/${b.id}/decision/`, { approve: true }, 'owner');
    await http.post(`/bookings/${b.id}/pay/`, transfer(), 'tourist');
    await http.post(`/bookings/${b.id}/confirm-payment/`, {}, 'owner');
    clearRecentMail();

    const refund = await http.post('/refunds/', {
      bookingId: b.id, reason: 'Change of plans', receiveMethod: 'mtn', receiveAccount: '+250 788 000 111', receiveName: 'Amani Kayitesi',
    }, 'tourist');
    expect(refund.status).toBe(201);
    let mails = await sent();
    expect(mails.find((m) => m.kind === 'refund.requested')!.to).toEqual(['amani.guest@example.com']);
    expect(mails.find((m) => m.kind === 'refund.requested.admin')!.to).toContain('admin@tourista.rw');
    expect(mails.find((m) => m.kind === 'refund.requested.host')!.to).toContain('business@tourista.rw');

    clearRecentMail();
    await http.post(`/refunds/${refund.body.id}/approve/`, { note: 'OK' }, 'admin');
    mails = await sent();
    const hostMail = mails.find((m) => m.kind === 'refund.approved.host')!;
    expect(hostMail.to).toContain('business@tourista.rw');
    expect(hostMail.text).toMatch(/Refund to: MTN Mobile Money \+250 788 000 111/);
    expect(mails.find((m) => m.kind === 'refund.approved')!.to).toEqual(['amani.guest@example.com']);

    clearRecentMail();
    await http.post(`/refunds/${refund.body.id}/complete/`, { method: 'mtn', senderName: 'Claudine', senderAccount: '+250 788 123 401', proof: 'https://example.com/receipt.jpg' }, 'owner');
    const done = (await sent('refund.completed'))[0];
    expect(done.to).toEqual(['amani.guest@example.com']);
    expect(done.attachments.some((a) => a.filename.startsWith('INV-'))).toBe(true);
    expect(done.text).toMatch(/Refund amount: RWF 100,000/);
  });
});

describe('account emails', () => {
  it('sends welcome, reset and password-changed messages', async () => {
    const reg = await http.post('/auth/register/', { name: 'Mail Tester', email: 'mailtester@example.com', password: 'secret1', role: 'tourist' });
    expect(reg.status).toBe(201);
    expect((await sent('account.welcome'))[0].to).toEqual(['mailtester@example.com']);
    clearRecentMail();

    await http.post('/auth/password-reset/', { email: 'mailtester@example.com' });
    const reset = (await sent('account.reset'))[0];
    expect(reset.to).toEqual(['mailtester@example.com']);
    const token = /reset-password\?token=([a-f0-9]+)/.exec(reset.text)![1];
    expect(reset.html).toContain(`reset-password?token=${token}`);

    clearRecentMail();
    await http.post('/auth/password-reset/', { email: 'ghost@example.com' });
    expect(await sent()).toHaveLength(0); // unknown accounts get nothing, and learn nothing

    expect((await http.post('/auth/password-reset/confirm/', { token, password: 'newsecret1' })).status).toBe(204);
    expect((await sent('account.password-changed'))[0].to).toEqual(['mailtester@example.com']);
  });

  it('invites admin-created users and welcomes staff', async () => {
    await http.post('/users/', { name: 'Invited Person', email: 'invited@example.com', role: 'tourist', password: 'invitepass1' }, 'admin');
    expect((await sent('account.invite'))[0].to).toEqual(['invited@example.com']);
    clearRecentMail();

    const staff = await http.post('/staff/', {
      name: 'Mail Manager', email: 'manager@emaillodge.rw', password: 'staff1234', assignedListingIds: [hotelId],
    }, 'owner');
    expect(staff.status).toBe(201);
    const added = (await sent('staff.added'))[0];
    expect(added.to).toEqual(['manager@emaillodge.rw']);
    expect(added.text).toContain('Email Lodge');
    expect(added.text).not.toContain('staff1234'); // passwords are never emailed

    clearRecentMail();
    await http.patch(`/staff/${staff.body.id}/`, { active: false }, 'owner');
    expect((await sent('staff.status'))[0].subject).toMatch(/deactivated/);
  });

  it('tells the host about a new review', async () => {
    clearRecentMail();
    await http.post('/reviews/', { targetId: hotelId, targetType: 'business', rating: 4, comment: 'Lovely quiet rooms and great breakfast.' }, 'tourist');
    const [mail] = await sent('review.new');
    expect(mail.to).toContain('business@tourista.rw');
    expect(mail.subject).toMatch(/4-star review for Email Lodge/);
  });
});
