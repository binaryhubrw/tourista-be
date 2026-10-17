import { randomBytes } from 'node:crypto';
import { customAlphabet, nanoid } from 'nanoid';

const base36 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

export const newId = (prefix: string) => `${prefix}-${nanoid(10)}`;
export const newBookingId = () => `bk-${base36()}`;

// Ambiguous characters (0/O, 1/l/I) are left out so a password can be read aloud or typed from an email.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** A different, hard-to-guess password every time, for accounts an admin or owner creates. */
export function randomPassword(length = 12) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i]! % PASSWORD_ALPHABET.length];
  return out;
}

export function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'place';
}

/** Returns `slug`, or `slug-2`, `slug-3`… when `taken` already has it. */
export function uniqueSlug(base: string, taken: Set<string>) {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
