// Booking lifecycle rules, ported from the frontend (src/demo/store.ts, src/utils/payment.ts).
import type { Booking, BookingStatus, Payment, PaymentTransfer, RefundStage } from './types.js';

/** Platform subscription fee taken from each paid booking. */
export const SUBSCRIPTION_RATE = 0.1;
/** A guest must send at least this share of the total with their first transfer. */
export const MIN_PAY_RATE = 0.3;
/** How long a guest has to send the first transfer after the host approves. */
export const PAY_WINDOW_MS = 2 * 60 * 60 * 1000;

export const minDue = (totalRwf: number) => Math.max(1, Math.ceil(totalRwf * MIN_PAY_RATE));
export const subscriptionFee = (totalRwf: number) => Math.round(totalRwf * SUBSCRIPTION_RATE);

/** Statuses that no longer hold stock. Everything else (even Pending) reserves inventory. */
export const RELEASED_STATUSES: BookingStatus[] = ['Canceled', 'Declined', 'Expired', 'Refunded'];
export const occupiesInventory = (status: BookingStatus) => !RELEASED_STATUSES.includes(status);

export function paymentTransfers(p?: Payment | null): PaymentTransfer[] {
  if (!p) return [];
  if (p.transfers?.length) return p.transfers;
  return [{
    id: p.id ?? p.reference,
    method: p.method,
    senderName: p.senderName ?? p.account,
    senderAccount: p.senderAccount ?? p.account,
    amountRwf: p.amountRwf,
    screenshot: p.screenshot,
    sentTo: p.sentTo,
    sentToLabel: p.sentToLabel,
    reference: p.reference,
    paidAt: p.paidAt,
    status: p.status === 'Pending' ? 'Pending' : 'Paid',
  }];
}

export const paidToward = (booking: Pick<Booking, 'payment'>) =>
  paymentTransfers(booking.payment).reduce((sum, t) => sum + t.amountRwf, 0);

export const remainingDue = (booking: Pick<Booking, 'payment' | 'totalRwf'>) =>
  Math.max(0, booking.totalRwf - paidToward(booking));

/** Refunds the traveller can still walk away from: the host has not sent the money back yet. */
export const refundIsOpenForTraveller = (status: RefundStage) => ['requested', 'owner_review', 'admin_review', 'returning'].includes(status);
export const refundIsClosed = (status: RefundStage) => ['completed', 'rejected', 'canceled'].includes(status);

// ---- cancellation schedule ------------------------------------------------
// What a traveller gets back when they cancel, measured in whole days before
// check-in (Booking.date). The platform's 10% subscription fee is never part of
// the refund: the fee ledger keeps it, and only the tier share is returned.
export interface CancellationTier {
  /** Whole days before check-in this tier starts at (inclusive). */
  minDays: number;
  /** Share of the booking total kept as a cancellation charge. */
  chargeRate: number;
  /** Share of the booking total the traveller gets back. */
  refundRate: number;
  label: string;
}

export const CANCELLATION_TIERS: CancellationTier[] = [
  { minDays: 20, chargeRate: 0.1, refundRate: 0.9, label: '20 or more days before check-in' },
  { minDays: 15, chargeRate: 0.3, refundRate: 0.7, label: '15 to 19 days before check-in' },
  { minDays: 10, chargeRate: 0.6, refundRate: 0.4, label: '10 to 14 days before check-in' },
  { minDays: 0, chargeRate: 1, refundRate: 0, label: 'Less than 10 days before check-in' },
];

/** Whole days between now and check-in (never negative; a day-of-check-in cancellation scores 0). */
export const daysBeforeCheckIn = (booking: Pick<Booking, 'date'>, now: Date = new Date()) => {
  const start = new Date(`${booking.date}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((start - now.getTime()) / 86_400_000));
};

export const cancellationTier = (daysBefore: number): CancellationTier =>
  CANCELLATION_TIERS.find((t) => daysBefore >= t.minDays) ?? CANCELLATION_TIERS[CANCELLATION_TIERS.length - 1]!;

/** The refund due for this booking right now: the tier share of the total, capped at what was paid. */
export const refundableRwf = (booking: Pick<Booking, 'date' | 'totalRwf' | 'payment'>, now: Date = new Date()) => {
  const paid = booking.payment?.amountRwf ?? 0;
  const byPolicy = Math.round(booking.totalRwf * cancellationTier(daysBeforeCheckIn(booking, now)).refundRate);
  return Math.max(0, Math.min(byPolicy, paid));
};
