import { customAlphabet, nanoid } from 'nanoid';

const base36 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

export const newId = (prefix: string) => `${prefix}-${nanoid(10)}`;
export const newBookingId = () => `bk-${base36()}`;

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
