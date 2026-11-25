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
  channelColor,
  channelFader,
  channelName,
  channelOn,
  channelPan,
  channelPanMode,
  channelPolarity,
  channelSource,
  channelStereoLink,
} from "./channels.js";
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
/** What a write takes: the setting's `input` type when it has one, else its value type. */
type Input<K extends SettingId> = SettingTypes[K] extends { input: infer I } ? I : Value<K>;

export interface ReadHandler<K extends SettingId> {
  read(context: OperationContext, target: Target<K>): Promise<Reading<Value<K>>>;
}

export interface WriteHandler<K extends SettingId> extends ReadHandler<K> {
  /** The validated plan; it sends nothing (preview). */
  plan(model: string, target: Target<K>, value: Input<K>): WritePlan<Input<K>>;
  write(context: OperationContext, target: Target<K>, value: Input<K>): Promise<WriteResult<Input<K>>>;
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
  "channel.on": channelOn,
  "channel.fader": channelFader,
  "channel.pan": channelPan,
  "channel.polarity": channelPolarity,
  "channel.source": channelSource,
  "channel.stereo-link": channelStereoLink,
  "channel.pan-mode": channelPanMode,
  "channel.name": channelName,
  "channel.color": channelColor,
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

/** The (id, target) pairs a read takes: each ID with its own target type. */
export type ReadArgs = { [K in SettingId]: [id: K, target: Target<K>] }[SettingId];

/** The (id, target, value) triples a write takes. */
export type WriteArgs = { [K in WritableSettingId]: [id: K, target: Target<K>, value: Input<K>] }[WritableSettingId];

/**
 * Reads `id` for `target`. An ID outside the catalog, reachable only from
 * untyped input, is `invalid_input` without traffic.
 */
export function readSetting<A extends ReadArgs>(
  context: OperationContext,
  ...[id, target]: A
): Promise<Reading<Value<A[0]>>> {
  if (!Object.hasOwn(settingDefinitions, id)) {
    return unknownId();
  }
  const handler = settingHandlers[id] as unknown as ReadHandler<A[0]>;
  return settled(() => handler.read(context, target as Target<A[0]>));
}

function writeHandler<K extends WritableSettingId>(id: K): WriteHandler<K> | undefined {
  if (!Object.hasOwn(settingDefinitions, id) || !settingDefinitions[id].writable) {
    return undefined;
  }
  return settingHandlers[id] as unknown as WriteHandler<K>;
}

/** Writes `value` to `id` for `target`: its single selected request. */
export function writeSetting<A extends WriteArgs>(
  context: OperationContext,
  ...[id, target, value]: A
): Promise<WriteResult<Input<A[0]>>> {
  const handler = writeHandler(id) as WriteHandler<A[0]> | undefined;
  return handler === undefined
    ? unknownId()
    : settled(() => handler.write(context, target as Target<A[0]>, value as Input<A[0]>));
}

/** The plan a write of `value` would send, through the same validation; no traffic. */
export function previewSetting<A extends WriteArgs>(model: string, ...[id, target, value]: A): WritePlan<Input<A[0]>> {
  const handler = writeHandler(id) as WriteHandler<A[0]> | undefined;
  if (handler === undefined) {
    throw new OperationFailureError({ code: "invalid_input", phase: "preparation", progress: null });
  }
  return handler.plan(model, target as Target<A[0]>, value as Input<A[0]>);
}
