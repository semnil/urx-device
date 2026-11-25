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
  channelRecPoint,
  channelSource,
  channelStereoLink,
} from "./channels.js";
import {
  compAttack,
  compAutoMakeup,
  compGain,
  compKnee,
  compOneKnobLevel,
  compOneKnobOn,
  compRatio,
  compRelease,
  compThreshold,
  gateAttack,
  gateDecay,
  gateHold,
  gateRange,
  gateThreshold,
} from "./dynamics.js";
import {
  compOn,
  eqOn,
  gateOn,
  hpfFrequency,
  hpfOn,
  processingMode,
  ssmcsCompOn,
  ssmcsEqOn,
  ssmcsOn,
} from "./processing.js";
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
// Distributed over K, so a union of IDs keeps each ID's own write type.
type Input<K extends SettingId> = K extends SettingId
  ? SettingTypes[K] extends { input: infer I }
    ? I
    : Value<K>
  : never;

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
  "channel.rec-point": channelRecPoint,
  "channel.processing-mode": processingMode,
  "channel.hpf.on": hpfOn,
  "channel.hpf.frequency": hpfFrequency,
  "channel.gate.on": gateOn,
  "channel.comp.on": compOn,
  "channel.eq.on": eqOn,
  "channel.ssmcs.on": ssmcsOn,
  "channel.ssmcs.comp.on": ssmcsCompOn,
  "channel.ssmcs.eq.on": ssmcsEqOn,
  "channel.gate.threshold": gateThreshold,
  "channel.gate.range": gateRange,
  "channel.gate.attack": gateAttack,
  "channel.gate.hold": gateHold,
  "channel.gate.decay": gateDecay,
  "channel.comp.threshold": compThreshold,
  "channel.comp.ratio": compRatio,
  "channel.comp.knee": compKnee,
  "channel.comp.gain": compGain,
  "channel.comp.attack": compAttack,
  "channel.comp.release": compRelease,
  "channel.comp.auto-makeup": compAutoMakeup,
  "channel.comp.one-knob.on": compOneKnobOn,
  "channel.comp.one-knob.level": compOneKnobLevel,
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

type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;

/** A target every ID of `K` takes; for a single ID, its own target. */
export type CommonTarget<K extends SettingId> = Intersection<K extends SettingId ? Target<K> : never>;

/** A value every ID of `K` takes as a write; for a single ID, its own input. */
export type CommonInput<K extends WritableSettingId> = Intersection<K extends WritableSettingId ? Input<K> : never>;

/** The (id, target) pairs a read takes: each ID with its own target type. */
export type ReadArgs = { [K in SettingId]: [id: K, target: Target<K>] }[SettingId];

/** The (id, target, value) triples a write takes. */
export type WriteArgs = { [K in WritableSettingId]: [id: K, target: Target<K>, value: Input<K>] }[WritableSettingId];

/**
 * Reads `id` for `target`. An ID outside the catalog, reachable only from
 * untyped input, is `invalid_input` without traffic.
 */
export function readSetting<A extends ReadArgs>(context: OperationContext, ...args: A): Promise<Reading<Value<A[0]>>>;
/** Reads one of the IDs `K` with a target all of them take (a list of settings read alike). */
export function readSetting<K extends SettingId>(
  context: OperationContext,
  id: K,
  target: CommonTarget<K>,
): Promise<Reading<Value<K>>>;
export function readSetting(context: OperationContext, id: SettingId, target: unknown): Promise<Reading<unknown>> {
  if (!Object.hasOwn(settingDefinitions, id)) {
    return unknownId();
  }
  const handler = settingHandlers[id] as unknown as ReadHandler<SettingId>;
  return settled(() => handler.read(context, target as Target<SettingId>));
}

function writeHandler<K extends WritableSettingId>(id: K): WriteHandler<K> | undefined {
  if (!Object.hasOwn(settingDefinitions, id) || !settingDefinitions[id].writable) {
    return undefined;
  }
  return settingHandlers[id] as unknown as WriteHandler<K>;
}

/** Writes `value` to `id` for `target`: its single selected request. */
export function writeSetting<A extends WriteArgs>(context: OperationContext, ...args: A): Promise<WriteResult<Input<A[0]>>>;
/** Writes one of the IDs `K` with a target and value all of them take. */
export function writeSetting<K extends WritableSettingId>(
  context: OperationContext,
  id: K,
  target: CommonTarget<K>,
  value: CommonInput<K>,
): Promise<WriteResult<Input<K>>>;
export function writeSetting(
  context: OperationContext,
  id: WritableSettingId,
  target: unknown,
  value: unknown,
): Promise<WriteResult<unknown>> {
  const handler = writeHandler(id) as WriteHandler<WritableSettingId> | undefined;
  return handler === undefined
    ? unknownId()
    : settled(() => handler.write(context, target as Target<WritableSettingId>, value as Input<WritableSettingId>));
}

/** The plan a write of `value` would send, through the same validation; no traffic. */
export function previewSetting<A extends WriteArgs>(model: string, ...args: A): WritePlan<Input<A[0]>>;
/** The plan for one of the IDs `K` with a target and value all of them take. */
export function previewSetting<K extends WritableSettingId>(
  model: string,
  id: K,
  target: CommonTarget<K>,
  value: CommonInput<K>,
): WritePlan<Input<K>>;
export function previewSetting(model: string, id: WritableSettingId, target: unknown, value: unknown): WritePlan<unknown> {
  const handler = writeHandler(id) as WriteHandler<WritableSettingId> | undefined;
  if (handler === undefined) {
    throw new OperationFailureError({ code: "invalid_input", phase: "preparation", progress: null });
  }
  return handler.plan(model, target as Target<WritableSettingId>, value as Input<WritableSettingId>);
}
