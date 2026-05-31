type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function safeStorageGet(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function safeStorageSet(storage: StorageLike, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    /* blocked or quota-limited storage should not break playback */
  }
}

export function safeStorageRemove(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    /* noop */
  }
}
