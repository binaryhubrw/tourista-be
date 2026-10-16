import type { AuthUser } from '../middleware/auth.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/**
 * Listings created by business owners wait for admin approval. Documents without the field predate
 * approvals and count as approved, so existing data keeps working. An admin-deactivated listing
 * (`active: false`) is hidden from travellers too, but stays visible to its owner and to admins.
 */
export const APPROVED_FILTER = { approvalStatus: { $nin: ['pending', 'rejected'] }, active: { $ne: false } } as const;

export const isApproved = (doc?: { approvalStatus?: string; active?: boolean } | null) =>
  !!doc && doc.approvalStatus !== 'pending' && doc.approvalStatus !== 'rejected' && doc.active !== false;

/** Mongo filter for the listings this caller is allowed to see: approved ones, plus their own. */
export function visibleListings(user?: Pick<AuthUser, 'id' | 'role' | 'assignedListingIds'>): Record<string, unknown> {
  if (!user) return { ...APPROVED_FILTER };
  if (user.role === 'admin') return {};
  if (user.role === 'business_owner') return { $or: [{ ...APPROVED_FILTER }, { ownerId: user.id }] };
  if (user.role === 'staff') return { $or: [{ ...APPROVED_FILTER }, { _id: { $in: user.assignedListingIds ?? [] } }] };
  return { ...APPROVED_FILTER };
}

/** Can this caller see this particular listing? */
export function canSeeListing(doc: any, user?: Pick<AuthUser, 'id' | 'role' | 'assignedListingIds'>) {
  if (isApproved(doc)) return true;
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'business_owner') return doc.ownerId === user.id;
  if (user.role === 'staff') return (user.assignedListingIds ?? []).includes(doc._id);
  return false;
}
