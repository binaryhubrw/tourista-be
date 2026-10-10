// Port of the frontend's deterministic demo-bookings generator (src/data/bookings.ts).
// Generated relative to today so dashboards always show a year of activity.
import type { Booking, BookingStatus, Business, Experience, Payment, PaymentMethod, Service, User } from '../../domain/types.js';
import { pricingMode } from '../../domain/pricing.js';
import { todayIso } from '../../utils/dates.js';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Target {
  id: string;
  name: string;
  type: Booking['targetType'];
  businessId?: string;
  services: Service[];
}

export function generateBookings(users: User[], businesses: Business[], experiences: Experience[]): Booking[] {
  const rand = mulberry32(20261009);
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const DAY = 86_400_000;
  const today = new Date(`${todayIso()}T00:00:00Z`);
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const listing = (b: Business): Target => ({ id: b.id, name: b.name, type: 'business', businessId: b.id, services: b.services });
  const ownerListings = businesses.filter((b) => b.ownerId === 'user-business-1' && b.services.length).map(listing);
  const otherTargets: Target[] = [
    ...businesses.filter((b) => b.ownerId !== 'user-business-1' && b.services.length).map(listing),
    ...experiences.slice(0, 6).map((e) => ({
      id: e.id, name: e.title, type: 'experience' as const,
      services: [{ id: 'main', name: e.title, description: e.duration, priceRwf: e.priceRwf, unit: 'per person' }],
    })),
  ];
  const tourist = users.find((u) => u.id === 'user-tourist-1')!;
  const guests = users.filter((u) => u.role === 'tourist' && u.id !== tourist.id);

  const methods: PaymentMethod[] = ['mtn', 'mtn', 'airtel', 'card', 'card'];
  let seq = 1000;

  const payment = (method: PaymentMethod, amountRwf: number, paidAt: Date, status: Payment['status']): Payment => ({
    method, status, amountRwf, paidAt: paidAt.toISOString(),
    account: method === 'card' ? `Visa •••• ${between(1000, 9999)}` : `+250 7${method === 'mtn' ? pick(['8', '9']) : pick(['2', '3'])}${between(0, 9)} *** ${between(100, 999)}`,
    reference: `${method === 'card' ? 'CRD' : method === 'mtn' ? 'MOMO' : 'AIR'}-${(seq * 7919).toString(36).toUpperCase()}`,
  });

  function make(target: Target, customer: User, createdDaysAgo: number): Booking {
    const rooms = target.services.filter((s) => pricingMode(s.unit) === 'stay');
    const service = rooms.length && rand() < 0.85 ? pick(rooms) : pick(target.services);
    const mode = pricingMode(service.unit);
    const created = addDays(today, -createdDaysAgo);
    const start = addDays(created, between(4, 45));

    let units = 1;
    let nights = 1;
    let people = between(1, 4);
    let end: Date | undefined;
    if (mode === 'stay') {
      nights = between(1, 5);
      units = Math.min(service.available ?? 1, between(1, 2));
      people = Math.max(1, Math.min((service.capacity ?? 2) * units, between(1, 4)));
      end = addDays(start, nights);
    } else if (mode === 'rental') {
      nights = between(1, 3);
      units = between(1, 3);
      end = addDays(start, nights - 1);
    } else if (mode === 'perPerson') {
      units = people;
    } else {
      units = between(1, 3);
    }
    const total = service.priceRwf * nights * units;

    const past = start < today;
    const roll = rand();
    const status: BookingStatus = past ? (roll < 0.86 ? 'Confirmed' : 'Canceled') : roll < 0.2 ? 'Pending' : roll < 0.92 ? 'Confirmed' : 'Canceled';
    const method = pick(methods);
    seq += 1;

    return {
      id: `bk-${seq}`,
      userId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone ?? `+250 78${between(0, 9)} ${between(100, 999)} ${between(100, 999)}`,
      targetId: target.id,
      targetType: target.type,
      targetName: target.name,
      businessId: target.businessId,
      serviceId: service.id,
      serviceName: service.name,
      lines: [{ serviceId: service.id, serviceName: service.name, units, unitPriceRwf: service.priceRwf, lineTotalRwf: total }],
      date: iso(start),
      endDate: end && iso(end),
      nights: mode === 'stay' || mode === 'rental' ? nights : undefined,
      units,
      unitPriceRwf: service.priceRwf,
      people,
      totalRwf: total,
      status,
      payment: status === 'Confirmed' ? payment(method, total, created, 'Paid')
        : status === 'Canceled' && rand() < 0.6 ? payment(method, total, created, 'Refunded') : undefined,
      createdAt: created.toISOString(),
    };
  }

  const out: Booking[] = [];
  for (let i = 0; i < 52; i++) out.push(make(pick(ownerListings), pick(guests), between(0, 360)));
  for (let i = 0; i < 10; i++) out.push(make(pick(ownerListings), pick(guests), between(0, 29)));
  for (let i = 0; i < 6; i++) out.push(make(pick(ownerListings), pick(guests), between(30, 59)));
  for (let i = 0; i < 14; i++) out.push(make(i % 4 === 0 ? pick(ownerListings) : pick(otherTargets), tourist, between(2, 330)));
  for (let i = 0; i < 70; i++) out.push(make(pick(otherTargets), pick(guests), between(0, 360)));
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
