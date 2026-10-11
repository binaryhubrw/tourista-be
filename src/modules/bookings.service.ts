import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { inTransaction } from '../db/transaction.js';
import { assignVehiclePlates, bookingLines, remaining, requestWindow, reservedPlates } from '../domain/availability.js';
import { vehiclePlates } from '../domain/catalog.js';
import {
  minDue, occupiesInventory, PAY_WINDOW_MS, paymentTransfers, RELEASED_STATUSES, remainingDue, subscriptionFee,
} from '../domain/lifecycle.js';
import { formatPayoutAccount, looksLikePan, methodLabel, payoutAccount } from '../domain/payout.js';
import { guidedVisitPrice, pricingMode, quote } from '../domain/pricing.js';
import type { Booking as BookingT, BookingLine, Payment, PaymentMethod, Service, UserRole } from '../domain/types.js';
import { Booking, Business, Experience, Location, User } from '../models/index.js';
import { getPaymentProvider, paymentReference } from '../providers/payment.js';
import { sendMail } from '../providers/mail.js';
import { bookableFrom } from '../utils/dates.js';
import { badRequest, conflict, forbidden, HttpError, notFound, unprocessable } from '../utils/errors.js';
import { newBookingId, newId } from '../utils/ids.js';
import { toDto } from '../utils/dto.js';
import { email, isoDate, phone } from './common.js';
import { hostListingIds, hostRecipients, isHostRole } from './hosts.js';
import { adminIds, notify } from './notifications.service.js';
import { invalidateSearchIndex } from './search.service.js';

type Actor = { id: string; role: UserRole; name: string; ownerId?: string; assignedListingIds?: string[] };

// ---------------------------------------------------------------- input ----

const METHODS = z.enum(['card', 'mtn', 'airtel'], { error: 'Choose how you want to pay.' });

/** A payment sent with a booking (admin desk payments) or as proof of a transfer to the host. */
export const paymentInput = z.object({
  method: METHODS,
  /** Legacy single field; used as sender account/name when those are not sent. */
  account: z.string().trim().max(80).optional(),
  senderName: z.string().trim().max(120).optional(),
  senderAccount: z.string().trim().max(80).optional(),
  /** Screenshot of the transfer: an https URL, or a base64 data URL stored by the server. */
  screenshot: z.string().max(25_000_000).optional(),
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
  lines: z.array(z.object({
    serviceId: z.string().trim().min(1),
    units: z.number().int().min(1).max(500).default(1),
    plateNumbers: z.array(z.string().trim().min(1).max(20)).max(100).optional(),
  }).passthrough()).max(30).optional(),
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

function price(input: Pick<BookingInputT, 'date' | 'endDate' | 'lines' | 'serviceId' | 'units' | 'people' | 'totalRwf'>, target: Target): Priced {
  if (input.date < bookableFrom()) throw unprocessable('Choose today or later.');
  if (input.endDate && input.endDate < input.date) throw unprocessable('The end date cannot be before the start date.');

  const requested = input.lines?.length
    ? input.lines.map((l) => ({ serviceId: l.serviceId, units: l.units, plateNumbers: l.plateNumbers }))
    : input.serviceId ? [{ serviceId: input.serviceId, units: input.units ?? 1, plateNumbers: undefined as string[] | undefined }] : [];
  if (!requested.length) throw unprocessable('Choose at least one service to book.');

  const merged = new Map<string, { units: number; plateNumbers?: string[] }>();
  for (const r of requested) {
    const prev = merged.get(r.serviceId);
    merged.set(r.serviceId, { units: (prev?.units ?? 0) + r.units, plateNumbers: [...(prev?.plateNumbers ?? []), ...(r.plateNumbers ?? [])] });
  }

  const lines: BookingLine[] = [];
  const services: Service[] = [];
  let nights: number | undefined;
  for (const [serviceId, { units, plateNumbers }] of merged) {
    const service = target.services.find((s) => s.id === serviceId);
    if (!service) throw unprocessable(`That service is not offered by ${target.name}.`);
    const mode = pricingMode(service.unit);
    if (mode === 'stay' && (!input.endDate || input.endDate <= input.date)) throw unprocessable('Those dates do not cover a chargeable stay.');
    if (mode === 'rental' && !input.endDate) throw unprocessable('Choose the first and last day.');
    const q = quote(service, { start: input.date, end: input.endDate, units, people: input.people });
    if (q.total <= 0) throw unprocessable('Those dates do not cover a chargeable stay.');
    if ((mode === 'stay' || mode === 'rental') && nights === undefined) nights = q.periods;
    lines.push({
      serviceId, serviceName: service.name, units: q.units, unitPriceRwf: service.priceRwf, lineTotalRwf: q.total,
      ...(plateNumbers?.length ? { plateNumbers } : {}),
    });
    services.push(service);
  }
  const totalRwf = lines.reduce((s, l) => s + l.lineTotalRwf, 0);
  if (input.totalRwf !== undefined && input.totalRwf !== totalRwf) {
    throw conflict('Prices changed while you were booking. Review the new total and try again.');
  }
  return { lines, services, totalRwf, nights, units: lines.reduce((s, l) => s + l.units, 0) };
}

// ------------------------------------------------------------ inventory ----

/**
 * Checks stock for every limited service and assigns registration plates to vehicle hires.
 * Any booking that has not been canceled, declined, expired or refunded holds stock.
 * Mutates `priced.lines[i].plateNumbers`.
 */
async function reserve(target: Target, priced: Priced, date: string, endDate: string | undefined, session?: ClientSession, ignoreId?: string) {
  if (target.type !== 'business') return;
  const needsCheck = priced.services.some((s) => s.available != null || vehiclePlates(s).length > 0);
  if (!needsCheck) return;
  const held = await Booking.find({
    businessId: target.id,
    status: { $nin: RELEASED_STATUSES },
    ...(ignoreId ? { _id: { $ne: ignoreId } } : {}),
  }).session(session ?? null).lean<any[]>();
  const asBookings = held.map((b) => ({ ...b, id: b._id })) as any[];

  priced.lines.forEach((line, i) => {
    const service = priced.services[i];
    const w = requestWindow(date, endDate, service);
    if (service.available != null) {
      const left = remaining(service as any, asBookings, w.start, w.end);
      if (line.units > left) {
        throw conflict(left > 0 ? `Only ${left} ${service.name} left for those dates.` : `${service.name} is already booked for those dates.`);
      }
    }
    const fleet = vehiclePlates(service);
    if (!fleet.length) return;
    const taken = new Set(reservedPlates(service.id, asBookings, w.start, w.end, service));
    const wanted = line.plateNumbers ?? [];
    const valid = wanted.length === line.units && new Set(wanted).size === wanted.length && wanted.every((p) => fleet.includes(p) && !taken.has(p));
    if (valid) return;
    const assigned = assignVehiclePlates(service as any, line.units, asBookings, w.start, w.end);
    if (assigned.length < line.units) {
      throw conflict(`Only ${assigned.length} ${service.name} left for those dates.`);
    }
    line.plateNumbers = assigned;
  });
}

// -------------------------------------------------------------- payment ----

const NETWORK_OF: Record<string, PaymentMethod> = { '78': 'mtn', '79': 'mtn', '72': 'airtel', '73': 'airtel' };

/** The sender's number may be masked (+250 788 *** 123): read the network from its first digits. */
function assertNetworkMatches(method: PaymentMethod, account: string) {
  if (method === 'card') return;
  const digits = account.replace(/\D/g, '');
  const local = digits.startsWith('250') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits;
  const network = NETWORK_OF[local.slice(0, 2)];
  if (local.length >= 2 && network && network !== method) {
    throw unprocessable(`That number is not an ${method === 'mtn' ? 'MTN' : 'Airtel'} number. Choose the matching method.`);
  }
}

/** Where the guest must send money for this listing and method. Always read from the owner's profile. */
async function payoutFor(target: Target, method: PaymentMethod) {
  if (!target.ownerId) return { sentTo: undefined, sentToLabel: 'Tourista Rwanda', payout: '' };
  const owner = await User.findById(target.ownerId).lean<any>();
  const name = owner?.businessName?.trim() || owner?.name || target.name;
  const payout = payoutAccount(owner ? { businessName: name, bankAccount: owner.bankAccount, mtnNumber: owner.mtnNumber, airtelNumber: owner.airtelNumber } : undefined, method);
  if (!payout) throw unprocessable(`${name} has not added a ${methodLabel[method]} yet. Choose another method.`);
  return { sentTo: formatPayoutAccount(method, payout), sentToLabel: `${name} · ${methodLabel[method]}`, payout };
}

/** Instant payment recorded at creation (admin desk payments, simulated gateway). Confirms the booking at once. */
async function instantPayment(target: Target, bookingId: string, totalRwf: number, input: PaymentInput, actorRole: string) {
  const account = input.senderAccount ?? input.account ?? '';
  if (looksLikePan(account)) throw badRequest('Card numbers must never be sent to this server. Send only the masked card.');
  if (actorRole !== 'admin') assertNetworkMatches(input.method, account);
  if (input.amountRwf !== undefined && input.amountRwf !== totalRwf) {
    throw conflict('Prices changed while you were booking. Review the new total and try again.');
  }
  const { sentTo, sentToLabel, payout } = await payoutFor(target, input.method);
  const reference = paymentReference(input.method);
  const result = await getPaymentProvider().charge({ amountRwf: totalRwf, method: input.method, account, reference, bookingId, payout });
  if (result.status !== 'Paid') throw new HttpError(402, 'Your payment was declined. Check the details or try another method.');
  const paidAt = new Date().toISOString();
  const senderName = input.senderName ?? account;
  return {
    providerRef: result.providerRef,
    payment: {
      id: newId('pay'), method: input.method, status: 'Paid', ledger: 'approved', account, senderAccount: account, senderName,
      reference, amountRwf: totalRwf, minDueRwf: minDue(totalRwf), feeRwf: subscriptionFee(totalRwf), paidAt,
      ...(sentTo ? { sentTo } : {}), ...(sentToLabel ? { sentToLabel } : {}), providerRef: result.providerRef,
      transfers: [{
        id: newId('trn'), method: input.method, senderName, senderAccount: account, amountRwf: totalRwf, reference, paidAt,
        status: 'Paid', ...(sentTo ? { sentTo } : {}), ...(sentToLabel ? { sentToLabel } : {}),
      }],
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
    text: `Hello ${b.customerName},\n\nYour booking is confirmed.\n\nReference: ${b._id.toUpperCase()}\n${b.targetName}\n${lines}\nDates: ${b.date}${b.endDate ? ` to ${b.endDate}` : ''}\nTotal: ${rwf(b.totalRwf)}\nPaid so far: ${rwf(paymentTransfers(b.payment).reduce((s: number, t: any) => s + t.amountRwf, 0))}\nSent to: ${b.payment?.sentToLabel ?? ''} ${b.payment?.sentTo ?? ''}\n\nThank you for travelling with Tourista Rwanda.`,
  });
}

async function emailCancellation(b: any) {
  if (!(await wantsEmail(b.userId))) return;
  void sendMail({
    to: b.customerEmail,
    subject: `Booking canceled: ${b.targetName} (${b._id.toUpperCase()})`,
    text: `Hello ${b.customerName},\n\nYour booking ${b._id.toUpperCase()} for ${b.targetName} on ${b.date} was canceled.\n`,
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

export async function canSee(booking: any, user: Actor) {
  if (user.role === 'admin' || booking.userId === user.id) return true;
  if (!isHostRole(user.role)) return false;
  const ids = await hostListingIds(user);
  return ids.includes(booking.businessId) || ids.includes(booking.targetId);
}

/** The booking if the actor is on the host side of it; otherwise 404 (never reveal other hosts' bookings). */
async function hostBooking(id: string, actor: Actor) {
  const doc = await Booking.findById(id).lean<any>();
  if (!doc || !isHostRole(actor.role) || !(await canSee(doc, actor))) throw notFound('Booking');
  return doc;
}

// -------------------------------------------------------------- expiry -----

/**
 * Bookings that were approved but not paid inside the window expire and release their stock.
 * Called lazily before reads and on a timer in the server.
 */
export async function expireStaleBookings(now = new Date()) {
  const stale = await Booking.find(
    { status: 'AwaitingPayment', paymentDueAt: { $lt: now.toISOString() }, payment: { $exists: false } },
    { _id: 1, userId: 1, targetName: 1 },
  ).lean<any[]>();
  if (!stale.length) return 0;
  const res = await Booking.updateMany(
    { _id: { $in: stale.map((b) => b._id) }, status: 'AwaitingPayment', payment: { $exists: false } },
    { $set: { status: 'Expired' } },
  );
  for (const b of stale) {
    await notify([b.userId], { kind: 'booking', title: 'Payment window closed', body: `The two-hour window to pay for ${b.targetName} has closed, so the booking expired.`, path: `/bookings/${b._id}` });
  }
  invalidateSearchIndex();
  return res.modifiedCount;
}

// ------------------------------------------------------------- commands ----

export async function createBooking(input: BookingInputT, actor: Actor) {
  if (isHostRole(actor.role)) throw forbidden('Business accounts cannot make bookings. Use a traveller account.');
  if (input.payment && actor.role !== 'admin') {
    throw unprocessable('Send your booking request first. You pay the host after they approve it.');
  }

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

  let instant: Awaited<ReturnType<typeof instantPayment>> | undefined;
  if (input.payment) {
    await reserve(target, priced, input.date, input.endDate); // fail fast, before any money moves
    instant = await instantPayment(target, bookingId, priced.totalRwf, input.payment, actor.role);
  }

  const build = () => ({
    _id: bookingId,
    userId,
    customerName: customer.name,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    targetId: target.id,
    targetType: target.type,
    targetName: target.name,
    ...(target.businessId ? { businessId: target.businessId } : {}),
    ...(target.ownerId ? { ownerId: target.ownerId } : {}),
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
    status: instant ? 'Confirmed' : 'Pending',
    ...(instant ? { payment: instant.payment } : {}),
    createdAt: new Date().toISOString(),
  });

  try {
    const doc = await inTransaction(async (session) => {
      if (target.businessId) {
        // Writing to the shared business document turns write-skew into a write conflict (see spec §8.4).
        await Business.updateOne({ _id: target.businessId }, { $inc: { bookingSeq: 1 } }, { session });
      }
      await reserve(target, priced, input.date, input.endDate, session);
      const [created] = await Booking.create([build()], { session });
      return created.toObject();
    });
    invalidateSearchIndex();
    if (instant) void emailConfirmation(doc);
    else {
      await notify(await hostRecipients(doc), {
        kind: 'booking', title: 'New booking request',
        body: `${doc.customerName} asked to book ${doc.targetName} from ${doc.date}${doc.endDate ? ` to ${doc.endDate}` : ''}. Approve or decline it.`,
        path: `/bookings/${doc._id}`,
      });
    }
    return bookingDto(doc);
  } catch (err) {
    if (instant) await getPaymentProvider().refund(instant.payment as Payment, bookingId).catch(() => undefined);
    throw err;
  }
}

/** Host approves (opens a two-hour payment window) or declines a request. */
export async function decideBooking(id: string, approve: boolean, reason: string | undefined, actor: Actor) {
  await expireStaleBookings();
  const existing = await hostBooking(id, actor);
  if (existing.status !== 'Pending') throw conflict('This booking is not waiting for the host.');
  const set = approve
    ? { status: 'AwaitingPayment', paymentDueAt: new Date(Date.now() + PAY_WINDOW_MS).toISOString() }
    : { status: 'Declined', declinedReason: reason?.trim() || 'Declined by the host.' };
  const doc = await Booking.findOneAndUpdate({ _id: id, status: 'Pending' }, { $set: set }, { new: true }).lean<any>();
  if (!doc) throw conflict('This booking is not waiting for the host.');
  invalidateSearchIndex();
  await notify([doc.userId], approve
    ? { kind: 'booking', title: 'Host approved your booking', body: `${doc.targetName} approved your request. Pay at least ${new Intl.NumberFormat('en-US').format(minDue(doc.totalRwf))} RWF (30%) within two hours to confirm.`, path: `/bookings/${doc._id}` }
    : { kind: 'booking', title: 'Host declined your booking', body: `${doc.targetName} could not take your booking. ${doc.declinedReason}`, path: `/bookings/${doc._id}` });
  return bookingDto(doc);
}

/** Guest (or admin) records a transfer made to the host's account. The host then confirms receipt. */
export async function submitPayment(id: string, input: PaymentInput, actor: Actor) {
  await expireStaleBookings();
  const existing = await Booking.findById(id).lean<any>();
  if (!existing || !(await canSee(existing, actor)) || isHostRole(actor.role)) throw notFound('Booking');

  const first = !existing.payment;
  const open = first ? ['AwaitingPayment'] : ['AwaitingPayment', 'PaymentReview', 'Confirmed'];
  if (existing.status === 'Pending') throw conflict('The host must approve this booking first.');
  if (existing.status === 'Expired') throw conflict('The two-hour payment window has closed.');
  if (!open.includes(existing.status)) throw conflict('This booking is not open for payment.');
  if (first && existing.paymentDueAt && new Date(existing.paymentDueAt).getTime() < Date.now()) {
    await Booking.updateOne({ _id: id, status: 'AwaitingPayment' }, { $set: { status: 'Expired' } });
    throw conflict('The two-hour payment window has closed.');
  }

  const remainingNow = remainingDue(existing);
  if (remainingNow <= 0) throw conflict('This booking is already paid in full.');
  const due = minDue(existing.totalRwf);
  // `{ method, account }` alone (older clients) pays everything that is left.
  const amount = Math.round(input.amountRwf ?? remainingNow);
  if (first && amount < due) throw unprocessable(`Pay at least 30% (${due.toLocaleString('en-US')} RWF).`);
  if (!first && amount < 1) throw unprocessable('Enter how much you sent.');
  if (amount > remainingNow) throw unprocessable(`You can send up to ${remainingNow.toLocaleString('en-US')} RWF remaining.`);

  const senderAccount = (input.senderAccount ?? input.account ?? '').trim();
  const senderName = (input.senderName ?? input.account ?? existing.customerName).trim();
  if (!senderAccount) throw unprocessable('Enter the account you sent the money from.');
  if (actor.role !== 'admin') assertNetworkMatches(input.method, senderAccount);

  const target = await resolveTarget(existing.targetType, existing.targetId);
  const { sentTo, sentToLabel } = await payoutFor(target, input.method);
  const paidAt = new Date().toISOString();
  const transfer = {
    id: newId('trn'), method: input.method, senderName, senderAccount, amountRwf: amount,
    ...(input.screenshot ? { screenshot: input.screenshot } : {}),
    ...(sentTo ? { sentTo } : {}), ...(sentToLabel ? { sentToLabel } : {}),
    reference: paymentReference(input.method), paidAt, status: 'Pending' as const,
  };
  const transfers = [...paymentTransfers(existing.payment), transfer];
  const payment = {
    id: existing.payment?.id ?? newId('pay'),
    method: input.method,
    status: 'Pending',
    ledger: existing.payment?.ledger === 'approved' ? 'approved' : 'pending',
    account: senderAccount,
    senderAccount,
    senderName,
    ...(input.screenshot ? { screenshot: input.screenshot } : {}),
    reference: transfer.reference,
    amountRwf: transfers.reduce((s, t) => s + t.amountRwf, 0),
    minDueRwf: due,
    feeRwf: subscriptionFee(existing.totalRwf),
    paidAt,
    ...(sentTo ? { sentTo } : {}), ...(sentToLabel ? { sentToLabel } : {}),
    transfers,
  };
  const status = first || existing.status === 'AwaitingPayment' ? 'PaymentReview' : existing.status;
  // Compare-and-set so two simultaneous submissions cannot overwrite each other.
  const guard: Record<string, unknown> = { _id: id, status: existing.status };
  if (first) guard.payment = { $exists: false };
  else guard['payment.amountRwf'] = existing.payment.amountRwf;
  const doc = await Booking.findOneAndUpdate(guard, { $set: { status, payment } }, { new: true }).lean<any>();
  if (!doc) throw conflict('This booking changed while you were paying. Refresh and try again.');
  invalidateSearchIndex();
  const hosts = await hostRecipients(doc);
  await notify(hosts, {
    kind: 'payment', title: 'Guest sent payment proof',
    body: `${doc.customerName} sent ${rwf(amount)} for ${doc.targetName}. Check your account and confirm the money arrived.`,
    path: `/payments/${doc._id}`,
  });
  await notify(await adminIds(), { kind: 'payment', title: 'Payment waiting for review', body: `A guest sent proof for ${doc.targetName}.`, path: '/payments' });
  return bookingDto(doc);
}

/** Host confirms the transfer arrived: the payment is approved and the booking becomes Confirmed. */
export async function confirmPayment(id: string, actor: Actor) {
  const existing = await hostBooking(id, actor);
  if (!existing.payment) throw unprocessable('There is no payment proof to confirm.');
  const transfers = paymentTransfers(existing.payment);
  const pending = transfers.some((t) => t.status === 'Pending');
  if (!pending && existing.status !== 'PaymentReview') throw unprocessable('There is no payment proof to confirm.');
  if (['Canceled', 'Declined', 'Expired', 'Refunded', 'RefundPending'].includes(existing.status)) {
    throw conflict('This booking can no longer be confirmed.');
  }
  const doc = await Booking.findOneAndUpdate(
    { _id: id, status: existing.status },
    {
      $set: {
        status: 'Confirmed',
        'payment.status': 'Paid',
        'payment.ledger': 'approved',
        'payment.transfers': transfers.map((t) => ({ ...t, status: 'Paid' })),
      },
    },
    { new: true },
  ).lean<any>();
  if (!doc) throw conflict('This booking changed. Refresh and try again.');
  invalidateSearchIndex();
  await notify([doc.userId], {
    kind: 'payment', title: 'Payment approved',
    body: `${doc.targetName} confirmed your payment of ${rwf(doc.payment.amountRwf)}.${remainingDue(doc) > 0 ? ` ${rwf(remainingDue(doc))} is still due.` : ' Your booking is confirmed.'}`,
    path: `/bookings/${doc._id}`,
  });
  void emailConfirmation(doc);
  return bookingDto(doc);
}

export async function cancelBooking(id: string, actor: Actor) {
  await expireStaleBookings();
  const existing = await Booking.findById(id).lean<any>();
  if (!existing || !(await canSee(existing, actor))) throw notFound('Booking');
  // Already closed: nothing to do (idempotent, as the frontend expects).
  if (['Canceled', 'Refunded', 'Declined', 'Expired'].includes(existing.status)) return bookingDto(existing);
  if (existing.status === 'RefundPending') throw conflict('A refund is in progress for this booking.');
  if (existing.payment?.status === 'Paid') throw conflict('Ask for a refund instead of canceling a paid booking.');
  if (actor.role !== 'admin' && existing.date < bookableFrom()) {
    throw unprocessable('This booking has already started or passed, so it can no longer be canceled online.');
  }
  const doc = await Booking.findOneAndUpdate(
    { _id: id, status: existing.status },
    { $set: { status: 'Canceled' } },
    { new: true },
  ).lean<any>();
  if (!doc) throw conflict('This booking changed. Refresh and try again.');
  invalidateSearchIndex();
  const guestCanceled = actor.id === doc.userId;
  await notify(guestCanceled ? await hostRecipients(doc) : [doc.userId], {
    kind: 'booking', title: 'Booking canceled',
    body: `${guestCanceled ? doc.customerName : doc.targetName} canceled the booking for ${doc.targetName} on ${doc.date}.`,
    path: `/bookings/${doc._id}`,
  }, actor.id);
  void emailCancellation(doc);
  return bookingDto(doc);
}

export { occupiesInventory };
