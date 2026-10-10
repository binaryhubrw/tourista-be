import { z } from 'zod';
import { mobileNetwork, validateBankAccount } from '../domain/payout.js';

export const trimmed = (max = 120) => z.string().trim().max(max);
export const nonEmpty = (label: string, max = 120) => z.string({ error: `${label} is required.` }).trim().min(1, `${label} is required.`).max(max);
export const email = z.string({ error: 'Enter your email address.' }).trim().toLowerCase().regex(/^\S+@\S+\.\S+$/, 'Enter a valid email address.').max(200);
export const phone = z.string().trim().max(40).refine((v) => v === '' || v.replace(/\D/g, '').length >= 9, 'Enter a phone number with at least 9 digits.');
export const money = z.number({ error: 'Enter an amount in RWF.' }).int('Amounts are whole RWF.').min(0, 'Amounts cannot be negative.');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-12.');

export const coordinates = z.object({
  lat: z.number().min(-3.0, 'Coordinates must be inside Rwanda.').max(-1.0, 'Coordinates must be inside Rwanda.'),
  lng: z.number().min(28.8, 'Coordinates must be inside Rwanda.').max(31.0, 'Coordinates must be inside Rwanda.'),
});

export const bankAccount = z.string().trim().refine(validateBankAccount, 'Enter a bank account of 10 to 20 digits.');
export const mtnNumber = z.string().trim().refine((v) => mobileNetwork(v) === 'mtn', 'Enter an MTN number starting with 078 or 079.');
export const airtelNumber = z.string().trim().refine((v) => mobileNetwork(v) === 'airtel', 'Enter an Airtel number starting with 072 or 073.');

/** Wraps a list with a cap so bulk endpoints cannot be abused. */
export const bulk = <T extends z.ZodTypeAny>(item: T, max = 1000) => z.array(item).min(1, 'Send at least one row.').max(max, `Import up to ${max} rows at a time.`);
