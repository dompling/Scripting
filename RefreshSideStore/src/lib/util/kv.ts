// A key-value store, and the two implementations this project uses.
//
// Injected rather than reached for. Reading the global `Storage` is per-script permission-gated and
// can prompt, which hangs anything unattended, so every module that persists something takes a
// store and the tests hand it one that lives in memory.
export interface KeyValueStore {
  get<T>(key: string): T | null
  set<T>(key: string, value: T): void
  remove(key: string): void
}

/** The real one: the app's per-script `Storage`, which outlives the script that wrote it. */
export function globalStore(): KeyValueStore {
  return {
    get: <T,>(key: string) => Storage.get<T>(key),
    set: <T,>(key: string, value: T) => { Storage.set(key, value) },
    remove: (key: string) => { Storage.remove(key) },
  }
}

/** An in-memory store, for tests and for anything that must not touch the device. */
export function memoryStore(seed: Record<string, unknown> = {}): KeyValueStore {
  const map = new Map<string, unknown>(Object.entries(seed))
  return {
    get: <T,>(key: string) => (map.has(key) ? (map.get(key) as T) : null),
    set: <T,>(key: string, value: T) => { map.set(key, value) },
    remove: (key: string) => { map.delete(key) },
  }
}
