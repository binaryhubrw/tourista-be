import { Router } from 'express';
import { z } from 'zod';
import { refundIsClosed, refundIsOpenForTraveller } from '../domain/lifecycle.js';
import { Booking, Refund } from '../models/index.js';
import { ah } from '../utils/async.js';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { toDto } from '../utils/dto.js';
import { authenticate, requireRole, type AuthUser } from '../middleware/auth.js';
import { persistImages } from '../middleware/persistImages.js';
import { body, query } from '../middleware/validate.js';
import { canSee } from './bookings.service.js';
import { hostListingIds, hostRecipients } from './hosts.js';
import { adminIds, notify } from './notifications.service.js';
import { invalidateSearchIndex } from './search.service.js';
import { nonEmpty } from './common.js';
import { emailRefundApproved, emailRefundCompleted, emailRefundRejected, emailRefundRequested } from './emails.service.js';

const method = z.enum(['card', 'mtn', 'airtel']);

export const refundRequestInput = z.object({
  bookingId: nonEmpty('The booking'),
  reason: nonEmpty('A reason', 1000),
  proof: z.string().max(25_000_000).optional(),
  amountRwf: z.number().int().min(1).optional(),
  receiveMethod: method,
  receiveAccount: nonEmpty('The account to refund to', 80),
  receiveName: nonEmpty('The name on that account', 120),
});

export const refundCompleteInput = z.object({
  method,
  senderName: nonEmpty('Your name', 120),
  senderAccount: nonEmpty('The account you sent from', 80),
  senderAddress: z.string().trim().max(200).default(''),
  proof: nonEmpty('A screenshot or receipt of the transfer', 25_000_000),
});

const noteInput = z.object({ note: z.string().trim().max(1000).optional() });

const step = (actor: AuthUser, action: string, note?: string, proof?: string) => ({
  at: new Date().toISOString(), by: actor.name, role: actor.role, action,
  ...(note ? { note } : {}), ...(proof ? { proof } : {}),
});

/** A refund is visible to the traveller, the host side of its booking, and admins. Others get 404. */
async function loadVisible(id: string, actor: AuthUser) {
  const refund = await Refund.findById(id).lean<any>();
  if (!refund) throw notFound('Refund');
  const booking = await Booking.findById(refund.bookingId).lean<any>();
  if (!booking || !(await canSee(booking, actor))) throw notFound('Refund');
  return { refund, booking };
}

export const refundsRouter = Router();
refundsRouter.use(authenticate);

refundsRouter.get('/', ah(async (req, res) => {
  const user = req.user!;
  const q = query(req, z.object({ scope: z.string().optional() }).passthrough());
  let filter: Record<string, unknown> = {};
  if (user.role !== 'admin') {
    // `scope=traveller` lets an owner or staff member see the refunds on their own bookings.
    const asTraveller = user.role === 'tourist' || q.scope === 'traveller';
    const listingIds = asTraveller ? null : await hostListingIds(user);
    const bookingFilter: Record<string, unknown> = listingIds === null
      ? { userId: user.id }
      : { $or: [{ businessId: { $in: listingIds } }, { targetId: { $in: listingIds } }] };
    const bookingIds = (await Booking.find(bookingFilter, { _id: 1 }).lean<any[]>()).map((b) => b._id);
    filter = { bookingId: { $in: bookingIds } };
  }
  res.json((await Refund.find(filter).sort({ createdAt: -1 }).lean<any[]>()).map((r) => toDto(r)));
}));

refundsRouter.post('/', requireRole('tourist', 'business_owner', 'staff'), persistImages, ah(async (req, res) => {
  const input = body(req, refundRequestInput);
  const booking = await Booking.findById(input.bookingId).lean<any>();
  if (!booking || booking.userId !== req.user!.id) throw notFound('Booking');
  if (booking.payment?.status !== 'Paid') throw unprocessable('Only a confirmed payment can be refunded.');
  const open = await Refund.exists({ bookingId: booking._id, status: { $nin: ['completed', 'rejected', 'canceled'] } });
  if (open) throw conflict('A refund is already in progress.');
  const amount = input.amountRwf ?? booking.payment.amountRwf;
  if (amount < 1 || amount > booking.payment.amountRwf) throw unprocessable('Refund amount must be between 1 RWF and what you paid.');

  const now = new Date().toISOString();
  const refund = {
    _id: newId('rfd'),
    paymentId: booking.payment.id ?? booking._id,
    bookingId: booking._id,
    amountRwf: amount,
    status: 'admin_review',
    reason: input.reason,
    ...(input.proof ? { travelerProof: input.proof } : {}),
    receiveMethod: input.receiveMethod,
    receiveAccount: input.receiveAccount,
    receiveName: input.receiveName,
    steps: [step(req.user!, 'Requested a refund', input.reason, input.proof)],
    createdAt: now,
  };
  await Refund.create(refund);
  await Booking.updateOne({ _id: booking._id }, { $set: { status: 'RefundPending', 'payment.ledger': 'refund_requested' } });
  invalidateSearchIndex();
  await notify(await adminIds(), { kind: 'refund', title: 'Refund needs a decision', body: `${booking.customerName} asked for a refund on ${booking.targetName}.`, path: `/refunds/${refund._id}` });
  await notify(await hostRecipients(booking), { kind: 'refund', title: 'Refund requested', body: `${booking.customerName} asked for a refund on ${booking.targetName}. Admin will review it first.`, path: `/refunds/${refund._id}` });
  await emailRefundRequested(refund, booking);
  res.status(201).json(toDto(refund));
}));

refundsRouter.get('/:id/', ah(async (req, res) => {
  res.json(toDto((await loadVisible(req.params.id, req.user!)).refund));
}));

/** Admin approves: the host is now asked to send the money back. */
refundsRouter.post('/:id/approve/', requireRole('admin'), ah(async (req, res) => {
  const { note } = body(req, noteInput);
  const { refund, booking } = await loadVisible(req.params.id, req.user!);
  if (!refundIsOpenForTraveller(refund.status)) throw conflict('This refund is not waiting for a decision.');
  const updated = await Refund.findOneAndUpdate(
    { _id: refund._id, status: refund.status },
    { $set: { status: 'returning' }, $push: { steps: step(req.user!, 'Admin approved the refund. The host will return the money.', note) } },
    { new: true },
  ).lean<any>();
  if (!updated) throw conflict('This refund changed. Refresh and try again.');
  await notify(await hostRecipients(booking), { kind: 'refund', title: 'Send the refund to the guest', body: `Admin approved a refund of ${updated.amountRwf.toLocaleString('en-US')} RWF for ${booking.customerName}. Send it and upload your receipt.`, path: `/refunds/${updated._id}` });
  await notify([booking.userId], { kind: 'refund', title: 'Refund approved', body: `Admin approved your refund for ${booking.targetName}. The host will send the money back.`, path: `/refunds/${updated._id}` });
  await emailRefundApproved(updated, booking);
  res.json(toDto(updated));
}));

refundsRouter.post('/:id/reject/', requireRole('admin'), ah(async (req, res) => {
  const { note } = body(req, noteInput);
  const { refund, booking } = await loadVisible(req.params.id, req.user!);
  if (!refundIsOpenForTraveller(refund.status)) throw conflict('This refund is not waiting for a decision.');
  const updated = await Refund.findOneAndUpdate(
    { _id: refund._id, status: refund.status },
    { $set: { status: 'rejected' }, $push: { steps: step(req.user!, 'Admin rejected the refund.', note) } },
    { new: true },
  ).lean<any>();
  if (!updated) throw conflict('This refund changed. Refresh and try again.');
  await Booking.updateOne({ _id: booking._id, status: 'RefundPending' }, { $set: { status: 'Confirmed', 'payment.ledger': 'approved' } });
  await notify([booking.userId], { kind: 'refund', title: 'Refund rejected', body: `Your refund request for ${booking.targetName} was rejected.${note ? ` ${note}` : ''}`, path: `/refunds/${updated._id}` });
  await emailRefundRejected(updated, booking, note);
  res.json(toDto(updated));
}));

/** The host (or their staff) records the transfer that returns the money to the traveller. */
refundsRouter.post('/:id/complete/', requireRole('business_owner', 'staff'), persistImages, ah(async (req, res) => {
  const input = body(req, refundCompleteInput);
  const { refund, booking } = await loadVisible(req.params.id, req.user!);
  if (refund.status !== 'returning') throw conflict('Admin must approve this refund first.');
  if (!refund.receiveAccount || !refund.receiveName) throw unprocessable('This refund has no traveller account to send to.');
  const sentAt = new Date().toISOString();
  const returnTransfer = {
    method: input.method, senderName: input.senderName, senderAccount: input.senderAccount, senderAddress: input.senderAddress,
    proof: input.proof, sentTo: refund.receiveAccount, sentToName: refund.receiveName, sentAt,
    reference: `RFD-${newId('r').slice(-8).toUpperCase()}`,
  };
  const updated = await Refund.findOneAndUpdate(
    { _id: refund._id, status: 'returning' },
    {
      $set: { status: 'completed', ownerReturnProof: input.proof, returnTransfer },
      $push: { steps: step(req.user!, 'Host sent the refund to the traveller.', `From ${input.senderName} · ${input.senderAccount}`, input.proof) },
    },
    { new: true },
  ).lean<any>();
  if (!updated) throw conflict('This refund changed. Refresh and try again.');
  const refundedBooking = await Booking.findOneAndUpdate({ _id: booking._id }, { $set: { status: 'Refunded', 'payment.status': 'Refunded', 'payment.ledger': 'refunded' } }, { new: true }).lean<any>();
  invalidateSearchIndex();
  await notify([booking.userId], { kind: 'refund', title: 'Refund completed', body: `${updated.amountRwf.toLocaleString('en-US')} RWF was sent to ${refund.receiveAccount}.`, path: `/refunds/${updated._id}` });
  await notify(await adminIds(), { kind: 'refund', title: 'Refund completed', body: `${booking.targetName}: the host returned ${updated.amountRwf.toLocaleString('en-US')} RWF.`, path: `/refunds/${updated._id}` });
  await emailRefundCompleted(updated, refundedBooking ?? booking);
  res.json(toDto(updated));
}));

/** The traveller withdraws a request that is still waiting for admin. */
refundsRouter.post('/:id/cancel/', requireRole('tourist', 'business_owner', 'staff'), ah(async (req, res) => {
  const { refund, booking } = await loadVisible(req.params.id, req.user!);
  if (booking.userId !== req.user!.id) throw forbidden('Only the traveller can cancel this refund.');
  if (refundIsClosed(refund.status) || !refundIsOpenForTraveller(refund.status)) throw conflict('This refund can no longer be canceled.');
  const updated = await Refund.findOneAndUpdate(
    { _id: refund._id, status: refund.status },
    { $set: { status: 'canceled' }, $push: { steps: step(req.user!, 'Traveller canceled the refund request.') } },
    { new: true },
  ).lean<any>();
  if (!updated) throw conflict('This refund changed. Refresh and try again.');
  await Booking.updateOne({ _id: booking._id, status: 'RefundPending' }, { $set: { status: 'Confirmed', 'payment.ledger': 'approved' } });
  res.json(toDto(updated));
}));
