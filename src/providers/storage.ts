import { access, constants, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import sharp from 'sharp';
import { config, uploadDir } from '../config.js';
import { badRequest } from '../utils/errors.js';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_DIMENSION = 1600;

function sniff(buf: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

/** Creates the uploads folder if needed and fails fast when it is not writable. */
export async function ensureUploadDir() {
  await mkdir(uploadDir, { recursive: true });
  await access(uploadDir, constants.W_OK);
  return uploadDir;
}

/** Validates magic bytes, re-encodes to JPEG (EXIF stripped, ≤1600px) and stores it. Returns the public URL. */
export async function storeImage(input: Buffer): Promise<string> {
  if (input.length > MAX_IMAGE_BYTES) throw badRequest('Photos must be 15 MB or smaller.');
  if (!sniff(input)) throw badRequest('Photos must be JPEG, PNG or WebP images.');
  let out: Buffer;
  try {
    out = await sharp(input).rotate().resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  } catch {
    throw badRequest('That photo could not be read. Try a different image.');
  }
  const name = `${nanoid(16)}.jpg`;
  if (config.STORAGE_DRIVER !== 'disk') throw new Error('STORAGE_DRIVER=s3 is not implemented yet.');
  await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, name), out);
  return `${config.PUBLIC_MEDIA_URL.replace(/\/$/, '')}/${name}`;
}
