// Domain types for Tourista Rwanda.
// Field names are camelCase on the frontend; services/apiClient maps them to the API.

export type UserRole = 'tourist' | 'business_owner' | 'admin' | 'staff';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatar?: string;
  phone?: string;
  country?: string;
  joinedAt: string;
  /** Trading name of the company. One business can have many listings. */
  businessName?: string;
  /** Bank account that receives card payments. */
  bankAccount?: string;
  /** MTN MoMo number that receives MTN payments. */
  mtnNumber?: string;
  /** Airtel Money number that receives Airtel payments. */
  airtelNumber?: string;
  /** Staff only: the business owner they work for. */
  ownerId?: string;
  /** Staff only: listing ids they may manage. */
  assignedListingIds?: string[];
  preferences?: {
    bookingEmails?: boolean;
    reviewReplies?: boolean;
    newsletter?: boolean;
    currency?: string;
    language?: string;
  };
}

export interface Coordinates {
  lat: number;
  lng: number;
}

export type LocationCategory =
  | 'City'
  | 'National Park'
  | 'Lake'
  | 'Town'
  | 'Cultural Site'
  | 'Hidden Gem';

export type Interest = 'Nature' | 'Culture' | 'Adventure' | 'Food' | 'Wildlife' | 'History' | 'Relaxation';

export type PriceLevel = 1 | 2 | 3; // 1 = budget, 3 = premium

export interface Location {
  id: string;
  name: string;
  district: string;
  province: string;
  category: LocationCategory;
  interests: Interest[];
  shortDescription: string;
  description: string;
  image: string;
  gallery: string[];
  rating: number;
  reviewCount: number;
  coordinates: Coordinates;
  thingsToDo: string[];
  sustainability: string[];
  priceLevel: PriceLevel;
  isHiddenGem?: boolean;
  isPopular?: boolean;
  visitsLastYear: number;
  createdAt: string;
}

export type ExperienceType =
  | 'Traditional Dance'
  | 'Food'
  | 'Crafts'
  | 'Coffee & Tea'
  | 'Village Life'
  | 'Historical Site'
  | 'Cultural Tour'
  | 'Adventure'
  | 'Wildlife';

export interface Experience {
  id: string;
  title: string;
  type: ExperienceType;
  locationId: string;
  locationName: string;
  description: string;
  image: string;
  duration: string;
  priceRwf: number;
  rating: number;
  reviewCount: number;
  hostName: string;
  interests: Interest[];
  communityLed: boolean;
  createdAt: string;
}

export type BusinessCategory =
  | 'Tour Guides'
  | 'Restaurants'
  | 'Handcrafts'
  | 'Local Products'
  | 'Accommodation'
  | 'Transportation'
  | 'Community Tourism';

export type SustainabilityBadge = 'Eco-certified' | 'Community-owned' | 'Women-led' | 'Plastic-free' | 'Solar-powered';

export type PropertyType = 'Hotel' | 'Lodge' | 'Guesthouse' | 'House' | 'Apartment';

/** How an offering is grouped on a listing. Every listing uses the same groups. */
export type OfferingGroup = 'room' | 'wellness' | 'food' | 'activity' | 'vehicle';

export interface Service {
  id: string;
  name: string;
  description: string;
  priceRwf: number;
  unit: string; // "per person", "per night"
  /** Rooms only (unit "per night"): guests per room. */
  capacity?: number;
  /**
   * How many can be booked at once.
   * Rooms: number of rooms in this category.
   * Services and food: how many bookings the place can take per day.
   * Omitted means the offering does not sell out.
   */
  available?: number;
  bedType?: string;
  amenities?: string[];
  group?: OfferingGroup;
  /** Regular, VIP, Massage, Restaurant, and so on. */
  category?: string;
  /** Vehicles: Toyota, Nissan, and so on. */
  brand?: string;
  /** Vehicles: photo of this car. Falls back to the hire-level photo. */
  image?: string;
  /** Vehicles: main registration plate, e.g. RAD 451 A. */
  plateNumber?: string;
  /** Vehicles: one plate per car when several of this type are in the fleet. */
  plates?: string[];
  /** Vehicles: each physical car, with its own plate and photo. */
  units?: VehicleUnit[];
}

export interface VehicleUnit {
  plate: string;
  image?: string;
  level?: string;
}

export interface Business {
  id: string;
  name: string;
  ownerName: string;
  ownerId?: string;
  category: BusinessCategory;
  locationId: string;
  district: string;
  description: string;
  image: string;
  rating: number;
  reviewCount: number;
  badges: SustainabilityBadge[];
  phone: string;
  email: string;
  coordinates: Coordinates;
  services: Service[];
  priceLevel: PriceLevel;
  createdAt: string;
  /** Specific kind shown to travellers: Hotel, Lodge, Bar, Tour guide… */
  listingKind?: string;
  /** Accommodation only. */
  propertyType?: PropertyType;
  /** Extra photos; `image` is the cover. */
  gallery?: string[];
}

export interface Accommodation extends Business {
  category: 'Accommodation';
  roomTypes: string[];
  ecoFeatures: string[];
}

export interface Restaurant extends Business {
  category: 'Restaurants';
  cuisine: string[];
  signatureDish: string;
}

export type ReviewTargetType = 'location' | 'experience' | 'business';

export interface Review {
  id: string;
  targetId: string;
  targetType: ReviewTargetType;
  targetName: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  rating: 1 | 2 | 3 | 4 | 5;
  comment: string;
  date: string;
}

export interface ItineraryStop {
  id: string;
  locationId: string;
  locationName: string;
  image: string;
  day: number;
  note?: string;
}

export interface Itinerary {
  id: string;
  userId: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  stops: ItineraryStop[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Requested flow (demo): Pending → owner Declined | AwaitingPayment
 * → guest PaymentReview → owner Confirmed. Refunds and expiry sit alongside.
 * Admin does not approve payments.
 */
export type BookingStatus =
  | 'Pending'
  | 'Declined'
  | 'OwnerApproved'
  | 'AwaitingPayment'
  | 'PaymentReview'
  | 'Confirmed'
  | 'Canceled'
  | 'Expired'
  | 'RefundPending'
  | 'Refunded';

export type PaymentMethod = 'card' | 'mtn' | 'airtel';

export type PaymentLedgerStatus = 'pending' | 'approved' | 'partial' | 'refund_requested' | 'refunded';

export interface PaymentTransfer {
  id: string;
  method: PaymentMethod;
  senderName: string;
  /** MoMo number or bank account the traveller sent from. */
  senderAccount: string;
  amountRwf: number;
  screenshot?: string;
  sentTo?: string;
  sentToLabel?: string;
  reference: string;
  paidAt: string;
  status: 'Pending' | 'Paid';
}

export interface Payment {
  id?: string;
  method: PaymentMethod;
  status: 'Pending' | 'Paid' | 'Refunded';
  ledger?: PaymentLedgerStatus;
  /** Masked card number or mobile money number of the guest. */
  account: string;
  /** Account the traveller sent from (MoMo or bank). */
  senderAccount?: string;
  reference: string;
  amountRwf: number;
  paidAt: string;
  /** Masked business account the money was sent to. */
  sentTo?: string;
  /** e.g. "Virunga Hospitality · MTN MoMo". */
  sentToLabel?: string;
  senderName?: string;
  screenshot?: string;
  minDueRwf?: number;
  feeRwf?: number;
  /** Each off-platform transfer. Sum is `amountRwf`. */
  transfers?: PaymentTransfer[];
}

export type RefundStage = 'requested' | 'owner_review' | 'admin_review' | 'returning' | 'completed' | 'rejected' | 'canceled';

export interface RefundStep {
  at: string;
  by: string;
  role: UserRole;
  action: string;
  note?: string;
  proof?: string;
}

export interface RefundReturn {
  method: PaymentMethod;
  senderName: string;
  senderAccount: string;
  senderAddress: string;
  proof: string;
  sentTo: string;
  sentToName: string;
  sentAt: string;
  reference: string;
}

export interface Refund {
  id: string;
  paymentId: string;
  bookingId: string;
  amountRwf: number;
  status: RefundStage;
  reason: string;
  travelerProof?: string;
  ownerReturnProof?: string;
  travelerReceivedProof?: string;
  /** Account the traveller wants the money sent back to. */
  receiveMethod?: PaymentMethod;
  receiveAccount?: string;
  receiveName?: string;
  /** Host transfer that completed the refund. */
  returnTransfer?: RefundReturn;
  steps: RefundStep[];
}

export interface BookingLine {
  serviceId: string;
  serviceName: string;
  units: number;
  unitPriceRwf: number;
  lineTotalRwf: number;
  /** Vehicles: the registration plates assigned to this hire. */
  plateNumbers?: string[];
}

export interface Booking {
  id: string;
  userId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  targetId: string;
  targetType: 'experience' | 'business' | 'location';
  targetName: string;
  businessId?: string;
  serviceId?: string;
  serviceName?: string;
  /** One booking can include several rooms, services or meals, paid together. */
  lines?: BookingLine[];
  /** Start date (check-in for stays). */
  date: string;
  /** End date (check-out for stays, last day for multi-day rentals). */
  endDate?: string;
  /** Nights (stays) or days (rentals) charged. */
  nights?: number;
  /** Rooms, tickets or items booked. */
  units?: number;
  unitPriceRwf?: number;
  people: number;
  totalRwf: number;
  payment?: Payment;
  status: BookingStatus;
  notes?: string;
  createdAt: string;
  /** Guest must finish the 30% transfer before this instant. */
  paymentDueAt?: string;
  ownerId?: string;
  declinedReason?: string;
}

export type FavoriteType = 'location' | 'experience' | 'business';

export interface Favorite {
  id: string;
  itemId: string;
  itemType: FavoriteType;
  title: string;
  subtitle: string;
  image: string;
  href: string;
  addedAt: string;
}

export interface TourismStatistics {
  totals: {
    tourists: number;
    locations: number;
    businesses: number;
    reviews: number;
    itineraries: number;
    bookings: number;
  };
  monthlyTrend: { month: string; domestic: number; international: number }[];
  popularLocations: { name: string; visits: number }[];
  userInterests: { name: Interest; value: number }[];
  highTrafficLocations: { name: string; visitsPerDay: number; capacity: number }[];
  economicImpact: {
    localRevenueRwf: number;
    jobsSupported: number;
    womenLedBusinesses: number;
    communityProjects: number;
    revenueByCategory: { category: BusinessCategory; revenueRwf: number }[];
  };
}

export type SearchResultType = 'location' | 'experience' | 'business';

export interface SearchResult {
  id: string;
  type: SearchResultType;
  title: string;
  subtitle: string;
  image: string;
  href: string;
  rating: number;
  category: string;
  description?: string;
  priceLabel?: string;
}

export interface ApiError {
  message: string;
  status?: number;
}

export type NotificationKind = 'booking' | 'payment' | 'refund' | 'review' | 'staff' | 'system';

export interface AppNotification {
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href?: string;
  createdAt: string;
  readAt?: string;
}
