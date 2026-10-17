import { Router } from 'express';
import { SUBSCRIPTION_RATE, subscriptionFee } from '../domain/lifecycle.js';
import { Booking } from '../models/index.js';
import { ah } from '../utils/async.js';
import { authenticate, requireRole } from '../middleware/auth.js';

export const feesRouter = Router();

/**
 * Platform subscription-fee ledger: 10% of each paid booking. The fee is never
 * reversed — a refunded booking keeps the fee, and only the traveller's share
 * of the cancellation schedule goes back. Mirrors the frontend's admin Fees
 * page (subscriptionRows / walletEntries).
 */
feesRouter.get('/', authenticate, requireRole('admin'), ah(async (_req, res) => {
  const bookings = await Booking.find({
    $or: [{ 'payment.ledger': 'approved' }, { 'payment.status': { $in: ['Paid', 'Refunded'] } }],
  }).lean<any[]>();

  const rows = bookings.map((b) => ({
    id: b.payment?.id ?? b._id,
    bookingId: b._id,
    listing: b.targetName,
    guest: b.customerName,
    paidAt: b.payment?.paidAt ?? b.createdAt,
    bookingTotal: b.totalRwf,
    paid: b.payment?.amountRwf ?? 0,
    feeRwf: b.payment?.feeRwf ?? subscriptionFee(b.totalRwf),
    method: b.payment?.method,
    refunded: b.payment?.status === 'Refunded' || b.status === 'Refunded',
  })).sort((a, b) => b.paidAt.localeCompare(a.paidAt));

  const wallet = rows.map((r) => ({
    id: `in-${r.id}`, kind: 'in' as const, title: `Subscription fee · ${r.listing}`, subtitle: r.guest,
    amount: r.feeRwf, at: r.paidAt, bookingId: r.bookingId,
  })).sort((a, b) => b.at.localeCompare(a.at));

  const earned = wallet.reduce((s, w) => s + w.amount, 0);
  res.json({ rate: SUBSCRIPTION_RATE, rows, wallet, totals: { earnedRwf: earned, reversedRwf: 0, balanceRwf: earned } });
}));
