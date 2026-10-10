// Ported from the frontend (src/utils/pricing.ts) so server quotes agree to the franc.
import type { PriceLevel, Service } from './types.js';

const guidedFees = [10000, 30000, 80000];

/** Price of a licensed local guide for one day, by the place's price level. */
export const guidedVisitPrice = (level: PriceLevel) => guidedFees[level - 1];

export type PricingMode = 'stay' | 'rental' | 'perPerson' | 'perUnit';

export function pricingMode(unit: string): PricingMode {
  if (unit === 'per night') return 'stay';
  if (unit === 'per day') return 'rental';
  if (unit === 'per person') return 'perPerson';
  return 'perUnit';
}

const DAY = 86_400_000;
// UTC midnight, so server time zone and DST never shift a calendar date.
const parse = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

export const nightsBetween = (start: string, end: string) =>
  start && end ? Math.max(0, Math.round((parse(end) - parse(start)) / DAY)) : 0;

export const addDaysIso = (iso: string, days: number) => new Date(parse(iso) + days * DAY).toISOString().slice(0, 10);

export interface Quote {
  mode: PricingMode;
  periods: number;
  units: number;
  total: number;
}

export function quote(service: Pick<Service, 'unit' | 'priceRwf'>, input: { start: string; end?: string; units: number; people: number }): Quote {
  const mode = pricingMode(service.unit);
  const periods =
    mode === 'stay' ? nightsBetween(input.start, input.end ?? '')
    : mode === 'rental' ? (input.end ? nightsBetween(input.start, input.end) + 1 : 0)
    : 1;
  const units = mode === 'perPerson' ? input.people : input.units;
  return { mode, periods, units, total: service.priceRwf * Math.max(periods, 0) * Math.max(units, 0) };
}
