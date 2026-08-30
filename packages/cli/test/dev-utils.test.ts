import { describe, expect, it } from "vitest";
import {
  parsePort,
  readPortOverride,
  reserveFreePort,
  reservePort,
} from "../../../scripts/dev-utils.mjs";

describe("dev port utilities", () => {
  it("validates explicit ports", () => {
    expect(parsePort("23456")).toBe(23456);
    expect(parsePort(undefined)).toBeUndefined();
    expect(() => parsePort("80", "API port")).toThrow(
      "API port must be an integer between 1024 and 65535",
    );
  });

  it("uses the logical port label for override errors", () => {
    const originalApiPort = process.env.VIBE_API_PORT;
    process.env.VIBE_API_PORT = "80";
    try {
      expect(() => readPortOverride(["VIBE_API_PORT"], "API port")).toThrow(
        "API port must be an integer between 1024 and 65535",
      );
    } finally {
      if (originalApiPort === undefined) delete process.env.VIBE_API_PORT;
      else process.env.VIBE_API_PORT = originalApiPort;
    }
  });

  it("validates the automatic search range", async () => {
    await expect(reserveFreePort(65535, 0)).rejects.toThrow(
      "Port search range must be a positive integer",
    );
  });

  it("rejects conflicting port aliases", () => {
    const originalApiPort = process.env.VIBE_API_PORT;
    const originalViteApiPort = process.env.VITE_API_PORT;
    process.env.VIBE_API_PORT = "23456";
    process.env.VITE_API_PORT = "23457";
    try {
      expect(() => readPortOverride(["VIBE_API_PORT", "VITE_API_PORT"], "API port")).toThrow(
        "API port has conflicting values",
      );
    } finally {
      if (originalApiPort === undefined) delete process.env.VIBE_API_PORT;
      else process.env.VIBE_API_PORT = originalApiPort;
      if (originalViteApiPort === undefined) delete process.env.VITE_API_PORT;
      else process.env.VITE_API_PORT = originalViteApiPort;
    }
  });

  it("reserves different ports for concurrent launchers", async () => {
    const preferred = 40_000 + Math.floor(Math.random() * 10_000);
    const reservations = await Promise.all([
      reserveFreePort(preferred),
      reserveFreePort(preferred),
    ]);
    try {
      expect(reservations[0].port).not.toBe(reservations[1].port);
    } finally {
      await Promise.all(reservations.map(({ release }) => release()));
    }
  });

  it("does not allow an explicit port to be reserved twice", async () => {
    const first = await reserveFreePort(50_000 + Math.floor(Math.random() * 10_000));
    try {
      await expect(reservePort(first.port, "API port")).rejects.toThrow(
        `API port ${first.port} is already reserved by another dev process`,
      );
    } finally {
      await first.release();
    }
  });
});
