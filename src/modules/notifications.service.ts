import { Notification, User } from '../models/index.js';
import type { NotificationKind } from '../domain/types.js';
import { logger } from '../logger.js';
import { newId } from '../utils/ids.js';

interface Message {
  kind: NotificationKind;
  title: string;
  body: string;
  /** Path inside the recipient's dashboard, e.g. `/bookings/bk-123`. The role prefix is added per recipient. */
  path?: string;
}

const base = (role: string) => (role === 'admin' ? '/admin' : role === 'tourist' ? '/dashboard' : '/business-dashboard');

/** Creates one notification per recipient. Never throws: a failed notification must not fail the action. */
export async function notify(userIds: (string | undefined | null)[], message: Message, exceptUserId?: string) {
  try {
    const ids = [...new Set(userIds.filter((id): id is string => !!id && id !== exceptUserId))];
    if (!ids.length) return;
    const users = await User.find({ _id: { $in: ids } }, { role: 1 }).lean<any[]>();
    const now = new Date().toISOString();
    await Notification.insertMany(users.map((u) => ({
      _id: newId('ntf'),
      userId: u._id,
      kind: message.kind,
      title: message.title,
      body: message.body,
      ...(message.path !== undefined ? { href: `${base(u.role)}${message.path}` } : {}),
      createdAt: now,
    })));
  } catch (err) {
    logger.warn({ err }, 'could not create notification');
  }
}

export async function adminIds(): Promise<string[]> {
  return (await User.find({ role: 'admin' }, { _id: 1 }).lean<any[]>()).map((u) => u._id as string);
}
