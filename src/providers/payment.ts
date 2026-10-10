import { nanoid } from 'nanoid';
import { config } from '../config.js';
import type { Payment, PaymentMethod } from '../domain/types.js';

export interface ChargeInput {
  amountRwf: number;
  method: PaymentMethod;
  account: string;
  reference: string;
  bookingId: string;
  payout: string;
}

export interface PaymentProvider {
  name: string;
  charge(input: ChargeInput): Promise<{ status: 'Paid' | 'Failed'; providerRef: string }>;
  refund(payment: Payment, bookingId: string): Promise<void>;
}

/**
 * Development provider: approves everything. The browser has already "authorised" the payment;
 * the server only recomputes amounts and recipient. Never use in production.
 */
class SimulatedProvider implements PaymentProvider {
  name = 'simulated';
  async charge(input: ChargeInput) {
    return { status: 'Paid' as const, providerRef: `SIM-${input.bookingId}-${nanoid(6)}` };
  }
  async refund() {
    /* nothing to reverse */
  }
}

let provider: PaymentProvider | undefined;

export function getPaymentProvider(): PaymentProvider {
  if (provider) return provider;
  // Real providers (flutterwave, mtn_momo, airtel_money) plug in here with webhooks + idempotency keys.
  if (config.PAYMENT_PROVIDER !== 'simulated') {
    throw new Error(`Payment provider "${config.PAYMENT_PROVIDER}" is not implemented.`);
  }
  provider = new SimulatedProvider();
  return provider;
}

export const paymentReference = (method: PaymentMethod) =>
  `${method === 'card' ? 'CRD' : method === 'mtn' ? 'MOMO' : 'AIR'}-${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
