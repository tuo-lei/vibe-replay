import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  killProcessTree,
  isPortFree,
  parsePort,
  readPortOverride,
  reserveFreePort,
  reservePort,
  waitForProcessTree,
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

  it("kills a descendant before the port reservation can be reused", async () => {
    const initial = await reserveFreePort(45_000 + Math.floor(Math.random() * 5_000));
    const port = initial.port;
    await initial.release();

    const descendantSource = `
      import { createServer } from "node:net";
      const server = createServer();
      server.listen(${port}, "127.0.0.1", () => process.stdout.write("ready\\n"));
      setInterval(() => {}, 1000);
    `;
    const parentSource = `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      child.stdout.pipe(process.stdout);
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", parentSource], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "inherit"],
    });

    try {
      await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error(`child did not bind: ${output}`)), 5_000);
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("ready")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      expect(await isPortFree(port)).toBe(false);
      await killProcessTree(child);
      await waitForProcessTree(child, 2_000);

      const deadline = Date.now() + 2_000;
      while (!(await isPortFree(port)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const reservation = await reservePort(port, "Test port");
      await reservation.release();
      expect(await isPortFree(port)).toBe(true);
    } finally {
      await killProcessTree(child);
      await waitForProcessTree(child, 2_000);
    }
  });
});
