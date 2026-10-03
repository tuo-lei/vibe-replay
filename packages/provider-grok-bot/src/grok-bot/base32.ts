/** RFC 4648 base32 (no padding). Filenames are matched case-insensitively. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(input: string): string {
  const bytes = Buffer.from(input, "utf8");
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.toLowerCase();
}

export function decodeBase32(input: string): string | undefined {
  const clean = input.trim().replace(/=+$/g, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) return undefined;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) return undefined;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
