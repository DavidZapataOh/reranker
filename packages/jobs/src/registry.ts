import { InvalidInputError } from "./errors";

export interface Registry<V> {
  /** Registering the same value again is a no-op; a different one under the same key is a bug. */
  register(key: string, value: V): void;
  get(key: string): V | undefined;
  keys(): IterableIterator<string>;
}

/**
 * Modules register themselves at import, so each owner adds its entries without a central list to
 * edit and a collision fails at startup instead of silently replacing one.
 */
export function createRegistry<V>(kind: string): Registry<V> {
  const entries = new Map<string, V>();
  return {
    register(key, value) {
      const existing = entries.get(key);
      if (existing !== undefined && existing !== value) {
        throw new InvalidInputError(`A different ${kind} is already registered as ${key}`);
      }
      entries.set(key, value);
    },
    get: (key) => entries.get(key),
    keys: () => entries.keys(),
  };
}
