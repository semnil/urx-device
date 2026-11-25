// The closed setting registry (K2-B): every catalog setting ID is bound to
// exactly one handler, typed by its definition.

import {
  settingDefinitions,
  type SettingId,
  type SettingTypes,
  type WritableSettingId,
} from "../catalog/settings.js";
import type { OperationContext } from "./context.js";
import { OperationFailureError } from "./failure.js";
import {
  inputClipSafe,
  inputClipSafeActive,
  inputGain,
  inputHiZ,
  inputPhantom,
  sourceGain,
} from "./inputs.js";
import type { Reading, WritePlan, WriteResult } from "./results.js";

type Target<K extends SettingId> = SettingTypes[K]["target"];
type Value<K extends SettingId> = SettingTypes[K]["value"];

export interface ReadHandler<K extends SettingId> {
  read(context: OperationContext, target: Target<K>): Promise<Reading<Value<K>>>;
}

export interface WriteHandler<K extends SettingId> extends ReadHandler<K> {
  /** The validated plan; it sends nothing (preview). */
  plan(model: string, target: Target<K>, value: Value<K>): WritePlan<Value<K>>;
  write(context: OperationContext, target: Target<K>, value: Value<K>): Promise<WriteResult<Value<K>>>;
}

/** One handler per setting ID, writable ones with their write path. */
export type SettingHandlers = {
  [K in SettingId]: K extends WritableSettingId ? WriteHandler<K> : ReadHandler<K>;
};

export const settingHandlers: SettingHandlers = {
  "input.gain": inputGain,
  "input.phantom": inputPhantom,
  "input.hi-z": inputHiZ,
  "input.clip-safe": inputClipSafe,
  "input.clip-safe-active": inputClipSafeActive,
  "source.gain": sourceGain,
};

function unknownId(): Promise<never> {
  return Promise.reject(new OperationFailureError({ code: "invalid_input", phase: "preparation", progress: null }));
}

/** Calls `run`, turning a synchronous validation throw into a rejection. */
function settled<T>(run: () => Promise<T>): Promise<T> {
  try {
    return run();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Reads `id` for `target`. An ID outside the catalog, reachable only from
 * untyped input, is `invalid_input` without traffic.
 */
export function readSetting<K extends SettingId>(
  context: OperationContext,
  id: K,
  target: Target<K>,
): Promise<Reading<Value<K>>> {
  if (!Object.hasOwn(settingDefinitions, id)) {
    return unknownId();
  }
  const handler = settingHandlers[id] as ReadHandler<K>;
  return settled(() => handler.read(context, target));
}

function writeHandler<K extends WritableSettingId>(id: K): WriteHandler<K> | undefined {
  if (!Object.hasOwn(settingDefinitions, id) || !settingDefinitions[id].writable) {
    return undefined;
  }
  return settingHandlers[id] as unknown as WriteHandler<K>;
}

/** Writes `value` to `id` for `target`: its single selected request. */
export function writeSetting<K extends WritableSettingId>(
  context: OperationContext,
  id: K,
  target: Target<K>,
  value: Value<K>,
): Promise<WriteResult<Value<K>>> {
  const handler = writeHandler(id);
  return handler === undefined ? unknownId() : settled(() => handler.write(context, target, value));
}

/** The plan a write of `value` would send, through the same validation; no traffic. */
export function previewSetting<K extends WritableSettingId>(
  model: string,
  id: K,
  target: Target<K>,
  value: Value<K>,
): WritePlan<Value<K>> {
  const handler = writeHandler(id);
  if (handler === undefined) {
    throw new OperationFailureError({ code: "invalid_input", phase: "preparation", progress: null });
  }
  return handler.plan(model, target, value);
}
