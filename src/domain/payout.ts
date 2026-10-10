// Ported from the frontend (src/utils/payment.ts).
import type { PaymentMethod } from './types.js';

export interface PayoutTarget {
  businessName: string;
  bankAccount?: string;
  mtnNumber?: string;
  airtelNumber?: string;
}

export const methodLabel: Record<PaymentMethod, string> = {
  card: 'bank account',
  mtn: 'MTN Mobile Money',
  airtel: 'Airtel Money',
};

const localDigits = (phone: string) => {
  const d = phone.replace(/\D/g, '');
  return d.startsWith('250') ? d.slice(3) : d.startsWith('0') ? d.slice(1) : d;
};

/** Rwandan mobile prefixes: MTN 078/079, Airtel 072/073. */
export function mobileNetwork(phone: string): 'mtn' | 'airtel' | null {
  const local = localDigits(phone);
  if (local.length !== 9) return null;
  if (/^7[89]/.test(local)) return 'mtn';
  if (/^7[23]/.test(local)) return 'airtel';
  return null;
}

export const formatMobile = (phone: string) => {
  const local = localDigits(phone);
  return `+250 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
};

export function maskBank(account: string) {
  const digits = account.replace(/\D/g, '');
  if (digits.length < 8) return account.trim();
  return `${digits.slice(0, 4)} •••• ${digits.slice(-4)}`;
}

export const validateBankAccount = (value: string) => {
  const n = value.replace(/\D/g, '').length;
  return n >= 10 && n <= 20;
};

export function payoutAccount(payout: PayoutTarget | undefined, method: PaymentMethod) {
  if (!payout) return '';
  if (method === 'card') return payout.bankAccount?.trim() ?? '';
  if (method === 'mtn') return payout.mtnNumber?.trim() ?? '';
  return payout.airtelNumber?.trim() ?? '';
}

export const formatPayoutAccount = (method: PaymentMethod, account: string) =>
  method === 'card' ? maskBank(account) : formatMobile(account);

export function payoutErrors(p: { bankAccount?: string; mtnNumber?: string; airtelNumber?: string }) {
  const errors: Partial<Record<'bankAccount' | 'mtnNumber' | 'airtelNumber', string>> = {};
  if (!validateBankAccount(p.bankAccount ?? '')) errors.bankAccount = 'Enter a bank account of 10 to 20 digits.';
  if (mobileNetwork(p.mtnNumber ?? '') !== 'mtn') errors.mtnNumber = 'Enter an MTN number starting with 078 or 079.';
  if (mobileNetwork(p.airtelNumber ?? '') !== 'airtel') errors.airtelNumber = 'Enter an Airtel number starting with 072 or 073.';
  return errors;
}

/** Any digit run that looks like a card number (13-19 digits, spaces/dashes ignored). */
export const looksLikePan = (value: string) => /\d{13,19}/.test(value.replace(/[\s-]/g, ''));
