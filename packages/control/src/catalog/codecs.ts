// Raw value codecs shared by setting definitions (K7, W2). Reads decode the
// actual raw value without rounding or clamping; writes validate, then
// quantize, then encode exactly.

import { compare, constant, divide, exactOfNumber, integer, multiply, nearestUnits, present, type Exact } from "./decimal.js";
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
  return planOnGrid(requested, minDb, maxDb, 1);
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
 * The planned value of `requested` on a grid of `unitsPerOne` steps per
 * public unit: range checked first, then the nearest grid value with ties
 * toward the lower one (W2), all on exact values.
 */
export function planOnGridExact(requested: Exact, min: Exact, max: Exact, unitsPerOne: Exact): Exact | undefined {
  if (compare(requested, min) < 0 || compare(requested, max) > 0) {
    return undefined;
  }
  return divide(integer(nearestUnits(requested, unitsPerOne)), unitsPerOne);
}

/**
 * `planOnGridExact` for a number, read as the decimal it prints as: finite
 * and within [min, max] before rounding, or undefined.
 */
export function planOnGrid(requested: number, min: number, max: number, unitsPerOne: number): number | undefined {
  const exact = exactOfNumber(requested);
  const planned = exact === undefined ? undefined : planOnGridExact(exact, constant(min), constant(max), constant(unitsPerOne));
  return planned === undefined ? undefined : (present(planned, false) as number);
}

/** The integer of raw text within [min, max], or undefined. */
export function decodeInteger(raw: I64Text, min: number, max: number): number | undefined {
  const value = parseI64(raw);
  return value === undefined || value < BigInt(min) || value > BigInt(max) ? undefined : Number(value);
}

/**
 * The index of the stop nearest to `requested`, the stops given in units of
 * 1 / `scale` and increasing; a tie goes to the lower stop. Compared with each
 * exact midpoint, so decimal steps carry no binary noise.
 */
export function nearestStopIndexExact(stops: readonly number[], scale: number, requested: Exact): number {
  const twice = multiply(constant(scale), integer(2n));
  let index = 0;
  while (index + 1 < stops.length) {
    const midpoint = divide(constant((stops[index] as number) + (stops[index + 1] as number)), twice);
    if (compare(requested, midpoint) <= 0) {
      break;
    }
    index += 1;
  }
  return index;
}

/** `nearestStopIndexExact` for a finite number, read as the decimal it prints as. */
export function nearestStopIndex(stops: readonly number[], scale: number, requested: number): number {
  const exact = exactOfNumber(requested);
  if (exact === undefined) {
    throw new RangeError("a stop request is not finite");
  }
  return nearestStopIndexExact(stops, scale, exact);
}
