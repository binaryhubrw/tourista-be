import type { BusinessCategory, PropertyType } from './types.js';

export const LOCATION_CATEGORIES = ['City', 'National Park', 'Lake', 'Town', 'Cultural Site', 'Hidden Gem'] as const;
export const INTERESTS = ['Nature', 'Culture', 'Adventure', 'Food', 'Wildlife', 'History', 'Relaxation'] as const;
export const BUSINESS_CATEGORIES = ['Tour Guides', 'Restaurants', 'Handcrafts', 'Local Products', 'Accommodation', 'Transportation', 'Community Tourism'] as const;
export const BADGES = ['Eco-certified', 'Community-owned', 'Women-led', 'Plastic-free', 'Solar-powered'] as const;
export const PROPERTY_TYPES = ['Hotel', 'Lodge', 'Guesthouse', 'House', 'Apartment'] as const;
export const OFFERING_GROUPS = ['room', 'wellness', 'food', 'activity'] as const;
export const EXPERIENCE_TYPES = ['Traditional Dance', 'Food', 'Crafts', 'Coffee & Tea', 'Village Life', 'Historical Site', 'Cultural Tour', 'Adventure', 'Wildlife'] as const;

export interface ListingKind {
  id: string;
  category: BusinessCategory;
  propertyType?: PropertyType;
}

export const LISTING_KINDS: ListingKind[] = [
  { id: 'Hotel', category: 'Accommodation', propertyType: 'Hotel' },
  { id: 'Lodge', category: 'Accommodation', propertyType: 'Lodge' },
  { id: 'Guesthouse', category: 'Accommodation', propertyType: 'Guesthouse' },
  { id: 'House', category: 'Accommodation', propertyType: 'House' },
  { id: 'Apartment', category: 'Accommodation', propertyType: 'Apartment' },
  { id: 'Restaurant', category: 'Restaurants' },
  { id: 'Bar', category: 'Restaurants' },
  { id: 'Coffee shop', category: 'Restaurants' },
  { id: 'Tour guide', category: 'Tour Guides' },
  { id: 'Transportation', category: 'Transportation' },
  { id: 'Handcraft', category: 'Handcrafts' },
  { id: 'Local product', category: 'Local Products' },
  { id: 'Community tourism', category: 'Community Tourism' },
  { id: 'Wellness', category: 'Community Tourism' },
];

export function listingKindOf(b: { listingKind?: string; propertyType?: string; category: string }) {
  if (b.listingKind) return b.listingKind;
  if (b.propertyType) return b.propertyType;
  return LISTING_KINDS.find((k) => k.category === b.category && !k.propertyType)?.id ?? b.category;
}
