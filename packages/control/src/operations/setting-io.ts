// Shared read/write steps of setting handlers: refusals before traffic, a
// single numeric read decoded with its receipt time, and a single write
// reported with its actual outcome (K3, K34, W1).

import type { I64Text } from "../catalog/i64.js";
import type { ChannelName } from "../catalog/settings.js";
import { isModel, type Model } from "../catalog/models.js";
import type { OperationContext, Received } from "./context.js";
import { OperationFailureError, type OperationCause } from "./failure.js";
import type { NativeFailure, NativePostResult, NativeReadResult, PostEvidence } from "./native.js";
import type { Reading, WriteOutcome, WritePlan, WriteProgress, WriteResult } from "./results.js";
import type { ParameterAddress } from "./transport.js";

export function refuse(code: OperationCause): never {
  throw new OperationFailureError({ code, phase: "preparation", progress: null });
}

/**
 * `target` as a plain object whose own keys are among `allowed`, or a
 * refusal: no inherited, extra or array-borne selectors reach an address.
 */
export function targetOf<T>(target: unknown, allowed: readonly string[]): T {
  if (typeof target !== "object" || target === null || Object.getPrototypeOf(target) !== Object.prototype) {
    return refuse("invalid_input");
  }
  // Every own key, non-enumerable and symbol ones included.
  const keys = Reflect.ownKeys(target);
  if (!keys.every((key) => typeof key === "string" && allowed.includes(key))) {
    return refuse("invalid_input");
  }
  // A fresh object of the own values only: nothing inherited is read later.
  // With no prototype, so even a polluted Object.prototype is not read.
  const own: Record<string, unknown> = Object.create(null);
  for (const key of allowed) {
    if (Object.hasOwn(target, key)) {
      own[key] = (target as Record<string, unknown>)[key];
    }
  }
  return own as T;
}

export function modelOf(model: string): Model {
  return isModel(model) ? model : refuse("unsupported_operation");
}

export function address(paramId: number, y: number): ParameterAddress {
  return { paramId, x: "0", y: `${y}` };
}

/** The value of a read and its receipt time, or the failure it reports. */
async function readValue<T>(
  context: OperationContext,
  received: Promise<Received<NativeReadResult<T>>>,
): Promise<{ raw: T; observedAt: string }> {
  const { record, observedAt } = await received;
  if (record.kind === "failure") {
    throw context.failureOf(record, null);
  }
  if (observedAt === undefined) {
    // The slot is already handled; a value without its time is not delivered.
    throw new OperationFailureError({ code: "internal_error", phase: "delivery", progress: null });
  }
  return { raw: record.value, observedAt };
}

function decoded<V>(value: V | undefined, observedAt: string): Reading<V> {
  if (value === undefined) {
    // A raw value outside the definition is malformed, not a default.
    throw new OperationFailureError({ code: "invalid_response", phase: "response", progress: null });
  }
  return { value, observedAt };
}

export async function readDecoded<V>(
  context: OperationContext,
  at: ParameterAddress,
  decode: (raw: I64Text) => V | undefined,
): Promise<Reading<V>> {
  const { raw, observedAt } = await readValue(context, context.getNumeric(at));
  return decoded(decode(raw), observedAt);
}

/** The single text read of `at` (a string parameter), decoded like `readDecoded`. */
export async function readTextDecoded<V>(
  context: OperationContext,
  at: ParameterAddress,
  decode: (text: string) => V | undefined,
): Promise<Reading<V>> {
  const { raw, observedAt } = await readValue(context, context.getText(at));
  return decoded(decode(raw), observedAt);
}

/** The single name read of `at` (F03-K): received text as is, or a numeric preset index. */
export async function readName(context: OperationContext, at: ParameterAddress): Promise<Reading<ChannelName>> {
  const { raw, observedAt } = await readValue(context, context.getName(at));
  // Received as is: not clipped, trimmed or normalized.
  const value: ChannelName = raw.kind === "text" ? { kind: "text", text: raw.value } : { kind: "preset", presetIndex: raw.value };
  return { value, observedAt };
}

function outcomeOf(evidence: PostEvidence): WriteOutcome {
  switch (evidence.state) {
    case "not_sent":
      return "not_sent";
    case "unconfirmed":
      return "uncertain";
    case "rejected":
      return "rejected";
    case "accepted":
      return "accepted";
  }
}

/** The single write of `plan` to `at` and its actual result (W1). */
export async function writeRaw<V>(
  context: OperationContext,
  at: ParameterAddress,
  raw: I64Text,
  plan: WritePlan<V>,
): Promise<WriteResult<V>> {
  return writeWith(context, () => context.setNumeric(at, raw), plan);
}

/** The single text write of `text` to `at` (a string parameter), reported like `writeRaw`. */
export function writeText<V>(
  context: OperationContext,
  at: ParameterAddress,
  text: string,
  plan: WritePlan<V>,
): Promise<WriteResult<V>> {
  return writeWith(context, () => context.setText(at, text), plan);
}

async function writeWith<V>(
  context: OperationContext,
  send: () => Promise<NativePostResult>,
  plan: WritePlan<V>,
): Promise<WriteResult<V>> {
  let record: NativePostResult;
  try {
    record = await send();
  } catch (error) {
    // No trusted record: unsent when it failed before the request was
    // handed over, otherwise possibly sent (K34). The plan is kept.
    const failure = error instanceof OperationFailureError ? error.failure : undefined;
    const outcome: WriteOutcome = failure?.phase === "admission" ? "not_sent" : "uncertain";
    throw new OperationFailureError<WriteProgress<V>>({
      code: failure?.code ?? "internal_error",
      phase: failure?.phase ?? "delivery",
      progress: { ...plan, outcome },
    });
  }
  if (record.kind === "success") {
    return { ...plan, outcome: "accepted" };
  }
  const failure = record as NativeFailure<PostEvidence>;
  const progress: WriteProgress<V> = {
    ...plan,
    outcome: outcomeOf(failure.evidence),
    ...(failure.evidence.state === "rejected" ? { responseCode: failure.evidence.responseCode } : {}),
  };
  throw context.failureOf(failure, progress);
}

