import { maskBank } from '../domain/payout.js';
import { toDto } from '../utils/dto.js';
import type { AuthUser } from '../middleware/auth.js';

const SECRET_FIELDS = ['passwordHash', 'passwordResetTokenHash', 'passwordResetExpiresAt'];
const PAYOUT_FIELDS = ['bankAccount', 'mtnNumber', 'airtelNumber'];

/** What any logged-in user may see of a business owner: enough to know where a payment goes. */
export function publicOwnerProfile(doc: any) {
  return {
    id: doc._id,
    name: doc.name,
    role: doc.role,
    joinedAt: doc.joinedAt,
    ...(doc.country ? { country: doc.country } : {}),
    businessName: doc.businessName || doc.name,
    ...(doc.bankAccount ? { bankAccount: maskBank(doc.bankAccount) } : {}),
    ...(doc.mtnNumber ? { mtnNumber: doc.mtnNumber } : {}),
    ...(doc.airtelNumber ? { airtelNumber: doc.airtelNumber } : {}),
  };
}

/** Public shape of a user. Payout accounts are included only for the user themself and admins. */
export function serializeUser(doc: any, viewer?: Pick<AuthUser, 'id' | 'role'>) {
  const canSeePayout = viewer && (viewer.role === 'admin' || viewer.id === doc._id);
  return toDto(doc, canSeePayout ? SECRET_FIELDS : [...SECRET_FIELDS, ...PAYOUT_FIELDS]);
}
