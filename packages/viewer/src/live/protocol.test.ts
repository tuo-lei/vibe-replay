import { describe, expect, it } from "vitest";
import { BOX_ID_RE, KEY_RE, b64urlDecode, b64urlEncode, boxIdFromPath } from "./protocol";

describe("b64url helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
  });

  it("produces URL-safe output (no +/= characters)", () => {
    // 0xfb 0xff 0xfe encodes with + and / in standard base64
    const out = b64urlEncode(new Uint8Array([0xfb, 0xff, 0xfe, 0xfb]));
    expect(out).not.toMatch(/[+/=]/);
    expect(b64urlDecode(out)).toEqual(new Uint8Array([0xfb, 0xff, 0xfe, 0xfb]));
  });

  it("decodes unpadded input", () => {
    expect(b64urlDecode(b64urlEncode(new Uint8Array([1, 2, 3, 4, 5])))).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
  });
});

describe("boxIdFromPath", () => {
  it("extracts a valid 22-char box id from /live/<id>", () => {
    expect(boxIdFromPath("/live/x2KJPqQxznNNftBLSHV5jA")).toBe("x2KJPqQxznNNftBLSHV5jA");
  });

  it("rejects invalid paths", () => {
    expect(boxIdFromPath("/live/too-short")).toBeNull();
    expect(boxIdFromPath("/live/")).toBeNull();
    expect(boxIdFromPath("/")).toBeNull();
    expect(boxIdFromPath("/live/x2KJPqQxznNNftBLSHV5jA/extra")).toBeNull();
  });
});

describe("key/box id shapes", () => {
  it("accepts a 43-char base64url key", () => {
    expect(KEY_RE.test("7-Q6YnyzITT66759Cb4PZcCjlzXobfbK_3QKavTr2Nc")).toBe(true);
    expect(KEY_RE.test("short")).toBe(false);
    expect(KEY_RE.test("7-Q6YnyzITT66759Cb4PZcCjlzXobfbK_3QKavTr2Nc!")).toBe(false);
  });

  it("accepts a 22-char base64url box id", () => {
    expect(BOX_ID_RE.test("x2KJPqQxznNNftBLSHV5jA")).toBe(true);
    expect(BOX_ID_RE.test("x2KJPqQxznNNftBLSHV5j")).toBe(false);
  });
});
