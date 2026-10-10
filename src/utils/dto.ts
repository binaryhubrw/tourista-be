/** Maps a lean/plain Mongo document to its API shape: `_id` becomes `id`, internals are dropped. */
export function toDto<T = any>(doc: any, drop: string[] = []): T {
  if (!doc) return doc;
  const { _id, __v, ...rest } = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  for (const key of drop) delete rest[key];
  return { id: _id, ...rest } as T;
}

export const toDtos = <T = any>(docs: any[], drop: string[] = []) => docs.map((d) => toDto<T>(d, drop));
