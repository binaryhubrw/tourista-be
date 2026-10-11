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

bookingsRouter.post('/', requireRole('tourist', 'admin'), ah(async (req, res) => {
  res.status(201).json(await createBooking(body(req, bookingInput), req.user!));
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
  if (isHostRole(req.user!.role)) throw forbidden('Only the guest can pay for a booking.');
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
