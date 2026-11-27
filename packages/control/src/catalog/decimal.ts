// Exact numeric write values (W2, C6): a write given as decimal text is range
// checked and rounded on its exact value, and so is a number, read as the
// decimal it prints as. No binary rounding sits between a request and the
// decision on it.

/**
 * A numeric write value given as decimal text (C6), for a request whose
 * digits a JavaScript number would not keep. A plan reports its requested and
 * planned values in the same form, as canonical text.
 */
export interface DecimalValue {
  readonly decimal: string;
}

/** An exact rational `n / d`, `d` positive. */
export interface Exact {
  readonly n: bigint;
  readonly d: bigint;
}

/** C6: ASCII digits, an optional leading minus, and an optional point with digits on both sides. */
const C6 = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;
/** What `Number.prototype.toString` prints for a finite number. */
const NUMBER_TEXT = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:e([+-][0-9]+))?$/;

const ONE: Exact = { n: 1n, d: 1n };
const HALF: Exact = { n: 1n, d: 2n };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

function reduced(n: bigint, d: bigint): Exact {
  const sign = d < 0n ? -1n : 1n;
  const divisor = gcd(n, d) || 1n;
  return { n: (sign * n) / divisor, d: (sign * d) / divisor };
}

/** The exact value of a sign, integer digits, fraction digits and a power of ten. */
function fromDigits(sign: string, whole: string, fraction: string, exponent: number): Exact {
  const digits = BigInt(`${whole}${fraction}`) * (sign === "-" ? -1n : 1n);
  const power = exponent - fraction.length;
  return power >= 0 ? reduced(digits * 10n ** BigInt(power), 1n) : reduced(digits, 10n ** BigInt(-power));
}

/** The exact value of C6 text (`-0` is zero), or undefined for any other text, an exponent included. */
export function parseDecimal(text: string): Exact | undefined {
  const match = C6.exec(text);
  return match === null ? undefined : fromDigits(match[1] as string, match[2] as string, match[3] ?? "", 0);
}

/** The exact value of a finite number as it prints (`0.1` is one tenth), or undefined. */
export function exactOfNumber(value: number): Exact | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const match = NUMBER_TEXT.exec(String(value));
  if (match === null) {
    return undefined;
  }
  return fromDigits(match[1] as string, match[2] as string, match[3] ?? "", Number(match[4] ?? "0"));
}

/** The exact value of a catalog constant, which is always a finite number. */
export function constant(value: number): Exact {
  const exact = exactOfNumber(value);
  if (exact === undefined) {
    throw new RangeError("a catalog constant is not finite");
  }
  return exact;
}

/** Whether `value` is a decimal write value: an object whose own `decimal` is C6 text. */
export function isDecimalValue(value: unknown): value is DecimalValue {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, "decimal")) {
    return false;
  }
  const text = (value as { decimal: unknown }).decimal;
  return typeof text === "string" && C6.test(text);
}

/**
 * A numeric write request: its exact value, and whether it was given as
 * decimal text, so a plan answers in the request's own form. Undefined for
 * anything else, a non-finite number included.
 */
export function numericRequest(value: unknown): { readonly exact: Exact; readonly decimal: boolean } | undefined {
  if (typeof value === "number") {
    const exact = exactOfNumber(value);
    return exact === undefined ? undefined : { exact, decimal: false };
  }
  if (isDecimalValue(value)) {
    return { exact: parseDecimal(value.decimal) as Exact, decimal: true };
  }
  return undefined;
}

export function compare(a: Exact, b: Exact): -1 | 0 | 1 {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function add(a: Exact, b: Exact): Exact {
  return reduced(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function subtract(a: Exact, b: Exact): Exact {
  return reduced(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function multiply(a: Exact, b: Exact): Exact {
  return reduced(a.n * b.n, a.d * b.d);
}

export function divide(a: Exact, b: Exact): Exact {
  if (b.n === 0n) {
    throw new RangeError("division by zero");
  }
  return reduced(a.n * b.d, a.d * b.n);
}

export function integer(value: bigint): Exact {
  return { n: value, d: 1n };
}

/** The greatest integer not above `a`. */
export function floor(a: Exact): bigint {
  const quotient = a.n / a.d;
  return a.n < 0n && quotient * a.d !== a.n ? quotient - 1n : quotient;
}

/**
 * The nearest integer multiple of `1 / unitsPerOne` to `value`, a tie going to
 * the lower one (W2), counted in those units.
 */
export function nearestUnits(value: Exact, unitsPerOne: Exact): bigint {
  const units = multiply(value, unitsPerOne);
  const below = floor(units);
  return compare(subtract(units, integer(below)), HALF) > 0 ? below + 1n : below;
}

/** The integer `a` is, or undefined when it has a fraction. */
export function integerOf(a: Exact): bigint | undefined {
  return a.d === 1n ? a.n : undefined;
}

/** Canonical decimal text of a value whose decimal expansion ends; throws for one that does not. */
export function formatExact(a: Exact): string {
  let rest = a.d;
  let twos = 0;
  let fives = 0;
  while (rest % 2n === 0n) {
    rest /= 2n;
    twos += 1;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    fives += 1;
  }
  if (rest !== 1n) {
    throw new RangeError("the value has no finite decimal expansion");
  }
  const places = Math.max(twos, fives);
  const scaled = (a.n * 10n ** BigInt(places)) / a.d;
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return `${negative ? "-" : ""}${whole}${places > 0 ? `.${fraction}` : ""}`;
}

/** The decimal write value of C6 text, in canonical form; undefined for any other text. */
export function decimalValue(text: string): DecimalValue | undefined {
  const exact = parseDecimal(text);
  return exact === undefined ? undefined : Object.freeze({ decimal: formatExact(exact) });
}

/** A requested value as a plan reports it: a decimal write value in canonical form, anything else as given. */
export function canonicalRequest<V>(value: V): V {
  return isDecimalValue(value) ? (Object.freeze({ decimal: formatExact(parseDecimal(value.decimal) as Exact) }) as V) : value;
}

/** `a` in a request's own form: canonical decimal text, or the number nearest to it. */
export function present(a: Exact, decimal: boolean): number | DecimalValue {
  const text = formatExact(a);
  return decimal ? Object.freeze({ decimal: text }) : Number(text);
}

export { HALF, ONE };
