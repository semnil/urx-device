// Raw value codecs shared by setting definitions (K7, W2). Reads decode the
// actual raw value without rounding or clamping; writes validate, then
// quantize, then encode exactly.

import { formatI64, parseI64, type I64Text } from "./i64.js";

/**
 * The dB value of raw centi-dB within [minDb, maxDb], unrounded; undefined
 * when the raw value is outside that range (a malformed observation).
 */
export function decodeCentiDb(raw: I64Text, minDb: number, maxDb: number): number | undefined {
  const value = parseI64(raw);
  if (value === undefined || value < BigInt(minDb * 100) || value > BigInt(maxDb * 100)) {
    return undefined;
  }
  return Number(value) / 100;
}

/**
 * The planned whole-dB value for a requested one: finite and within
 * [minDb, maxDb] before rounding, then the nearest whole dB with ties toward
 * the lower value (W2). Undefined when the request is not admissible.
 */
export function planWholeDb(requested: number, minDb: number, maxDb: number): number | undefined {
  if (!Number.isFinite(requested) || requested < minDb || requested > maxDb) {
    return undefined;
  }
  // Nearest integer, a tie going down. Compared with the exact midpoint, so
  // no subtraction rounds a value just above it onto it.
  const floor = Math.floor(requested);
  const planned = requested > floor + 0.5 ? floor + 1 : floor;
  return Object.is(planned, -0) ? 0 : planned;
}

/** Raw centi-dB text of a whole-dB value. */
export function encodeCentiDb(db: number): I64Text {
  const text = formatI64(BigInt(db) * 100n);
  if (text === undefined) {
    throw new RangeError("centi-dB outside the i64 range");
  }
  return text;
}

/** A switch's raw value: exactly 0 or 1, nothing else. */
export function decodeSwitch(raw: I64Text): boolean | undefined {
  return raw === "1" ? true : raw === "0" ? false : undefined;
}

export function encodeSwitch(on: boolean): I64Text {
  return on ? "1" : "0";
}

/**
 * The planned value of `requested` on a grid of `step` (a power of ten
 * fraction such as 0.01): range checked first, then the nearest grid value
 * with ties toward the lower one, computed in integer grid units (W2).
 */
export function planOnGrid(requested: number, min: number, max: number, unitsPerOne: number): number | undefined {
  if (!Number.isFinite(requested) || requested < min || requested > max) {
    return undefined;
  }
  const floor = Math.floor(requested * unitsPerOne);
  // Compared with the midpoint in the request's own unit, so only a value
  // above it goes up; the midpoint itself goes down.
  const midpoint = (floor + 0.5) / unitsPerOne;
  const units = requested > midpoint ? floor + 1 : floor;
  const planned = units / unitsPerOne;
  return Object.is(planned, -0) ? 0 : planned;
}

/** The integer of raw text within [min, max], or undefined. */
export function decodeInteger(raw: I64Text, min: number, max: number): number | undefined {
  const value = parseI64(raw);
  return value === undefined || value < BigInt(min) || value > BigInt(max) ? undefined : Number(value);
}

/**
 * The index of the stop nearest to `requested`, the stops given in units of
 * 1 / `scale` and increasing; a tie goes to the lower stop. Compared with each
 * midpoint in the request's own unit, so decimal steps carry no binary noise.
 */
export function nearestStopIndex(stops: readonly number[], scale: number, requested: number): number {
  let index = 0;
  while (index + 1 < stops.length && requested > ((stops[index] as number) + (stops[index + 1] as number)) / 2 / scale) {
    index += 1;
  }
  return index;
}
