/**
 * Post-generation secret scanner.
 *
 * Layer 2 defense: after transform.ts redacts inline, this module
 * scans the final serialized JSON for anything that slipped through.
 * Results are presented interactively — the user decides what's a
 * false alarm and what should block publishing.
 */

export interface Finding {
  rule: string;
  match: string; // the matched text (truncated for display)
  context: string; // surrounding text for context
  line: number;
}

/**
 * Named scan rules — each has a human-readable label and a regex.
 * These intentionally overlap with transform.ts patterns as a safety net.
 */
const SCAN_RULES: { id: string; label: string; pattern: RegExp }[] = [
  // Provider API keys
  { id: "openai-key", label: "OpenAI API Key", pattern: /sk-[a-zA-Z0-9_-]{20,}/g },
  { id: "anthropic-key", label: "Anthropic API Key", pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
  // GitHub
  { id: "github-pat", label: "GitHub Token", pattern: /ghp_[a-zA-Z0-9]{36,}/g },
  { id: "github-oauth", label: "GitHub OAuth Token", pattern: /gho_[a-zA-Z0-9]{36,}/g },
  {
    id: "github-pat-fine",
    label: "GitHub Fine-grained PAT",
    pattern: /github_pat_[a-zA-Z0-9_]{20,}/g,
  },
  // AWS
  { id: "aws-access-key", label: "AWS Access Key", pattern: /AKIA[A-Z0-9]{16}/g },
  // Google
  { id: "gcp-api-key", label: "Google API Key", pattern: /AIza[0-9A-Za-z_-]{35}/g },
  // Slack
  { id: "slack-token", label: "Slack Token", pattern: /xox[bpsa]-[a-zA-Z0-9-]{10,}/g },
  // Stripe
  { id: "stripe-secret", label: "Stripe Secret Key", pattern: /[sr]k_live_[a-zA-Z0-9]{20,}/g },
  { id: "stripe-publish", label: "Stripe Publishable Key", pattern: /pk_live_[a-zA-Z0-9]{20,}/g },
  // SendGrid
  {
    id: "sendgrid-key",
    label: "SendGrid API Key",
    pattern: /SG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{22,}/g,
  },
  // Twilio
  { id: "twilio-key", label: "Twilio API Key", pattern: /SK[0-9a-fA-F]{32}/g },
  // Mailgun
  { id: "mailgun-key", label: "Mailgun Private Key", pattern: /key-[a-zA-Z0-9]{32}/g },
  // JWT
  {
    id: "jwt",
    label: "JSON Web Token",
    pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
  },
  // PyPI
  { id: "pypi-token", label: "PyPI Token", pattern: /pypi-[a-zA-Z0-9_-]{50,}/g },
  // npm
  { id: "npm-token", label: "npm Token", pattern: /npm_[a-zA-Z0-9]{36,}/g },
  // Vault
  { id: "vault-token", label: "Hashicorp Vault Token", pattern: /hvs\.[a-zA-Z0-9_-]{24,}/g },
  // Age
  { id: "age-secret", label: "Age Secret Key", pattern: /AGE-SECRET-KEY-[A-Z0-9]{59}/g },
  // PEM
  {
    id: "private-key",
    label: "Private Key (PEM)",
    pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
  },
  // Bearer
  { id: "bearer-token", label: "Bearer Token", pattern: /Bearer\s+[a-zA-Z0-9_\-.]{20,}/g },
  // Database URIs with credentials
  {
    id: "db-uri",
    label: "Database Connection URI",
    pattern: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^:]+:[^@]+@[^\s"']+/gi,
  },
  // Generic high-value env vars
  {
    id: "env-secret",
    label: "Environment Secret",
    pattern:
      /(?:API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)(?![a-zA-Z])[_A-Z]*\s*[=:]\s*["']?[^\s"'\n]{8,}/gi,
  },
];

/**
 * Scan a JSON string for potential secrets.
 * Returns deduplicated findings with context.
 */
export function scanForSecrets(json: string): Finding[] {
  const lines = json.split("\n");
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const rule of SCAN_RULES) {
    // Reset regex state for each rule
    rule.pattern.lastIndex = 0;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      let m: RegExpExecArray | null;

      // Clone the regex to avoid shared state issues
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      while ((m = re.exec(line)) !== null) {
        const matched = m[0];

        // Skip already-redacted values
        if (matched.includes("[REDACTED]")) continue;

        // Deduplicate by rule+match
        const key = `${rule.id}:${matched.slice(0, 30)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Build context: 60 chars around the match
        const start = Math.max(0, m.index - 30);
        const end = Math.min(line.length, m.index + matched.length + 30);
        const context =
          (start > 0 ? "..." : "") + line.slice(start, end) + (end < line.length ? "..." : "");

        findings.push({
          rule: rule.label,
          match: matched.length > 60 ? `${matched.slice(0, 57)}...` : matched,
          context: context.slice(0, 120),
          line: lineNum + 1,
        });
      }
    }
  }

  return findings;
}
