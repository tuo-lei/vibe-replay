import { describe, expect, it, vi } from "vitest";
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "../safe-storage";

describe("safe storage helpers", () => {
  it("returns null when getItem throws", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    } as unknown as Storage;

    expect(safeStorageGet(storage, "key")).toBeNull();
  });

  it("ignores setItem and removeItem failures", () => {
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new Error("quota");
      }),
      removeItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    } as unknown as Storage;

    expect(() => safeStorageSet(storage, "key", "value")).not.toThrow();
    expect(() => safeStorageRemove(storage, "key")).not.toThrow();
  });
});
