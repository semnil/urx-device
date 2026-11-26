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

/**
 * A table by token with no inherited keys: looking up a token it does not
 * hold, `toString` or `constructor` included, gives undefined.
 */
export function byToken<T>(entries: { readonly [token: string]: T }): { readonly [token: string]: T | undefined } {
  return Object.assign(Object.create(null) as { [token: string]: T }, entries);
}
