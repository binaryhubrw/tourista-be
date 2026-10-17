import { Router } from 'express';
import { z } from 'zod';
import { RELEASED_STATUSES } from '../domain/lifecycle.js';
import { Booking } from '../models/index.js';
import { ah } from '../utils/async.js';
import { forbidden, notFound, unprocessable } from '../utils/errors.js';
import { authenticate, optionalAuth, requireRole } from '../middleware/auth.js';
import { persistImages } from '../middleware/persistImages.js';
import { body, query } from '../middleware/validate.js';
import { hostListingIds, isHostRole } from './hosts.js';
import { emailInvoice, emailReceipt, invoiceAttachment, receiptAttachment } from './emails.service.js';
import { conflict, tooMany } from '../utils/errors.js';
import {
  bookingDto, bookingInput, cancelBooking, canSee, confirmPayment, createBooking, decideBooking, expireStaleBookings,
  paymentInput, submitPayment,
} from './bookings.service.js';

export const bookingsRouter = Router();

const PROJECTION = {
  targetId: 1, targetType: 1, businessId: 1, serviceId: 1, serviceName: 1,
  'lines.serviceId': 1, 'lines.serviceName': 1, 'lines.units': 1, 'lines.unitPriceRwf': 1, 'lines.lineTotalRwf': 1, 'lines.plateNumbers': 1,
  date: 1, endDate: 1, nights: 1, units: 1, status: 1, totalRwf: 1, unitPriceRwf: 1,
};

/**
 * Bookings that hold stock, reduced to what availability calendars need: no names, contacts,
 * payments or notes. Pending, awaiting-payment and confirmed bookings all hold stock.
 */
async function availability(filter: Record<string, unknown> = {}) {
  await expireStaleBookings();
  const docs = await Booking.find({ ...filter, status: { $nin: RELEASED_STATUSES } }, PROJECTION).lean<any[]>();
  return docs.map((d) => {
    const dto: any = { id: d._id, targetId: d.targetId, targetType: d.targetType, date: d.date, status: d.status, lines: d.lines ?? [] };
    for (const k of ['businessId', 'serviceId', 'serviceName', 'endDate', 'nights', 'units'] as const) if (d[k] !== undefined) dto[k] = d[k];
    if (!dto.lines.length && d.serviceId) {
      dto.lines = [{ serviceId: d.serviceId, serviceName: d.serviceName ?? 'Service', units: d.units ?? 1, unitPriceRwf: d.unitPriceRwf ?? 0, lineTotalRwf: d.totalRwf ?? 0 }];
    }
    return dto;
  });
}

/** Public and PII-free: only what the calendar needs to grey out dates. */
bookingsRouter.get('/availability/', ah(async (req, res) => {
  const q = query(req, z.object({ businessId: z.string().optional(), targetId: z.string().optional() }));
  const filter: Record<string, unknown> = {};
  if (q.businessId) filter.businessId = q.businessId;
  if (q.targetId) filter.targetId = q.targetId;
  res.json(await availability(filter));
}));

/**
 * Role-scoped list. The frontend's public pages call `GET /bookings/?scope=business` to draw availability,
 * signed in or not, so anonymous callers (and tourists asking for `scope=business`) get the PII-free
 * availability list; everyone else gets their own scope.
 */
bookingsRouter.get('/', optionalAuth, ah(async (req, res) => {
  const q = query(req, z.object({ userId: z.string().optional(), businessIds: z.string().optional(), scope: z.string().optional() }).passthrough());
  const user = req.user;
  if (!user || (user.role === 'tourist' && q.scope === 'business')) {
    return res.json(await availability());
  }
  await expireStaleBookings();

  // Owners and staff can reach their traveller bookings by asking for `scope=traveller`.
  if (q.scope === 'traveller') {
    const docs = await Booking.find({ userId: user.id }).sort({ createdAt: -1 }).lean<any[]>();
    return res.json(docs.map(bookingDto));
  }

  const filter: Record<string, any> = {};
  const requestedBiz = q.businessIds?.split(',').map((s) => s.trim()).filter(Boolean);

  if (user.role === 'tourist') {
    filter.userId = user.id;
  } else if (isHostRole(user.role)) {
    const own = await hostListingIds(user);
    const ids = requestedBiz ? requestedBiz.filter((id) => own.includes(id)) : own;
    filter.$or = [{ businessId: { $in: ids } }, { targetId: { $in: ids } }];
    if (q.userId) filter.userId = q.userId;
  } else {
    if (q.userId) filter.userId = q.userId;
    if (requestedBiz) filter.businessId = { $in: requestedBiz };
  }
  res.json((await Booking.find(filter).sort({ createdAt: -1 }).lean<any[]>()).map(bookingDto));
}));

bookingsRouter.use(authenticate);

bookingsRouter.post('/', requireRole('tourist', 'business_owner', 'staff', 'admin'), ah(async (req, res) => {
  res.status(201).json(await createBooking(body(req, bookingInput), req.user!));
}));

/**
 * Invoice as a PDF: the guest, the host side of the booking, and admins. The invoice lists what
 * was booked and the total price; it exists from the moment the booking is made and never changes
 * with later payments (the receipt covers those).
 */
bookingsRouter.get('/:id/invoice/', ah(async (req, res) => {
  const doc = await Booking.findById(req.params.id).lean<any>();
  if (!doc || !(await canSee(doc, req.user!))) throw notFound('Booking');
  const pdf = await invoiceAttachment(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${pdf.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf.content);
}));

/** Receipt as a PDF, for the payments made so far. Same audience as the invoice. */
bookingsRouter.get('/:id/receipt/', ah(async (req, res) => {
  const doc = await Booking.findById(req.params.id).lean<any>();
  if (!doc || !(await canSee(doc, req.user!))) throw notFound('Booking');
  if (!doc.payment) throw conflict('There is no payment on this booking yet, so there is no receipt.');
  const pdf = await receiptAttachment(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${pdf.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf.content);
}));

const lastInvoiceEmail = new Map<string, number>();
const lastReceiptEmail = new Map<string, number>();

/** Emails the invoice and receipt to the traveller and the host. Limited to once a minute per booking. */
bookingsRouter.post('/:id/invoice/send/', ah(async (req, res) => {
  const doc = await Booking.findById(req.params.id).lean<any>();
  if (!doc || !(await canSee(doc, req.user!))) throw notFound('Booking');
  const last = lastInvoiceEmail.get(doc._id) ?? 0;
  if (Date.now() - last < 60_000) throw tooMany('An invoice was just sent. Check your inbox, or try again in a minute.');
  lastInvoiceEmail.set(doc._id, Date.now());
  res.status(202).json({ sentTo: (await emailInvoice(doc)).join(', ') });
}));

/** Emails the current receipt (with the invoice) to the traveller and the host. Limited to once a minute per booking. */
bookingsRouter.post('/:id/receipt/send/', ah(async (req, res) => {
  const doc = await Booking.findById(req.params.id).lean<any>();
  if (!doc || !(await canSee(doc, req.user!))) throw notFound('Booking');
  if (!doc.payment) throw conflict('There is no payment on this booking yet, so there is no receipt.');
  const last = lastReceiptEmail.get(doc._id) ?? 0;
  if (Date.now() - last < 60_000) throw tooMany('A receipt was just sent. Check your inbox, or try again in a minute.');
  lastReceiptEmail.set(doc._id, Date.now());
  res.status(202).json({ sentTo: (await emailReceipt(doc)).join(', ') });
}));

bookingsRouter.get('/:id/', ah(async (req, res) => {
  await expireStaleBookings();
  const doc = await Booking.findById(req.params.id).lean<any>();
  if (!doc || !(await canSee(doc, req.user!))) throw notFound('Booking');
  res.json(bookingDto(doc));
}));

/** Host (owner, or staff on that listing) approves or declines a request. */
bookingsRouter.post('/:id/decision/', requireRole('business_owner', 'staff'), ah(async (req, res) => {
  const { approve, reason } = body(req, z.object({
    approve: z.boolean({ error: 'Say whether you approve or decline.' }),
    reason: z.string().trim().max(500).optional(),
  }));
  res.json(await decideBooking(req.params.id, approve, reason, req.user!));
}));

/** Guest records a transfer to the host (≥30% first, then any remaining balance). */
bookingsRouter.post('/:id/pay/', persistImages, ah(async (req, res) => {
  const doc = await Booking.findById(req.params.id).lean<any>();
  if (doc && doc.userId !== req.user!.id && isHostRole(req.user!.role)) throw forbidden('Only the guest can pay for a booking.');
  res.json(await submitPayment(req.params.id, body(req, paymentInput), req.user!));
}));

/** Host confirms the money arrived: the booking becomes Confirmed. */
bookingsRouter.post('/:id/confirm-payment/', requireRole('business_owner', 'staff'), ah(async (req, res) => {
  res.json(await confirmPayment(req.params.id, req.user!));
}));

bookingsRouter.patch('/:id/', ah(async (req, res) => {
  const { status } = body(req, z.object({ status: z.string() }));
  if (status !== 'Canceled') {
    throw unprocessable('Bookings can only be canceled here. Hosts approve or decline with /decision and confirm payments with /confirm-payment.');
  }
  res.json(await cancelBooking(req.params.id, req.user!));
}));
