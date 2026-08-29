// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPanel from "../SettingsPanel";

const source = {
  id: "remote-devspace",
  sshHost: "dev.ros.example",
  label: "ROS devspace",
  providers: ["codex", "claude-code"],
  connectTimeoutMs: 10_000,
};

function jsonResponse(data: unknown, ok = true) {
  return {
    ok,
    json: async () => data,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/settings")) {
        return jsonResponse({ remoteSources: [source] });
      }
      if (url.endsWith("/api/ai/providers")) {
        return jsonResponse({
          providers: [
            {
              id: "openai",
              name: "OpenAI",
              configured: false,
              authMethods: [{ type: "api_key", label: "OpenAI API key", subscription: false }],
              models: [],
            },
          ],
          defaultProvider: { id: "openai" },
        });
      }
      if (url.endsWith("/api/settings/remote-sources/test")) {
        return jsonResponse({ ok: true, message: "Connected to ROS devspace." });
      }
      if (url.endsWith("/api/settings/remote-sources") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return jsonResponse({ ok: true, remoteSources: body.remoteSources });
      }
      if (url.endsWith("/api/sources")) {
        return jsonResponse({ sessions: [], remoteSources: [source] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsPanel", () => {
  it("loads and displays configured SSH sources", async () => {
    render(<SettingsPanel />);

    await waitFor(() => expect(screen.getByText("ROS devspace")).toBeDefined());
    expect(screen.getByText("remote-devspace")).toBeDefined();
    expect(screen.getByText("dev.ros.example")).toBeDefined();
    expect(screen.getByText("Codex")).toBeDefined();
    expect(screen.getByText("AI providers")).toBeDefined();
    expect(screen.getByLabelText("Custom AI endpoint")).toBeDefined();
  });

  it("tests an SSH source without exposing credentials", async () => {
    render(<SettingsPanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Test" })).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Connected to ROS devspace."),
    );
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("password");
  });

  it("validates and saves a new SSH source", async () => {
    render(<SettingsPanel />);
    await waitFor(() => expect(screen.getByText("ROS devspace")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "+ Add SSH source" }));
    fireEvent.change(screen.getByLabelText("Stable id"), { target: { value: "remote-lab" } });
    fireEvent.change(screen.getByLabelText("Display label"), { target: { value: "Lab host" } });
    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "lab.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save SSH source" }));

    await waitFor(() => {
      const putCall = vi
        .mocked(fetch)
        .mock.calls.find(
          ([input, init]) =>
            String(input).endsWith("/api/settings/remote-sources") && init?.method === "PUT",
        );
      expect(putCall).toBeDefined();
      expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
        remoteSources: expect.arrayContaining([
          expect.objectContaining({ id: "remote-lab", sshHost: "lab.example" }),
        ]),
      });
    });
  });
});
