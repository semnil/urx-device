// Catalog values are frozen where they are defined, to the last nested array
// and object: a consumer holding a catalog reference cannot change what the
// operations read, whatever the import order or when a context was made.

/** `value`, deeply frozen in place. */
export function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      frozen((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}
