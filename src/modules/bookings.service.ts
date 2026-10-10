import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { inTransaction } from '../db/transaction.js';
import { bookingLines, remaining, requestWindow } from '../domain/availability.js';
import { formatPayoutAccount, looksLikePan, methodLabel, payoutAccount } from '../domain/payout.js';
import { guidedVisitPrice, pricingMode, quote } from '../domain/pricing.js';
import type { Booking as BookingT, BookingLine, PaymentMethod, Service } from '../domain/types.js';
import { Booking, Business, Experience, Location, User } from '../models/index.js';
import { getPaymentProvider, paymentReference } from '../providers/payment.js';
import { sendMail } from '../providers/mail.js';
import { bookableFrom } from '../utils/dates.js';
import { badRequest, conflict, forbidden, HttpError, notFound, unprocessable } from '../utils/errors.js';
import { newBookingId } from '../utils/ids.js';
import { toDto } from '../utils/dto.js';
import { email, isoDate, phone } from './common.js';
import { invalidateSearchIndex } from './search.service.js';

// ---------------------------------------------------------------- input ----

export const paymentInput = z.object({
  method: z.enum(['card', 'mtn', 'airtel'], { error: 'Choose how you want to pay.' }),
  account: z.string().trim().max(60).default(''),
  amountRwf: z.number().int().min(0).optional(),
}).passthrough();
export type PaymentInput = z.infer<typeof paymentInput>;

export const bookingInput = z.object({
  userId: z.string().trim().optional(),
  customerName: z.string({ error: 'Enter the customer’s name.' }).trim().min(2, 'Enter the customer’s name.').max(120),
  customerEmail: email,
  customerPhone: phone.default(''),
  targetId: z.string().trim().min(1),
  targetType: z.enum(['experience', 'business', 'location']),
  businessId: z.string().trim().optional(),
  serviceId: z.string().trim().optional(),
  lines: z.array(z.object({ serviceId: z.string().trim().min(1), units: z.number().int().min(1).max(500).default(1) }).passthrough()).max(30).optional(),
  units: z.number().int().min(1).max(500).optional(),
  date: isoDate,
  endDate: isoDate.optional(),
  people: z.number({ error: 'Enter how many people are coming.' }).int().min(1, 'At least one person is needed.').max(30, 'Bookings are limited to 30 people. Contact the host for larger groups.'),
  totalRwf: z.number().int().min(0).optional(),
  notes: z.string().trim().max(1000).optional(),
  payment: paymentInput.optional(),
}).passthrough();
export type BookingInputT = z.infer<typeof bookingInput>;

// -------------------------------------------------------------- targets ----

interface Target {
  id: string;
  name: string;
  type: BookingT['targetType'];
  businessId?: string;
  ownerId?: string;
  services: Service[];
}

async function resolveTarget(type: BookingT['targetType'], id: string, session?: ClientSession): Promise<Target> {
  if (type === 'business') {
    const b = await Business.findById(id).session(session ?? null).lean<any>();
    if (!b) throw notFound('Business');
    return { id: b._id, name: b.name, type, businessId: b._id, ownerId: b.ownerId, services: b.services ?? [] };
  }
  if (type === 'experience') {
    const e = await Experience.findById(id).session(session ?? null).lean<any>();
    if (!e) throw notFound('Experience');
    return { id: e._id, name: e.title, type, services: [{ id: 'main', name: e.title, description: e.duration, priceRwf: e.priceRwf, unit: 'per person' }] };
  }
  const l = await Location.findById(id).session(session ?? null).lean<any>();
  if (!l) throw notFound('Location');
  return {
    id: l._id, name: l.name, type,
    services: [{ id: 'guided', name: `Guided visit to ${l.name}`, description: 'A licensed local guide for the day.', priceRwf: guidedVisitPrice(l.priceLevel), unit: 'per person' }],
  };
}

// -------------------------------------------------------------- pricing ----

interface Priced {
  lines: BookingLine[];
  services: Service[];
  totalRwf: number;
  nights?: number;
  units: number;
}

function price(input: BookingInputT, target: Target): Priced {
  if (input.date < bookableFrom()) throw unprocessable('Choose today or later.');
  if (input.endDate && input.endDate < input.date) throw unprocessable('The end date cannot be before the start date.');

  const requested = input.lines?.length
    ? input.lines.map((l) => ({ serviceId: l.serviceId, units: l.units }))
    : input.serviceId ? [{ serviceId: input.serviceId, units: input.units ?? 1 }] : [];
  if (!requested.length) throw unprocessable('Choose at least one service to book.');

  const merged = new Map<string, number>();
  for (const r of requested) merged.set(r.serviceId, (merged.get(r.serviceId) ?? 0) + r.units);

  const lines: BookingLine[] = [];
  const services: Service[] = [];
  let nights: number | undefined;
  for (const [serviceId, units] of merged) {
    const service = target.services.find((s) => s.id === serviceId);
    if (!service) throw unprocessable(`That service is not offered by ${target.name}.`);
    const mode = pricingMode(service.unit);
    if (mode === 'stay' && (!input.endDate || input.endDate <= input.date)) throw unprocessable('Those dates do not cover a chargeable stay.');
    if (mode === 'rental' && !input.endDate) throw unprocessable('Choose the first and last day.');
    const q = quote(service, { start: input.date, end: input.endDate, units, people: input.people });
    if (q.total <= 0) throw unprocessable('Those dates do not cover a chargeable stay.');
    if ((mode === 'stay' || mode === 'rental') && nights === undefined) nights = q.periods;
    lines.push({ serviceId, serviceName: service.name, units: q.units, unitPriceRwf: service.priceRwf, lineTotalRwf: q.total });
    services.push(service);
  }
  const totalRwf = lines.reduce((s, l) => s + l.lineTotalRwf, 0);
  if (input.totalRwf !== undefined && input.totalRwf !== totalRwf) {
    throw conflict('Prices changed while you were booking. Review the new total and try again.');
  }
  return { lines, services, totalRwf, nights, units: lines.reduce((s, l) => s + l.units, 0) };
}

// --------------------------------------------------------- availability ----

/** Throws 409 if any limited service would be oversold. Caller supplies the bookings read (inside the txn when it matters). */
async function assertAvailable(
  target: Target,
  priced: Priced,
  date: string,
  endDate: string | undefined,
  session?: ClientSession,
  ignoreId?: string,
) {
  if (target.type !== 'business') return;
  const limited = priced.services.some((s) => s.available != null);
  if (!limited) return;
  const confirmed = await Booking.find({ businessId: target.id, status: 'Confirmed', ...(ignoreId ? { _id: { $ne: ignoreId } } : {}) })
    .session(session ?? null).lean<any[]>();
  const asBookings = confirmed.map((b) => ({ ...b, id: b._id })) as any[];
  priced.lines.forEach((line, i) => {
    const service = priced.services[i];
    if (service.available == null) return;
    const w = requestWindow(date, endDate, service);
    const left = remaining(service as any, asBookings, w.start, w.end);
    if (line.units > left) {
      throw conflict(left > 0 ? `Only ${left} ${service.name} left for those dates.` : `${service.name} is already booked for those dates.`);
    }
  });
}

// -------------------------------------------------------------- payment ----

const NETWORK_OF: Record<string, PaymentMethod> = { '78': 'mtn', '79': 'mtn', '72': 'airtel', '73': 'airtel' };

/** The guest's number arrives masked (+250 788 *** 123): read the network from its first digits. */
function assertNetworkMatches(method: PaymentMethod, account: string) {
  if (method === 'card') return;
  const digits = account.replace(/\D/g, '');
  const local = digits.startsWith('250') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits;
  const network = NETWORK_OF[local.slice(0, 2)];
  if (local.length >= 2 && network && network !== method) {
    throw unprocessable(`That number is not an ${method === 'mtn' ? 'MTN' : 'Airtel'} number. Choose the matching method.`);
  }
}

interface Settled {
  payment: any;
  providerRef: string;
}

async function charge(target: Target, bookingId: string, totalRwf: number, input: PaymentInput, actorRole: string): Promise<Settled> {
  if (looksLikePan(input.account)) throw badRequest('Card numbers must never be sent to this server. Send only the masked card.');
  // Admins record payments taken at the desk, where the number on file may be on another network.
  if (actorRole !== 'admin') assertNetworkMatches(input.method, input.account);
  if (input.amountRwf !== undefined && input.amountRwf !== totalRwf) {
    throw conflict('Prices changed while you were booking. Review the new total and try again.');
  }
  // The merchant account is always taken from the business owner's profile, never from the client.
  let sentTo: string | undefined;
  let sentToLabel: string | undefined;
  let payout = '';
  if (target.ownerId) {
    const owner = await User.findById(target.ownerId).lean<any>();
    const name = owner?.businessName?.trim() || owner?.name || target.name;
    payout = payoutAccount(owner ? { businessName: name, bankAccount: owner.bankAccount, mtnNumber: owner.mtnNumber, airtelNumber: owner.airtelNumber } : undefined, input.method);
    if (!payout) throw unprocessable(`${name} has not added a ${methodLabel[input.method]} yet. Choose another method.`);
    sentTo = formatPayoutAccount(input.method, payout);
    sentToLabel = `${name} · ${methodLabel[input.method]}`;
  } else {
    sentToLabel = 'Tourista Rwanda';
  }
  const reference = paymentReference(input.method);
  const provider = getPaymentProvider();
  const result = await provider.charge({ amountRwf: totalRwf, method: input.method, account: input.account, reference, bookingId, payout });
  if (result.status !== 'Paid') throw new HttpError(402, 'Your payment was declined. Check the details or try another method.');
  return {
    providerRef: result.providerRef,
    payment: {
      method: input.method, status: 'Paid', account: input.account, reference, amountRwf: totalRwf,
      paidAt: new Date().toISOString(), ...(sentTo ? { sentTo } : {}), ...(sentToLabel ? { sentToLabel } : {}), providerRef: result.providerRef,
    },
  };
}

// --------------------------------------------------------------- emails ----

async function wantsEmail(userId: string) {
  const u = await User.findById(userId, { preferences: 1 }).lean<any>();
  return u?.preferences?.bookingEmails !== false;
}

const rwf = (n: number) => `RWF ${new Intl.NumberFormat('en-US').format(n)}`;

async function emailConfirmation(b: any) {
  if (!(await wantsEmail(b.userId))) return;
  const lines = bookingLines(b).map((l) => `  - ${l.serviceName} × ${l.units}: ${rwf(l.lineTotalRwf)}`).join('\n');
  void sendMail({
    to: b.customerEmail,
    subject: `Booking confirmed: ${b.targetName} (${b._id.toUpperCase()})`,
    text: `Hello ${b.customerName},\n\nYour booking is confirmed.\n\nReference: ${b._id.toUpperCase()}\n${b.targetName}\n${lines}\nDates: ${b.date}${b.endDate ? ` to ${b.endDate}` : ''}\nTotal: ${rwf(b.totalRwf)}\nPaid with: ${b.payment?.method ?? ''} (${b.payment?.account ?? ''})\nSent to: ${b.payment?.sentToLabel ?? ''} ${b.payment?.sentTo ?? ''}\n\nThank you for travelling with Tourista Rwanda.`,
  });
}

async function emailCancellation(b: any, refunded: boolean) {
  if (!(await wantsEmail(b.userId))) return;
  void sendMail({
    to: b.customerEmail,
    subject: `Booking canceled: ${b.targetName} (${b._id.toUpperCase()})`,
    text: `Hello ${b.customerName},\n\nYour booking ${b._id.toUpperCase()} for ${b.targetName} on ${b.date} was canceled.${refunded ? ` ${rwf(b.totalRwf)} is being refunded to ${b.payment?.account ?? 'your account'}.` : ''}\n`,
  });
}

// ---------------------------------------------------------------- views ----

/** API shape of a booking: internal payment fields are removed. */
export function bookingDto(doc: any) {
  const dto: any = toDto(doc);
  if (dto.payment) delete dto.payment.providerRef;
  if (!dto.lines?.length) delete dto.lines;
  return dto;
}

export async function ownedListingIds(ownerId: string): Promise<string[]> {
  return (await Business.find({ ownerId }, { _id: 1 }).lean<any[]>()).map((b) => b._id);
}

export async function canSee(booking: any, user: { id: string; role: string }) {
  if (user.role === 'admin' || booking.userId === user.id) return true;
  if (user.role !== 'business_owner') return false;
  const ids = await ownedListingIds(user.id);
  return ids.includes(booking.businessId) || ids.includes(booking.targetId);
}

// ------------------------------------------------------------- commands ----

export async function createBooking(input: BookingInputT, actor: { id: string; role: string; name: string }) {
  if (actor.role === 'business_owner') throw forbidden('Business accounts cannot make bookings. Use a traveller account.');

  // Whose booking is it?
  let userId = actor.id;
  let customer = { name: input.customerName, email: input.customerEmail, phone: input.customerPhone };
  if (actor.role === 'admin' && input.userId) {
    const u = await User.findById(input.userId).lean<any>();
    if (!u) throw unprocessable('The customer account does not exist.');
    userId = u._id;
    customer = { name: input.customerName || u.name, email: input.customerEmail || u.email, phone: input.customerPhone || u.phone || '' };
  }

  if (actor.role === 'tourist' && input.customerPhone.replace(/\D/g, '').length < 9) {
    throw badRequest('Enter a phone number with at least 9 digits.');
  }
  const bookingId = newBookingId();
  const target = await resolveTarget(input.targetType, input.targetId);
  const priced = price(input, target);

  let settled: Settled | undefined;
  if (input.payment) {
    await assertAvailable(target, priced, input.date, input.endDate); // fail fast, before any money moves
    settled = await charge(target, bookingId, priced.totalRwf, input.payment, actor.role);
  }

  const base = {
    _id: bookingId,
    userId,
    customerName: customer.name,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    targetId: target.id,
    targetType: target.type,
    targetName: target.name,
    ...(target.businessId ? { businessId: target.businessId } : {}),
    serviceId: priced.lines[0].serviceId,
    serviceName: priced.lines[0].serviceName,
    unitPriceRwf: priced.lines[0].unitPriceRwf,
    lines: priced.lines,
    units: priced.units,
    date: input.date,
    ...(input.endDate ? { endDate: input.endDate } : {}),
    ...(priced.nights !== undefined ? { nights: priced.nights } : {}),
    people: input.people,
    totalRwf: priced.totalRwf,
    ...(input.notes ? { notes: input.notes } : {}),
    status: settled ? 'Confirmed' : 'Pending',
    ...(settled ? { payment: settled.payment } : {}),
    createdAt: new Date().toISOString(),
  };

  try {
    const doc = await inTransaction(async (session) => {
      if (settled && target.businessId) {
        // Writing to the shared business document turns write-skew into a write conflict (see spec §8.4).
        await Business.updateOne({ _id: target.businessId }, { $inc: { bookingSeq: 1 } }, { session });
        await assertAvailable(target, priced, input.date, input.endDate, session);
      }
      const [created] = await Booking.create([base], { session });
      return created.toObject();
    });
    if (settled) {
      invalidateSearchIndex();
      void emailConfirmation(doc);
    }
    return bookingDto(doc);
  } catch (err) {
    if (settled) await getPaymentProvider().refund(settled.payment, bookingId).catch(() => undefined);
    throw err;
  }
}

export async function payBooking(id: string, input: PaymentInput, actor: { id: string; role: string }) {
  const existing = await Booking.findById(id).lean<any>();
  if (!existing || !(await canSee(existing, actor)) || actor.role === 'business_owner') throw notFound('Booking');
  if (existing.status === 'Canceled') throw unprocessable('This booking was canceled and can no longer be paid.');
  if (existing.payment || existing.status !== 'Pending') throw conflict('This booking has already been paid.');
  if (existing.date < bookableFrom()) throw unprocessable('The date of this booking has passed.');

  const target = await resolveTarget(existing.targetType, existing.targetId);
  const lines = bookingLines(existing);
  // Re-price from the current catalogue; the booking's own total must still match what the guest agreed to.
  const priced = price({
    ...existing, lines: lines.map((l) => ({ serviceId: l.serviceId, units: l.units })), serviceId: undefined, totalRwf: undefined,
  } as any, target);
  await assertAvailable(target, priced, existing.date, existing.endDate, undefined, id);
  const settled = await charge(target, id, existing.totalRwf, { ...input, amountRwf: input.amountRwf }, actor.role);
  if (priced.totalRwf !== existing.totalRwf) {
    await getPaymentProvider().refund(settled.payment, id).catch(() => undefined);
    throw conflict('Prices changed while you were booking. Review the new total and try again.');
  }

  try {
    const doc = await inTransaction(async (session) => {
      if (target.businessId) {
        await Business.updateOne({ _id: target.businessId }, { $inc: { bookingSeq: 1 } }, { session });
        await assertAvailable(target, priced, existing.date, existing.endDate, session, id);
      }
      const updated = await Booking.findOneAndUpdate(
        { _id: id, status: 'Pending', payment: { $exists: false } },
        { $set: { status: 'Confirmed', payment: settled.payment } },
        { new: true, session },
      ).lean<any>();
      if (!updated) throw conflict('This booking has already been paid or canceled.');
      return updated;
    });
    invalidateSearchIndex();
    void emailConfirmation(doc);
    return bookingDto(doc);
  } catch (err) {
    await getPaymentProvider().refund(settled.payment, id).catch(() => undefined);
    throw err;
  }
}

export async function cancelBooking(id: string, actor: { id: string; role: string }) {
  const existing = await Booking.findById(id).lean<any>();
  if (!existing || !(await canSee(existing, actor))) throw notFound('Booking');
  if (existing.status === 'Canceled') throw conflict('This booking is already canceled.');
  if (actor.role !== 'admin' && existing.date < bookableFrom()) {
    throw unprocessable('This booking has already started or passed, so it can no longer be canceled online.');
  }
  const refund = existing.payment?.status === 'Paid';
  const doc = await Booking.findOneAndUpdate(
    { _id: id, status: { $ne: 'Canceled' } },
    { $set: { status: 'Canceled', ...(refund ? { 'payment.status': 'Refunded' } : {}) } },
    { new: true },
  ).lean<any>();
  if (!doc) throw conflict('This booking is already canceled.');
  if (refund) await getPaymentProvider().refund(existing.payment, id);
  invalidateSearchIndex();
  void emailCancellation(doc, refund);
  return bookingDto(doc);
}
