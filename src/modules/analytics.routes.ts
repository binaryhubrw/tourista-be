import { Router } from 'express';
import { z } from 'zod';
import type { BusinessCategory, Interest, TourismStatistics } from '../domain/types.js';
import { Baseline, BASELINE_ID, Booking, Business, Itinerary, Location, Review, User } from '../models/index.js';
import { ah } from '../utils/async.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { body } from '../middleware/validate.js';
import { todayIso } from '../utils/dates.js';
import { INTERESTS } from '../domain/catalog.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const EMPTY: TourismStatistics = {
  totals: { tourists: 0, locations: 0, businesses: 0, reviews: 0, itineraries: 0, bookings: 0 },
  monthlyTrend: [], popularLocations: [], userInterests: [], highTrafficLocations: [],
  economicImpact: { localRevenueRwf: 0, jobsSupported: 0, womenLedBusinesses: 0, communityProjects: 0, revenueByCategory: [] },
};

async function baseline(): Promise<TourismStatistics> {
  const doc = await Baseline.findById(BASELINE_ID).lean<any>();
  return { ...EMPTY, ...(doc?.data ?? {}) };
}

/** Rounds shares so they add up to 100 (largest remainder). */
function toPercent(counts: Map<string, number>) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const rows = [...counts].map(([name, n]) => ({ name, exact: (n / total) * 100 }));
  const out = rows.map((r) => ({ name: r.name, value: Math.floor(r.exact), rem: r.exact % 1 }));
  let left = 100 - out.reduce((s, r) => s + r.value, 0);
  for (const r of [...out].sort((a, b) => b.rem - a.rem)) if (left-- > 0) r.value += 1;
  return out.map(({ name, value }) => ({ name: name as Interest, value })).sort((a, b) => b.value - a.value);
}

export const analyticsRouter = Router();
analyticsRouter.use(authenticate, requireRole('admin'));

analyticsRouter.get('/overview/', ah(async (_req, res) => {
  const base = await baseline();
  const [locations, businesses, bookings, users, itineraries, reviewCount, touristCount] = await Promise.all([
    Location.find({}, { name: 1, visitsLastYear: 1, interests: 1 }).lean<any[]>(),
    Business.find({}, { category: 1, badges: 1 }).lean<any[]>(),
    Booking.find({}, { userId: 1, date: 1, status: 1, totalRwf: 1, businessId: 1, payment: 1 }).lean<any[]>(),
    User.find({}, { country: 1 }).lean<any[]>(),
    Itinerary.find({}, { stops: 1 }).lean<any[]>(),
    Review.countDocuments(),
    User.countDocuments({ role: 'tourist' }),
  ]);

  // Monthly trend: baseline for the month + live (non-canceled) bookings by traveller origin.
  const countryOf = new Map(users.map((u) => [u._id as string, u.country as string | undefined]));
  const now = new Date(`${todayIso()}T00:00:00Z`);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1));
    return { key: d.toISOString().slice(0, 7), label: MONTHS[d.getUTCMonth()] };
  });
  const live = new Map(months.map((m) => [m.key, { domestic: 0, international: 0 }]));
  for (const b of bookings) {
    if (b.status === 'Canceled') continue;
    const bucket = live.get(String(b.date).slice(0, 7));
    if (!bucket) continue;
    if (countryOf.get(b.userId) === 'Rwanda') bucket.domestic += 1; else bucket.international += 1;
  }
  const baseByMonth = new Map(base.monthlyTrend.map((m) => [m.month, m]));
  const monthlyTrend = months.map((m) => {
    const b = baseByMonth.get(m.label);
    const l = live.get(m.key)!;
    return { month: m.label, domestic: (b?.domestic ?? 0) + l.domestic, international: (b?.international ?? 0) + l.international };
  });

  // Interests from the places travellers put in their itineraries.
  const interestsOf = new Map(locations.map((l) => [l._id as string, l.interests as Interest[]]));
  const counts = new Map<string, number>();
  let points = 0;
  for (const it of itineraries) for (const stop of it.stops ?? []) for (const i of interestsOf.get(stop.locationId) ?? []) {
    if (INTERESTS.includes(i)) { counts.set(i, (counts.get(i) ?? 0) + 1); points += 1; }
  }
  const userInterests = points >= 20 ? toPercent(counts) : base.userInterests;

  // Revenue: paid, not refunded.
  const categoryOf = new Map(businesses.map((b) => [b._id as string, b.category as BusinessCategory]));
  const revenue = new Map<BusinessCategory, number>(base.economicImpact.revenueByCategory.map((r) => [r.category, r.revenueRwf]));
  let liveRevenue = 0;
  for (const b of bookings) {
    if (b.payment?.status !== 'Paid' || b.status !== 'Confirmed') continue;
    liveRevenue += b.totalRwf;
    const cat = b.businessId ? categoryOf.get(b.businessId) : undefined;
    if (cat) revenue.set(cat, (revenue.get(cat) ?? 0) + b.totalRwf);
  }

  const stats: TourismStatistics = {
    totals: {
      tourists: base.totals.tourists + touristCount,
      locations: locations.length,
      businesses: businesses.length,
      reviews: reviewCount,
      itineraries: base.totals.itineraries + itineraries.length,
      bookings: base.totals.bookings + bookings.length,
    },
    monthlyTrend,
    popularLocations: [...locations]
      .sort((a, b) => b.visitsLastYear - a.visitsLastYear)
      .slice(0, 8)
      .map((l) => ({ name: String(l.name).replace(' National Park', ' NP'), visits: l.visitsLastYear })),
    userInterests,
    highTrafficLocations: base.highTrafficLocations,
    economicImpact: {
      localRevenueRwf: base.economicImpact.localRevenueRwf + liveRevenue,
      jobsSupported: base.economicImpact.jobsSupported,
      womenLedBusinesses: Math.max(base.economicImpact.womenLedBusinesses, businesses.filter((b) => b.badges?.includes('Women-led')).length),
      communityProjects: Math.max(base.economicImpact.communityProjects, businesses.filter((b) => b.badges?.includes('Community-owned') || b.category === 'Community Tourism').length),
      revenueByCategory: [...revenue].map(([category, revenueRwf]) => ({ category, revenueRwf })).sort((a, b) => b.revenueRwf - a.revenueRwf),
    },
  };
  res.json(stats);
}));

const baselinePatch = z.object({
  totals: z.object({ tourists: z.number(), locations: z.number(), businesses: z.number(), reviews: z.number(), itineraries: z.number(), bookings: z.number() }).partial().optional(),
  monthlyTrend: z.array(z.object({ month: z.string(), domestic: z.number(), international: z.number() })).max(12).optional(),
  userInterests: z.array(z.object({ name: z.enum(INTERESTS), value: z.number() })).optional(),
  highTrafficLocations: z.array(z.object({ name: z.string(), visitsPerDay: z.number(), capacity: z.number() })).max(50).optional(),
  economicImpact: z.object({
    localRevenueRwf: z.number(), jobsSupported: z.number(), womenLedBusinesses: z.number(), communityProjects: z.number(),
    revenueByCategory: z.array(z.object({ category: z.string(), revenueRwf: z.number() })),
  }).partial().optional(),
});

analyticsRouter.put('/baseline/', ah(async (req, res) => {
  const patch = body(req, baselinePatch);
  const current = await baseline();
  const next = {
    ...current,
    ...patch,
    totals: { ...current.totals, ...patch.totals },
    economicImpact: { ...current.economicImpact, ...patch.economicImpact },
  };
  await Baseline.findByIdAndUpdate(BASELINE_ID, { $set: { data: next } }, { upsert: true });
  res.json(next);
}));
