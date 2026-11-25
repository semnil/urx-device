// Canonical signed 64-bit decimal text (K7): raw values and coordinates cross
// the native boundary as strings so that the full i64 range survives.

/** Canonical decimal text of a signed 64-bit integer, validated at runtime. */
export type I64Text = string;

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const CANONICAL = /^(0|-?[1-9][0-9]*)$/;

/**
 * Whether `value` is canonical i64 text: `0`, or an optional minus followed by
 * a nonzero digit and further digits, within the signed 64-bit range. Numbers,
 * `+`, whitespace, leading zeros, `-0`, fractions and exponents are rejected.
 */
export function isI64Text(value: unknown): value is I64Text {
  if (typeof value !== "string" || !CANONICAL.test(value)) {
    return false;
  }
  const parsed = BigInt(value);
  return parsed >= I64_MIN && parsed <= I64_MAX;
}

/** The exact integer of canonical i64 text, or undefined when it is not. */
export function parseI64(value: unknown): bigint | undefined {
  return isI64Text(value) ? BigInt(value) : undefined;
}

/** Canonical text of an integer within the i64 range, or undefined. */
export function formatI64(value: bigint): I64Text | undefined {
  return value >= I64_MIN && value <= I64_MAX ? value.toString() : undefined;
}

/** Whether `value` is a parameter or meter identifier: an integer in u32 range. */
export function isU32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}
