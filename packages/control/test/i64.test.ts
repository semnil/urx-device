import { describe, expect, it } from "vitest";
import { formatI64, isI64Text, isU32, parseI64 } from "../src/catalog/i64.js";

describe("i64 text (K7)", () => {
  it("accepts canonical text across the full signed 64-bit range", () => {
    for (const text of ["0", "1", "-1", "9223372036854775807", "-9223372036854775808", "123"]) {
      expect(isI64Text(text), text).toBe(true);
    }
    expect(parseI64("9223372036854775807")).toBe(2n ** 63n - 1n);
    expect(parseI64("-9223372036854775808")).toBe(-(2n ** 63n));
  });

  it("rejects non-canonical text, numbers and values one past either end", () => {
    for (const value of [
      "9223372036854775808",
      "-9223372036854775809",
      "-0",
      "00",
      "01",
      "+1",
      " 1",
      "1 ",
      "1.0",
      "1e3",
      "",
      "-",
      "0x10",
      "１",
      1,
      1n,
      null,
      undefined,
    ]) {
      expect(isI64Text(value), String(value)).toBe(false);
      expect(parseI64(value)).toBeUndefined();
    }
  });

  it("formats only integers within range", () => {
    expect(formatI64(-(2n ** 63n))).toBe("-9223372036854775808");
    expect(formatI64(2n ** 63n)).toBeUndefined();
    expect(formatI64(-(2n ** 63n) - 1n)).toBeUndefined();
  });

  it("accepts u32 identifiers only as integers in range", () => {
    expect(isU32(0)).toBe(true);
    expect(isU32(0xffff_ffff)).toBe(true);
    for (const value of [-1, 2 ** 32, 1.5, Number.NaN, Infinity, "1"]) {
      expect(isU32(value), String(value)).toBe(false);
    }
  });
});
