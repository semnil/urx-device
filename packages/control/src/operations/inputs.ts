// Physical input (F02-B) and source gain (F03-G) handlers: validate the
// model and target, send the single request selected for the setting, and
// report the actual result. No related-state reads, no readback.

import { decodeCentiDb, decodeSwitch, encodeCentiDb, encodeSwitch, planWholeDb } from "../catalog/codecs.js";
import type { I64Text } from "../catalog/i64.js";
import {
  HI_Z_JACKS,
  INPUT_GAIN_DB,
  INPUT_JACKS,
  INPUT_PARAMS,
  SOURCE_GAIN,
  SOURCE_GAIN_DB,
  isSourceToken,
} from "../catalog/inputs.js";
import { isModel, type Model } from "../catalog/models.js";
import type { InputTarget, SourceTarget } from "../catalog/settings.js";
import type { OperationContext } from "./context.js";
import { OperationFailureError, type OperationCause } from "./failure.js";
import type { NativeFailure, NativePostResult, PostEvidence } from "./native.js";
import type { Reading, WriteOutcome, WritePlan, WriteProgress, WriteResult } from "./results.js";
import type { ParameterAddress } from "./transport.js";

function refuse(code: OperationCause): never {
  throw new OperationFailureError({ code, phase: "preparation", progress: null });
}

function modelOf(model: string): Model {
  return isModel(model) ? model : refuse("unsupported_operation");
}

function address(paramId: number, y: number): ParameterAddress {
  return { paramId, x: "0", y: `${y}` };
}

/** The jack index of a target valid on `model`; `hiZ` also requires HI-Z. */
function jackOf(model: string, target: unknown, hiZ = false): number {
  const known = modelOf(model);
  const input = (target as InputTarget | null)?.input;
  if (typeof input !== "number" || !INPUT_JACKS[known].includes(input)) {
    return refuse("invalid_input");
  }
  if (hiZ && !HI_Z_JACKS[known].includes(input)) {
    return refuse("unsupported_operation");
  }
  return input - 1;
}

function sourceOf(model: string, target: unknown): (typeof SOURCE_GAIN)[keyof typeof SOURCE_GAIN] {
  const known = modelOf(model);
  const source = (target as SourceTarget | null)?.source;
  if (!isSourceToken(source)) {
    return refuse("invalid_input");
  }
  const entry = SOURCE_GAIN[source];
  return entry.models.includes(known) ? entry : refuse("unsupported_operation");
}

/** The read-only value of a numeric read, or the failure it reports. */
async function readRaw(context: OperationContext, at: ParameterAddress): Promise<I64Text> {
  const record = await context.getNumeric(at);
  if (record.kind === "failure") {
    throw context.failureOf(record, null);
  }
  return record.value;
}

function decoded<V>(value: V | undefined, context: OperationContext): Reading<V> {
  if (value === undefined) {
    // A raw value outside the definition is malformed, not a default.
    throw new OperationFailureError({ code: "invalid_response", phase: "response", progress: null });
  }
  return { value, observedAt: context.now() };
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
async function writeRaw<V>(
  context: OperationContext,
  at: ParameterAddress,
  raw: I64Text,
  plan: WritePlan<V>,
): Promise<WriteResult<V>> {
  const record: NativePostResult = await context.setNumeric(at, raw);
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

/** A switch setting on a physical jack. */
function inputSwitch(paramId: number, hiZ = false) {
  const plan = (model: string, target: InputTarget, value: boolean): WritePlan<boolean> & { jack: number } => {
    const jack = jackOf(model, target, hiZ);
    return typeof value === "boolean" ? { requested: value, planned: value, jack } : refuse("invalid_input");
  };
  return {
    async read(context: OperationContext, target: InputTarget): Promise<Reading<boolean>> {
      const raw = await readRaw(context, address(paramId, jackOf(context.model, target, hiZ)));
      return decoded(decodeSwitch(raw), context);
    },
    plan(model: string, target: InputTarget, value: boolean): WritePlan<boolean> {
      const { requested, planned } = plan(model, target, value);
      return { requested, planned };
    },
    write(context: OperationContext, target: InputTarget, value: boolean): Promise<WriteResult<boolean>> {
      const { jack, ...written } = plan(context.model, target, value);
      return writeRaw(context, address(paramId, jack), encodeSwitch(written.planned), written);
    },
  };
}

function inputGainPlan(model: string, target: InputTarget, value: number) {
  const jack = jackOf(model, target);
  const planned = typeof value === "number" ? planWholeDb(value, INPUT_GAIN_DB.min, INPUT_GAIN_DB.max) : undefined;
  return planned === undefined ? refuse("invalid_input") : { requested: value, planned, jack };
}

export const inputGain = {
  async read(context: OperationContext, target: InputTarget): Promise<Reading<number>> {
    const raw = await readRaw(context, address(INPUT_PARAMS.gain, jackOf(context.model, target)));
    return decoded(decodeCentiDb(raw, INPUT_GAIN_DB.min, INPUT_GAIN_DB.max), context);
  },
  plan(model: string, target: InputTarget, value: number): WritePlan<number> {
    const { requested, planned } = inputGainPlan(model, target, value);
    return { requested, planned };
  },
  write(context: OperationContext, target: InputTarget, value: number): Promise<WriteResult<number>> {
    const { jack, ...written } = inputGainPlan(context.model, target, value);
    return writeRaw(context, address(INPUT_PARAMS.gain, jack), encodeCentiDb(written.planned), written);
  },
};

export const inputPhantom = inputSwitch(INPUT_PARAMS.phantom);
export const inputHiZ = inputSwitch(INPUT_PARAMS.hiZ, true);
export const inputClipSafe = inputSwitch(INPUT_PARAMS.clipSafe);

export const inputClipSafeActive = {
  async read(context: OperationContext, target: InputTarget): Promise<Reading<boolean>> {
    const raw = await readRaw(context, address(INPUT_PARAMS.clipSafeActive, jackOf(context.model, target)));
    return decoded(decodeSwitch(raw), context);
  },
};

function sourceGainPlan(model: string, target: SourceTarget, value: number) {
  const source = sourceOf(model, target);
  const planned = typeof value === "number" ? planWholeDb(value, SOURCE_GAIN_DB.min, SOURCE_GAIN_DB.max) : undefined;
  if (planned === undefined) {
    return refuse("invalid_input");
  }
  // A write sequence still needing evidence is not implemented (F03-G).
  const writes = source.writes;
  if (writes?.length !== 1) {
    return refuse("unsupported_operation");
  }
  return { requested: value, planned, paramId: source.paramId, y: writes[0] as number };
}

export const sourceGain = {
  async read(context: OperationContext, target: SourceTarget): Promise<Reading<number>> {
    const source = sourceOf(context.model, target);
    // The first catalog instance only; not a claim about both lanes.
    const raw = await readRaw(context, address(source.paramId, source.instances[0] as number));
    return decoded(decodeCentiDb(raw, SOURCE_GAIN_DB.min, SOURCE_GAIN_DB.max), context);
  },
  plan(model: string, target: SourceTarget, value: number): WritePlan<number> {
    const { requested, planned } = sourceGainPlan(model, target, value);
    return { requested, planned };
  },
  write(context: OperationContext, target: SourceTarget, value: number): Promise<WriteResult<number>> {
    const { paramId, y, ...written } = sourceGainPlan(context.model, target, value);
    return writeRaw(context, address(paramId, y), encodeCentiDb(written.planned), written);
  },
};
