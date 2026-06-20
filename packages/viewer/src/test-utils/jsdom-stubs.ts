import { vi } from "vitest";

/**
 * Stub the browser APIs jsdom doesn't implement but our components touch from
 * effects (scroll APIs) or observers. Call from `beforeAll`; pair with
 * `vi.unstubAllGlobals()` in `afterEach`/`afterAll` to undo the global stubs.
 */
export function stubBrowserAPIs(): void {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  class StubObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", StubObserver);
  vi.stubGlobal("ResizeObserver", StubObserver);
}
