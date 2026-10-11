import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const S = Schema.Types;
const opts = { versionKey: false, timestamps: false } as const;
const str = (extra: object = {}) => ({ type: String, ...extra });

// ---- users ---------------------------------------------------------------
const userSchema = new Schema({
  _id: str(),
  name: str({ required: true }),
  email: str({ required: true, unique: true, lowercase: true, trim: true }),
  passwordHash: str({ required: true }),
  role: str({ required: true, enum: ['tourist', 'business_owner', 'admin', 'staff'] }),
  avatar: str(),
  phone: str(),
  country: str(),
  joinedAt: str({ required: true }),
  businessName: str(),
  bankAccount: str(),
  mtnNumber: str(),
  airtelNumber: str(),
  preferences: {
    bookingEmails: Boolean,
    reviewReplies: Boolean,
    newsletter: Boolean,
    currency: String,
    language: String,
  },
  passwordResetTokenHash: str(),
  passwordResetExpiresAt: str(),
  // Staff only: the owner they work for and the listings they manage.
  ownerId: str({ index: true }),
  assignedListingIds: [String],
  title: str(),
  active: Boolean,
}, opts);

// ---- locations -----------------------------------------------------------
const coordinates = { lat: { type: Number, required: true }, lng: { type: Number, required: true } };

const locationSchema = new Schema({
  _id: str(),
  name: str({ required: true }),
  district: str({ required: true }),
  province: str({ required: true, index: true }),
  category: str({ required: true, index: true }),
  interests: [String],
  shortDescription: str({ required: true }),
  description: str({ default: '' }),
  image: str({ required: true }),
  gallery: [String],
  rating: { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  coordinates,
  thingsToDo: [String],
  sustainability: [String],
  priceLevel: { type: Number, enum: [1, 2, 3], default: 1 },
  isHiddenGem: Boolean,
  isPopular: Boolean,
  visitsLastYear: { type: Number, default: 0 },
  createdAt: str({ required: true }),
}, opts);

// ---- experiences ---------------------------------------------------------
const experienceSchema = new Schema({
  _id: str(),
  title: str({ required: true }),
  type: str({ required: true }),
  locationId: str({ required: true, index: true }),
  locationName: str({ default: '' }),
  description: str({ default: '' }),
  image: str({ required: true }),
  duration: str({ default: '' }),
  priceRwf: { type: Number, required: true },
  rating: { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  hostName: str({ default: '' }),
  interests: [String],
  communityLed: { type: Boolean, default: false },
  createdAt: str({ required: true }),
}, opts);

// ---- businesses ----------------------------------------------------------
const serviceSchema = new Schema({
  id: str({ required: true }),
  name: str({ required: true }),
  description: str({ default: '' }),
  priceRwf: { type: Number, required: true },
  unit: str({ required: true }),
  capacity: Number,
  available: Number,
  bedType: str(),
  amenities: [String],
  group: str(),
  category: str(),
  // Vehicles
  brand: str(),
  image: str(),
  plateNumber: str(),
  plates: [String],
  units: [new Schema({ plate: str({ required: true }), image: str(), level: str() }, { _id: false })],
}, { _id: false });

const businessSchema = new Schema({
  _id: str(),
  name: str({ required: true }),
  ownerName: str({ default: '' }),
  ownerId: str({ index: true }),
  category: str({ required: true, index: true }),
  locationId: str({ required: true, index: true }),
  district: str({ default: '' }),
  description: str({ default: '' }),
  image: str({ required: true }),
  gallery: [String],
  rating: { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  badges: [String],
  phone: str({ default: '' }),
  email: str({ default: '' }),
  coordinates,
  services: [serviceSchema],
  priceLevel: { type: Number, enum: [1, 2, 3], default: 1 },
  listingKind: str(),
  propertyType: str(),
  roomTypes: [String],
  ecoFeatures: [String],
  cuisine: [String],
  signatureDish: str(),
  /** Bumped inside booking transactions to force write conflicts (see §8.4). */
  bookingSeq: { type: Number, default: 0 },
  createdAt: str({ required: true, index: true }),
}, opts);

// ---- reviews -------------------------------------------------------------
const reviewSchema = new Schema({
  _id: str(),
  targetId: str({ required: true }),
  targetType: str({ required: true, enum: ['location', 'experience', 'business'] }),
  targetName: str({ required: true }),
  userId: str({ required: true }),
  userName: str({ required: true }),
  userAvatar: str(),
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: str({ required: true }),
  date: str({ required: true }),
}, opts);
reviewSchema.index({ targetId: 1, date: -1 });
reviewSchema.index({ userId: 1, date: -1 });

// ---- itineraries ---------------------------------------------------------
const stopSchema = new Schema({
  id: str({ required: true }),
  locationId: str({ required: true }),
  locationName: str({ default: '' }),
  image: str({ default: '' }),
  day: { type: Number, required: true },
  note: str(),
}, { _id: false });

const itinerarySchema = new Schema({
  _id: str(),
  userId: str({ required: true }),
  title: str({ required: true }),
  description: str({ default: '' }),
  startDate: str({ required: true }),
  endDate: str({ required: true }),
  stops: [stopSchema],
  createdAt: str({ required: true }),
  updatedAt: str({ required: true }),
}, opts);
itinerarySchema.index({ userId: 1, updatedAt: -1 });

// ---- bookings ------------------------------------------------------------
const lineSchema = new Schema({
  serviceId: str({ required: true }),
  serviceName: str({ required: true }),
  units: { type: Number, required: true },
  unitPriceRwf: { type: Number, required: true },
  lineTotalRwf: { type: Number, required: true },
  plateNumbers: [String],
}, { _id: false });

const transferSchema = new Schema({
  id: str({ required: true }),
  method: str({ required: true, enum: ['card', 'mtn', 'airtel'] }),
  senderName: str({ default: '' }),
  senderAccount: str({ default: '' }),
  amountRwf: { type: Number, required: true },
  screenshot: str(),
  sentTo: str(),
  sentToLabel: str(),
  reference: str({ required: true }),
  paidAt: str({ required: true }),
  status: str({ required: true, enum: ['Pending', 'Paid'] }),
}, { _id: false });

const paymentSchema = new Schema({
  id: str(),
  method: str({ required: true, enum: ['card', 'mtn', 'airtel'] }),
  status: str({ required: true, enum: ['Pending', 'Paid', 'Refunded'] }),
  ledger: str({ enum: ['pending', 'approved', 'partial', 'refund_requested', 'refunded'] }),
  account: str({ default: '' }),
  senderAccount: str(),
  senderName: str(),
  screenshot: str(),
  reference: str({ required: true }),
  amountRwf: { type: Number, required: true },
  minDueRwf: Number,
  feeRwf: Number,
  paidAt: str({ required: true }),
  sentTo: str(),
  sentToLabel: str(),
  transfers: [transferSchema],
  providerRef: str(),
}, { _id: false });

const bookingSchema = new Schema({
  _id: str(),
  userId: str({ required: true }),
  customerName: str({ required: true }),
  customerEmail: str({ required: true }),
  customerPhone: str({ default: '' }),
  targetId: str({ required: true }),
  targetType: str({ required: true, enum: ['experience', 'business', 'location'] }),
  targetName: str({ required: true }),
  businessId: str(),
  serviceId: str(),
  serviceName: str(),
  lines: [lineSchema],
  date: str({ required: true }),
  endDate: str(),
  nights: Number,
  units: Number,
  unitPriceRwf: Number,
  people: { type: Number, required: true },
  totalRwf: { type: Number, required: true },
  payment: paymentSchema,
  status: str({
    required: true,
    enum: ['Pending', 'Declined', 'OwnerApproved', 'AwaitingPayment', 'PaymentReview', 'Confirmed', 'Canceled', 'Expired', 'RefundPending', 'Refunded'],
  }),
  /** Owner of the listing; lets hosts and their staff find bookings quickly. */
  ownerId: str(),
  /** The guest must send the first transfer before this instant. */
  paymentDueAt: str(),
  declinedReason: str(),
  notes: str(),
  createdAt: str({ required: true }),
}, opts);
bookingSchema.index({ ownerId: 1, status: 1 });
bookingSchema.index({ status: 1, paymentDueAt: 1 });
bookingSchema.index({ userId: 1, createdAt: -1 });
bookingSchema.index({ businessId: 1, status: 1, date: 1 });
bookingSchema.index({ targetId: 1, status: 1, date: 1 });
bookingSchema.index({ 'lines.serviceId': 1, status: 1 });

// ---- favorites -----------------------------------------------------------
const favoriteSchema = new Schema({
  _id: str(), // fav-<itemId>:<userId>
  userId: str({ required: true }),
  itemId: str({ required: true }),
  itemType: str({ required: true, enum: ['location', 'experience', 'business'] }),
  title: str({ default: '' }),
  subtitle: str({ default: '' }),
  image: str({ default: '' }),
  href: str({ default: '' }),
  addedAt: str({ required: true }),
}, opts);
favoriteSchema.index({ userId: 1, itemId: 1 }, { unique: true });

// ---- refunds -------------------------------------------------------------
const refundStepSchema = new Schema({
  at: str({ required: true }),
  by: str({ required: true }),
  role: str({ required: true }),
  action: str({ required: true }),
  note: str(),
  proof: str(),
}, { _id: false });

const refundSchema = new Schema({
  _id: str(),
  paymentId: str({ required: true }),
  bookingId: str({ required: true, index: true }),
  amountRwf: { type: Number, required: true },
  status: str({ required: true, enum: ['requested', 'owner_review', 'admin_review', 'returning', 'completed', 'rejected', 'canceled'] }),
  reason: str({ default: '' }),
  travelerProof: str(),
  ownerReturnProof: str(),
  travelerReceivedProof: str(),
  receiveMethod: str({ enum: ['card', 'mtn', 'airtel'] }),
  receiveAccount: str(),
  receiveName: str(),
  returnTransfer: new Schema({
    method: str(), senderName: str(), senderAccount: str(), senderAddress: str(),
    proof: str(), sentTo: str(), sentToName: str(), sentAt: str(), reference: str(),
  }, { _id: false }),
  steps: [refundStepSchema],
  createdAt: str({ required: true }),
}, opts);
refundSchema.index({ status: 1, createdAt: -1 });

// ---- notifications -------------------------------------------------------
const notificationSchema = new Schema({
  _id: str(),
  userId: str({ required: true }),
  kind: str({ required: true, enum: ['booking', 'payment', 'refund', 'review', 'staff', 'system'] }),
  title: str({ required: true }),
  body: str({ default: '' }),
  href: str(),
  createdAt: str({ required: true }),
  readAt: str(),
}, opts);
notificationSchema.index({ userId: 1, createdAt: -1 });

// ---- baseline (singleton) ------------------------------------------------
const baselineSchema = new Schema({
  _id: str(),
  data: { type: S.Mixed, required: true },
}, { ...opts, collection: 'tourism_baseline' });

const model = <T>(name: string, schema: Schema<T>) => (mongoose.models[name] as mongoose.Model<T>) ?? mongoose.model<T>(name, schema);

export const User = model('User', userSchema as any) as mongoose.Model<any>;
export const Location = model('Location', locationSchema as any) as mongoose.Model<any>;
export const Experience = model('Experience', experienceSchema as any) as mongoose.Model<any>;
export const Business = model('Business', businessSchema as any) as mongoose.Model<any>;
export const Review = model('Review', reviewSchema as any) as mongoose.Model<any>;
export const Itinerary = model('Itinerary', itinerarySchema as any) as mongoose.Model<any>;
export const Booking = model('Booking', bookingSchema as any) as mongoose.Model<any>;
export const Favorite = model('Favorite', favoriteSchema as any) as mongoose.Model<any>;
export const Refund = model('Refund', refundSchema as any) as mongoose.Model<any>;
export const Notification = model('Notification', notificationSchema as any) as mongoose.Model<any>;
export const Baseline = model('Baseline', baselineSchema as any) as mongoose.Model<any>;

export type { InferSchemaType };
export const BASELINE_ID = 'tourism_baseline';
