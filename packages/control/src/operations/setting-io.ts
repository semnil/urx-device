// Shared read/write steps of setting handlers: refusals before traffic, a
// single numeric read decoded with its receipt time, and a single write
// reported with its actual outcome (K3, K34, W1).

import type { I64Text } from "../catalog/i64.js";
import { isModel, type Model } from "../catalog/models.js";
import type { OperationContext } from "./context.js";
import { OperationFailureError, type OperationCause } from "./failure.js";
import type { NativeFailure, NativePostResult, PostEvidence } from "./native.js";
import type { Reading, WriteOutcome, WritePlan, WriteProgress, WriteResult } from "./results.js";
import type { ParameterAddress } from "./transport.js";

export function refuse(code: OperationCause): never {
  throw new OperationFailureError({ code, phase: "preparation", progress: null });
}

export function modelOf(model: string): Model {
  return isModel(model) ? model : refuse("unsupported_operation");
}

export function address(paramId: number, y: number): ParameterAddress {
  return { paramId, x: "0", y: `${y}` };
}

/** The raw value of a numeric read and its receipt time, or the failure it reports. */
async function readRaw(context: OperationContext, at: ParameterAddress): Promise<{ raw: I64Text; observedAt: string }> {
  const { record, observedAt } = await context.getNumeric(at);
  if (record.kind === "failure") {
    throw context.failureOf(record, null);
  }
  if (observedAt === undefined) {
    // The slot is already handled; a value without its time is not delivered.
    throw new OperationFailureError({ code: "internal_error", phase: "delivery", progress: null });
  }
  return { raw: record.value, observedAt };
}

export async function readDecoded<V>(
  context: OperationContext,
  at: ParameterAddress,
  decode: (raw: I64Text) => V | undefined,
): Promise<Reading<V>> {
  const { raw, observedAt } = await readRaw(context, at);
  const value = decode(raw);
  if (value === undefined) {
    // A raw value outside the definition is malformed, not a default.
    throw new OperationFailureError({ code: "invalid_response", phase: "response", progress: null });
  }
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

