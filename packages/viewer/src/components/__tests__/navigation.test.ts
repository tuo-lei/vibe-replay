// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { DASHBOARD_PARAMS, navigateTo } from "../dashboard-utils";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  sessionStorage.clear();
});

describe("dashboard permalinks", () => {
  it("keeps source-session selection and nested views in the URL", () => {
    navigateTo({
      view: "dashboard",
      session: null,
      tab: "sessions",
      selected: "source-session",
      selectedProvider: "cursor",
      selectedSessionId: "session-1",
      selectedTargetId: "remote-dev",
      project: "~/Code/app",
      projectView: "files",
      insightsSection: "coverage",
    });

    const params = new URLSearchParams(window.location.search);
    expect(params.get("view")).toBe("dashboard");
    expect(params.get("tab")).toBe("sessions");
    expect(params.get("selected")).toBe("source-session");
    expect(params.get("selectedProvider")).toBe("cursor");
    expect(params.get("selectedSessionId")).toBe("session-1");
    expect(params.get("selectedTargetId")).toBe("remote-dev");
    expect(params.get("projectView")).toBe("files");
    expect(params.get("insightsSection")).toBe("coverage");
  });

  it("does not restore a transient source selection after entering a replay", () => {
    navigateTo({
      view: "dashboard",
      session: null,
      tab: "sessions",
      selected: "source-session",
      selectedProvider: "cursor",
      selectedSessionId: "session-1",
    });
    navigateTo({ session: "generated-replay" });
    navigateTo({ view: "dashboard", session: null, tab: "sessions" });

    const params = new URLSearchParams(window.location.search);
    expect(params.get("session")).toBeNull();
    expect(params.get("selected")).toBeNull();
    expect(params.get("selectedProvider")).toBeNull();
    expect(params.get("selectedSessionId")).toBeNull();
  });

  it("tracks all deep-link dimensions in dashboard state", () => {
    expect(DASHBOARD_PARAMS).toEqual(
      expect.arrayContaining([
        "selected",
        "selectedProvider",
        "selectedSessionId",
        "selectedTargetId",
        "projectView",
        "insightsSection",
      ]),
    );
  });
});
