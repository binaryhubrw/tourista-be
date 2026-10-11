import { Business, User } from '../models/index.js';
import type { AuthUser } from '../middleware/auth.js';

type Actor = Pick<AuthUser, 'id' | 'role'> & { ownerId?: string; assignedListingIds?: string[] };

export const isHostRole = (role: string) => role === 'business_owner' || role === 'staff';

/** The business owner an actor works for: themself, or the owner of a staff account. */
export const hostOwnerId = (u: Actor) => (u.role === 'staff' ? u.ownerId : u.id);

/** Listings a host actor may act on: all of an owner's, or only the ones assigned to a staff member. */
export async function hostListingIds(u: Actor): Promise<string[]> {
  const ownerId = hostOwnerId(u);
  if (!ownerId) return [];
  const own = (await Business.find({ ownerId }, { _id: 1 }).lean<any[]>()).map((b) => b._id as string);
  if (u.role !== 'staff') return own;
  const assigned = new Set(u.assignedListingIds ?? []);
  return own.filter((id) => assigned.has(id));
}

/** Everyone on the host side who should hear about a booking: the owner and staff assigned to that listing. */
export async function hostRecipients(booking: { ownerId?: string; businessId?: string }): Promise<string[]> {
  const ids = new Set<string>();
  let ownerId = booking.ownerId;
  if (!ownerId && booking.businessId) {
    ownerId = (await Business.findById(booking.businessId, { ownerId: 1 }).lean<any>())?.ownerId;
  }
  if (ownerId) {
    ids.add(ownerId);
    if (booking.businessId) {
      const staff = await User.find(
        { role: 'staff', ownerId, active: { $ne: false }, assignedListingIds: booking.businessId },
        { _id: 1 },
      ).lean<any[]>();
      staff.forEach((s) => ids.add(s._id));
    }
  }
  return [...ids];
}
