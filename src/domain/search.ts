// Port of the frontend search (src/services/searchService.ts + utils/explore.ts).
import type { Business, Location, SearchResult } from './types.js';
import { availableServices, hasAvailability, type AvailabilityBooking } from './availability.js';
import { listingKindOf } from './catalog.js';

export type SearchScope = 'all' | 'accommodations' | 'restaurants' | 'businesses';

export const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export const formatRwf = (n: number) => `RWF ${new Intl.NumberFormat('en-US').format(Math.round(n))}`;

const locationHaystack = (l: Location) =>
  `${l.name} ${l.district} ${l.province} ${l.shortDescription} ${l.description} ${l.category} ${l.thingsToDo.join(' ')}`;

const hasTerm = (haystack: string, t: string) => haystack.includes(t) || (t.endsWith('s') && t.length > 3 && haystack.includes(t.slice(0, -1)));

interface Entry {
  result: SearchResult;
  haystack: string;
  scope: SearchScope;
  locationId: string;
  district: string;
  matchedServices: string[];
}

export function buildIndex(businesses: Business[], locations: Location[], bookings: AvailabilityBooking[], today: string): Entry[] {
  return businesses.filter((b) => hasAvailability(b, bookings, today)).map((b) => {
    const kind = listingKindOf(b);
    const open = availableServices(b.services, bookings, today);
    const place = locations.find((l) => l.id === b.locationId);
    return {
      result: {
        id: b.id, type: 'business', title: b.name, subtitle: `${kind} in ${b.district}`, image: b.image,
        href: `/businesses/${b.id}`, rating: b.rating, category: kind, description: b.description,
        priceLabel: open[0] ? `From ${formatRwf(Math.min(...open.map((s) => s.priceRwf)))}` : undefined,
      },
      scope: b.category === 'Accommodation' ? 'accommodations' : b.category === 'Restaurants' ? 'restaurants' : 'businesses',
      locationId: b.locationId,
      district: b.district,
      haystack: normalize([
        b.name, kind, b.category, b.district, b.description, b.ownerName, ...b.badges,
        ...open.map((s) => `${s.name} ${s.category ?? ''} ${s.description}`),
        place ? locationHaystack(place) : '',
      ].join(' ')),
      matchedServices: open.map((s) => s.category ?? s.name).filter(Boolean),
    };
  });
}

export function search(index: Entry[], locations: Location[], query: string, scope: SearchScope = 'all', limit = 50): SearchResult[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const placeHits = locations.filter((l) => {
    const text = normalize(locationHaystack(l));
    return terms.every((t) => hasTerm(text, t));
  });
  return index
    .filter((e) => scope === 'all' || e.scope === scope || scope === 'businesses')
    .map((e) => {
      const title = normalize(e.result.title);
      const hits = terms.filter((t) => hasTerm(e.haystack, t)).length;
      const nearPlace = placeHits.some((p) => e.locationId === p.id || e.district === p.district);
      const serviceHit = e.matchedServices.some((name) => terms.some((t) => normalize(name).includes(t)));
      const score = hits === terms.length || nearPlace
        ? (hits || 1) * 2 + (title.startsWith(terms[0]) ? 3 : title.includes(terms[0]) ? 2 : 0) + (serviceHit ? 2 : 0) + (nearPlace ? 1 : 0) + e.result.rating / 5
        : 0;
      return { e, score, serviceHit };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ e, serviceHit }) => {
      const match = e.matchedServices.find((name) => terms.some((t) => normalize(name).includes(t)));
      return { ...e.result, description: serviceHit && match ? `Offers ${match}. ${e.result.description}` : e.result.description };
    });
}
