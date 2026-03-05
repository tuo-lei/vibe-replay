import { describe, it, expect } from "vitest";
import { scanForSecrets } from "../src/scan.js";

describe("scanForSecrets", () => {
  it("returns empty for clean text", () => {
    const findings = scanForSecrets(JSON.stringify({
      content: "Hello world, no secrets here",
      path: "/Users/test/project/src/index.ts",
    }));
    expect(findings).toEqual([]);
  });

  it("detects OpenAI API key", () => {
    const findings = scanForSecrets(`{"key": "sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234"}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toMatch(/OpenAI|API Key/i);
  });

  it("detects GitHub PAT", () => {
    const findings = scanForSecrets(`{"token": "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl"}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toMatch(/GitHub/i);
  });

  it("detects AWS access key", () => {
    const findings = scanForSecrets(`{"key": "AKIAIOSFODNN7EXAMPLE"}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toMatch(/AWS/i);
  });

  it("detects Slack token", () => {
    const slackToken = ["xoxb", "123456789012", "1234567890123", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-");
    const findings = scanForSecrets(`{"token": "${slackToken}"}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toMatch(/Slack/i);
  });

  it("detects Stripe secret key", () => {
    const stripeKey = ["sk", "live", "1234567890abcdef1234567890"].join("_");
    const findings = scanForSecrets(`{"key": "${stripeKey}"}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toMatch(/Stripe/i);
  });

  it("detects JWT", () => {
    const findings = scanForSecrets(`{"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toMatch(/JSON Web Token/i);
  });

  it("detects SendGrid key", () => {
    const findings = scanForSecrets(`{"key": "SG.1234567890abcdefghijklmn.1234567890abcdefghijklmnopqrstuvwxyz1234"}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toMatch(/SendGrid/i);
  });

  it("detects database URI with credentials", () => {
    const findings = scanForSecrets(`{"uri": "postgres://admin:supersecret@db.example.com:5432/mydb"}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toMatch(/Database/i);
  });

  it("detects PEM private key", () => {
    const findings = scanForSecrets(`{"key": "-----BEGIN RSA PRIVATE KEY-----\\nMIIEow..."}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toMatch(/Private Key/i);
  });

  it("detects env var secrets", () => {
    const findings = scanForSecrets(`{"cmd": "export API_KEY=sk1234567890abcdef"}`);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("skips already-redacted values", () => {
    const findings = scanForSecrets(`{"key": "sk-pro...[REDACTED]"}`);
    expect(findings).toEqual([]);
  });

  it("deduplicates same match", () => {
    const key = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl";
    const findings = scanForSecrets(`{"a": "${key}", "b": "${key}"}`);
    // Should only report once
    expect(findings.length).toBe(1);
  });

  it("detects Mailgun key", () => {
    const findings = scanForSecrets(`{"key": "key-1234567890abcdef1234567890abcdef"}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toMatch(/Mailgun/i);
  });

  it("detects Google API key", () => {
    const findings = scanForSecrets(`{"key": "AIzaSyC1234567890abcdefghijklmnopqrstuv"}`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toMatch(/Google/i);
  });
});
