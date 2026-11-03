// MongoDB keeps an optional field off a document until something writes it, and Prisma's `field: null` then
// matches only an explicit null, never the missing field. This matches both, so "not yet read", "not yet
// reminded" and the like find the records they mean to.
export function unset<K extends string>(field: K) {
  return { OR: [{ [field]: null }, { [field]: { isSet: false } }] } as { OR: Record<K, null | { isSet: false }>[] };
}
