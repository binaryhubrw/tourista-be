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

export const refundIsOpenForTraveller = (status: RefundStage) => ['requested', 'owner_review', 'admin_review'].includes(status);
export const refundIsClosed = (status: RefundStage) => ['completed', 'rejected', 'canceled'].includes(status);
