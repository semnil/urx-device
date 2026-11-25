// Physical input (F02-B) and source gain (F03-G) handlers: validate the
// model and target, send the single request selected for the setting, and
// report the actual result. No related-state reads, no readback.

import { decodeCentiDb, decodeSwitch, encodeCentiDb, encodeSwitch, planWholeDb } from "../catalog/codecs.js";
import {
  HI_Z_JACKS,
  INPUT_GAIN_DB,
  INPUT_JACKS,
  INPUT_PARAMS,
  SOURCE_GAIN,
  SOURCE_GAIN_DB,
  isSourceToken,
} from "../catalog/inputs.js";
import type { InputTarget, SourceTarget } from "../catalog/settings.js";
import type { OperationContext } from "./context.js";
import type { Reading, WritePlan, WriteResult } from "./results.js";
import { address, modelOf, readDecoded, refuse, targetOf, writeRaw } from "./setting-io.js";

/** The jack index of a target valid on `model`; `hiZ` also requires HI-Z. */
function jackOf(model: string, target: unknown, hiZ = false): number {
  const known = modelOf(model);
  const input = targetOf<InputTarget>(target, ["input"]).input;
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
  const source = targetOf<SourceTarget>(target, ["source"]).source;
  if (!isSourceToken(source)) {
    return refuse("invalid_input");
  }
  const entry = SOURCE_GAIN[source];
  return entry.models.includes(known) ? entry : refuse("unsupported_operation");
}

/** A switch setting on a physical jack. */
function inputSwitch(paramId: number, hiZ = false) {
  const plan = (model: string, target: InputTarget, value: boolean): WritePlan<boolean> & { jack: number } => {
    const jack = jackOf(model, target, hiZ);
    return typeof value === "boolean" ? { requested: value, planned: value, jack } : refuse("invalid_input");
  };
  return {
    read(context: OperationContext, target: InputTarget): Promise<Reading<boolean>> {
      return readDecoded(context, address(paramId, jackOf(context.model, target, hiZ)), decodeSwitch);
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
  read(context: OperationContext, target: InputTarget): Promise<Reading<number>> {
    return readDecoded(context, address(INPUT_PARAMS.gain, jackOf(context.model, target)), (raw) =>
      decodeCentiDb(raw, INPUT_GAIN_DB.min, INPUT_GAIN_DB.max),
    );
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
  read(context: OperationContext, target: InputTarget): Promise<Reading<boolean>> {
    return readDecoded(context, address(INPUT_PARAMS.clipSafeActive, jackOf(context.model, target)), decodeSwitch);
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
  read(context: OperationContext, target: SourceTarget): Promise<Reading<number>> {
    const source = sourceOf(context.model, target);
    // The first catalog instance only; not a claim about both lanes.
    return readDecoded(context, address(source.paramId, source.instances[0] as number), (raw) =>
      decodeCentiDb(raw, SOURCE_GAIN_DB.min, SOURCE_GAIN_DB.max),
    );
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
