import { buildIndex, search, type SearchScope } from '../domain/search.js';
import type { Business, Location } from '../domain/types.js';
import { Booking, Business as BusinessModel, Location as LocationModel } from '../models/index.js';
import { toDtos } from '../utils/dto.js';
import { todayIso } from '../utils/dates.js';

const TTL_MS = 45_000;
let cache: { at: number; day: string; index: ReturnType<typeof buildIndex>; locations: Location[] } | undefined;

/** Call after any business / location / booking write that changes what is searchable. */
export const invalidateSearchIndex = () => { cache = undefined; };

async function load() {
  const day = todayIso();
  if (cache && cache.day === day && Date.now() - cache.at < TTL_MS) return cache;
  const [businesses, locations, bookings] = await Promise.all([
    BusinessModel.find().lean(),
    LocationModel.find().lean(),
    Booking.find({ status: 'Confirmed', date: { $gte: '1970-01-01' } }, { status: 1, date: 1, endDate: 1, nights: 1, lines: 1, serviceId: 1, serviceName: 1, units: 1, unitPriceRwf: 1, totalRwf: 1 }).lean(),
  ]);
  const locs = toDtos<Location>(locations);
  cache = {
    at: Date.now(), day, locations: locs,
    index: buildIndex(toDtos<Business>(businesses), locs, toDtos(bookings) as any, day),
  };
  return cache;
}

export async function runSearch(q: string, scope: SearchScope) {
  const { index, locations } = await load();
  return search(index, locations, q, scope);
}
