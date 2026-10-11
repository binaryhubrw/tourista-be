import { describe, expect, it } from 'vitest';
import { addDaysIso, guidedVisitPrice, nightsBetween, pricingMode, quote } from '../src/domain/pricing.js';
import { assignVehiclePlates, bookingLines, occupiedUntil, remaining, requestWindow } from '../src/domain/availability.js';
import { minDue, remainingDue, subscriptionFee } from '../src/domain/lifecycle.js';
import { looksLikePan, mobileNetwork, maskBank, payoutErrors } from '../src/domain/payout.js';

const room = { id: 'r1', unit: 'per night', priceRwf: 50_000, available: 2 } as any;
const confirmed = (over: object) => ({ status: 'Confirmed', date: '2030-01-10', totalRwf: 0, lines: [{ serviceId: 'r1', serviceName: 'Room', units: 1, unitPriceRwf: 50_000, lineTotalRwf: 0 }], ...over }) as any;

describe('pricing', () => {
  it('maps units to modes', () => {
    expect(pricingMode('per night')).toBe('stay');
    expect(pricingMode('per day')).toBe('rental');
    expect(pricingMode('per person')).toBe('perPerson');
    expect(pricingMode('per plate')).toBe('perUnit');
  });

  it('quotes stays by nights × rooms', () => {
    expect(quote(room, { start: '2030-01-10', end: '2030-01-13', units: 2, people: 4 })).toMatchObject({ periods: 3, units: 2, total: 300_000 });
  });

  it('quotes rentals inclusively (first and last day)', () => {
    const car = { unit: 'per day', priceRwf: 40_000 };
    expect(quote(car, { start: '2030-01-10', end: '2030-01-12', units: 1, people: 2 }).total).toBe(120_000);
  });

  it('quotes per-person by people and per-unit by quantity', () => {
    expect(quote({ unit: 'per person', priceRwf: 20_000 }, { start: '2030-01-10', units: 1, people: 3 }).total).toBe(60_000);
    expect(quote({ unit: 'per plate', priceRwf: 5_000 }, { start: '2030-01-10', units: 4, people: 1 }).total).toBe(20_000);
  });

  it('charges nothing for a stay with checkout on or before check-in', () => {
    expect(quote(room, { start: '2030-01-10', end: '2030-01-10', units: 1, people: 1 }).total).toBe(0);
    expect(quote(room, { start: '2030-01-10', units: 1, people: 1 }).total).toBe(0);
  });

  it('has fixed guided-visit fees and calendar-safe date math', () => {
    expect([1, 2, 3].map((l) => guidedVisitPrice(l as 1))).toEqual([10_000, 30_000, 80_000]);
    expect(addDaysIso('2030-02-28', 1)).toBe('2030-03-01');
    expect(addDaysIso('2030-03-30', 2)).toBe('2030-04-01');
    expect(nightsBetween('2030-03-30', '2030-04-02')).toBe(3);
  });
});

describe('availability', () => {
  it('is unlimited when available is not set', () => {
    expect(remaining({ id: 'x', unit: 'per plate', available: undefined }, [], '2030-01-10', '2030-01-11')).toBe(Infinity);
  });

  it('frees the checkout morning for stays', () => {
    const b = confirmed({ endDate: '2030-01-12', nights: 2, lines: [{ serviceId: 'r1', serviceName: 'R', units: 2, unitPriceRwf: 1, lineTotalRwf: 1 }] });
    expect(occupiedUntil(b, room)).toBe('2030-01-12');
    expect(remaining(room, [b], '2030-01-10', '2030-01-12')).toBe(0);
    expect(remaining(room, [b], '2030-01-12', '2030-01-13')).toBe(2); // checkout day is free
    expect(remaining(room, [b], '2030-01-09', '2030-01-10')).toBe(2); // night before
  });

  it('occupies the last day for rentals and the single day otherwise', () => {
    expect(occupiedUntil({ date: '2030-01-10', endDate: '2030-01-11', nights: 2 }, { unit: 'per day' })).toBe('2030-01-12');
    expect(occupiedUntil({ date: '2030-01-10' }, { unit: 'per person' })).toBe('2030-01-11');
  });

  it('holds stock for any booking that is not released, and sums overlapping units', () => {
    const one = confirmed({ endDate: '2030-01-11', nights: 1 });
    for (const status of ['Canceled', 'Declined', 'Expired', 'Refunded']) {
      expect(remaining(room, [confirmed({ status })], '2030-01-10', '2030-01-11')).toBe(2);
    }
    for (const status of ['Pending', 'AwaitingPayment', 'PaymentReview', 'Confirmed', 'RefundPending']) {
      expect(remaining(room, [confirmed({ status })], '2030-01-10', '2030-01-11')).toBe(1);
    }
    expect(remaining(room, [one, one], '2030-01-10', '2030-01-11')).toBe(0);
  });

  it('builds the requested window per mode', () => {
    expect(requestWindow('2030-01-10', undefined, room)).toEqual({ start: '2030-01-10', end: '2030-01-11' });
    expect(requestWindow('2030-01-10', '2030-01-12', room)).toEqual({ start: '2030-01-10', end: '2030-01-12' });
    expect(requestWindow('2030-01-10', '2030-01-12', { unit: 'per day' })).toEqual({ start: '2030-01-10', end: '2030-01-13' });
  });

  it('falls back to legacy single-service fields for lines', () => {
    expect(bookingLines({ serviceId: 's', serviceName: 'S', units: 3, unitPriceRwf: 10, totalRwf: 30 } as any)).toEqual([
      { serviceId: 's', serviceName: 'S', units: 3, unitPriceRwf: 10, lineTotalRwf: 30 },
    ]);
  });
});

describe('payout helpers', () => {
  it('detects mobile networks across formats', () => {
    expect(mobileNetwork('0788 123 456')).toBe('mtn');
    expect(mobileNetwork('+250 79 123 4567')).toBe('mtn');
    expect(mobileNetwork('250722123456')).toBe('airtel');
    expect(mobileNetwork('0733123456')).toBe('airtel');
    expect(mobileNetwork('0711123456')).toBeNull();
  });

  it('masks bank accounts idempotently', () => {
    expect(maskBank('4001234567890123')).toBe('4001 •••• 0123');
    expect(maskBank(maskBank('4001234567890123'))).toBe('4001 •••• 0123');
  });

  it('flags PAN-like strings but not masked values', () => {
    expect(looksLikePan('4242 4242 4242 4242')).toBe(true);
    expect(looksLikePan('Visa •••• 4242')).toBe(false);
    expect(looksLikePan('+250 788 *** 123')).toBe(false);
  });

  it('validates payout accounts', () => {
    expect(payoutErrors({ bankAccount: '4001234567890123', mtnNumber: '0788123456', airtelNumber: '0733123456' })).toEqual({});
    expect(Object.keys(payoutErrors({ bankAccount: '123', mtnNumber: '0733123456', airtelNumber: '0788123456' }))).toHaveLength(3);
  });
});

describe('lifecycle rules', () => {
  it('requires 30% up front and takes a 10% subscription fee', () => {
    expect(minDue(100_000)).toBe(30_000);
    expect(minDue(1)).toBe(1);
    expect(subscriptionFee(250_000)).toBe(25_000);
  });

  it('tracks what is still due across several transfers', () => {
    const payment = { transfers: [{ amountRwf: 30_000 }, { amountRwf: 20_000 }] } as any;
    expect(remainingDue({ totalRwf: 100_000, payment })).toBe(50_000);
    expect(remainingDue({ totalRwf: 50_000, payment })).toBe(0);
    expect(remainingDue({ totalRwf: 100_000, payment: undefined })).toBe(100_000);
  });
});

describe('vehicle plates', () => {
  const car = { id: 'corolla', name: 'Corolla', description: '', priceRwf: 50_000, unit: 'per day', available: 3, plates: ['RAD 1 A', 'RAD 2 A', 'RAD 3 A'] } as any;
  const hire = (plates: string[], status = 'Confirmed') => ({
    status, date: '2030-01-10', endDate: '2030-01-12', nights: 3, totalRwf: 0,
    lines: [{ serviceId: 'corolla', serviceName: 'Corolla', units: plates.length, unitPriceRwf: 1, lineTotalRwf: 1, plateNumbers: plates }],
  }) as any;

  it('assigns the first free plates and skips ones already out', () => {
    expect(assignVehiclePlates(car, 2, [], '2030-01-10', '2030-01-13')).toEqual(['RAD 1 A', 'RAD 2 A']);
    expect(assignVehiclePlates(car, 2, [hire(['RAD 1 A'])], '2030-01-11', '2030-01-12')).toEqual(['RAD 2 A', 'RAD 3 A']);
  });

  it('frees plates after the hire ends or is released', () => {
    expect(assignVehiclePlates(car, 1, [hire(['RAD 1 A'])], '2030-01-13', '2030-01-14')).toEqual(['RAD 1 A']);
    expect(assignVehiclePlates(car, 1, [hire(['RAD 1 A'], 'Canceled')], '2030-01-10', '2030-01-11')).toEqual(['RAD 1 A']);
  });

  it('returns fewer plates than asked when the fleet is exhausted', () => {
    expect(assignVehiclePlates(car, 3, [hire(['RAD 1 A', 'RAD 2 A'])], '2030-01-10', '2030-01-11')).toEqual(['RAD 3 A']);
  });
});
