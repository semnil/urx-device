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
  eqBandFrequency,
  eqBandGain,
  eqBandOn,
  eqBandQ,
  eqBandType,
  eqOneKnobLevel,
  eqOneKnobOn,
  eqOneKnobType,
} from "./eq.js";
import {
  ssmcsCompAttack,
  ssmcsCompDrive,
  ssmcsCompKnee,
  ssmcsCompRatio,
  ssmcsCompRelease,
  ssmcsEqBandFrequency,
  ssmcsEqBandGain,
  ssmcsEqBandOn,
  ssmcsEqBandQ,
  ssmcsMorphing,
  ssmcsOutputGain,
  ssmcsPreset,
  ssmcsSidechainFrequency,
  ssmcsSidechainGain,
  ssmcsSidechainOn,
  ssmcsSidechainQ,
} from "./ssmcs.js";
import {
  duckerAttack,
  duckerDecay,
  duckerKeySource,
  duckerOn,
  duckerRange,
  duckerThreshold,
} from "./ducker.js";
import { sendLevel, sendOn, sendPan, sendTap } from "./sends.js";
import {
  busBalance,
  busColor,
  busFader,
  busName,
  busOn,
  busPanLink,
  busStereoAssign,
  busType,
  channelStereoAssign,
} from "./buses.js";
import { busInsertFxOn, busInsertFxType, channelInsertFxOn, channelInsertFxType } from "./insert-fx.js";
import { busFxParameter, busFxType } from "./fx-return.js";
import { busEqOn, busEqType, busGeqGain, busGeqLimit, busGeqLink, busGeqOn } from "./output-eq.js";
import {
  busPeqBandFrequency,
  busPeqBandGain,
  busPeqBandOn,
  busPeqBandQ,
  busPeqBandType,
  busPeqOneKnobLevel,
  busPeqOneKnobOn,
  busPeqOneKnobType,
} from "./output-peq.js";
import {
  busCue,
  busCueInterrupt,
  busDelayFrameRate,
  busDelayOn,
  busDelayTime,
  busMono,
  busSource,
  channelCue,
  cueMode,
  outputLevel,
  outputSource,
} from "./output-routing.js";
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
  /** The target's validation without traffic, throwing its refusal (used to refuse a write of a read-only setting). */
  check?(model: string, target: Target<K>): void;
}

export interface WriteHandler<K extends SettingId> extends ReadHandler<K> {
  /** The validated plan; it sends nothing (preview). */
  plan(model: string, target: Target<K>, value: Input<K>): WritePlan<Input<K>>;
  /**
   * The state-independent checks of the target and value, throwing their
   * refusal; no traffic. Absent where they are the plan's own checks.
   */
  validate?(model: string, target: Target<K>, value: Input<K>): void;
  /**
   * The plan with the operation's required prerequisite reads, sending no
   * write (O13); absent where the plan needs no device state.
   */
  dryRun?(context: OperationContext, target: Target<K>, value: Input<K>): Promise<WritePlan<Input<K>>>;
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
  "channel.eq.band.on": eqBandOn,
  "channel.eq.band.type": eqBandType,
  "channel.eq.band.q": eqBandQ,
  "channel.eq.band.frequency": eqBandFrequency,
  "channel.eq.band.gain": eqBandGain,
  "channel.eq.one-knob.on": eqOneKnobOn,
  "channel.eq.one-knob.type": eqOneKnobType,
  "channel.eq.one-knob.level": eqOneKnobLevel,
  "channel.ssmcs.preset": ssmcsPreset,
  "channel.ssmcs.comp-drive": ssmcsCompDrive,
  "channel.ssmcs.morphing": ssmcsMorphing,
  "channel.ssmcs.output-gain": ssmcsOutputGain,
  "channel.ssmcs.comp.attack": ssmcsCompAttack,
  "channel.ssmcs.comp.release": ssmcsCompRelease,
  "channel.ssmcs.comp.ratio": ssmcsCompRatio,
  "channel.ssmcs.comp.knee": ssmcsCompKnee,
  "channel.ssmcs.sidechain.on": ssmcsSidechainOn,
  "channel.ssmcs.sidechain.q": ssmcsSidechainQ,
  "channel.ssmcs.sidechain.frequency": ssmcsSidechainFrequency,
  "channel.ssmcs.sidechain.gain": ssmcsSidechainGain,
  "channel.ssmcs.eq.band.on": ssmcsEqBandOn,
  "channel.ssmcs.eq.band.frequency": ssmcsEqBandFrequency,
  "channel.ssmcs.eq.band.gain": ssmcsEqBandGain,
  "channel.ssmcs.eq.band.q": ssmcsEqBandQ,
  "channel.ducker.on": duckerOn,
  "channel.ducker.key-source": duckerKeySource,
  "channel.ducker.threshold": duckerThreshold,
  "channel.ducker.range": duckerRange,
  "channel.ducker.attack": duckerAttack,
  "channel.ducker.decay": duckerDecay,
  "send.on": sendOn,
  "send.level": sendLevel,
  "send.pan": sendPan,
  "send.tap": sendTap,
  "bus.on": busOn,
  "bus.fader": busFader,
  "bus.balance": busBalance,
  "bus.type": busType,
  "bus.pan-link": busPanLink,
  "bus.stereo-assign": busStereoAssign,
  "bus.name": busName,
  "bus.color": busColor,
  "channel.stereo-assign": channelStereoAssign,
  "channel.insert-fx.type": channelInsertFxType,
  "channel.insert-fx.on": channelInsertFxOn,
  "bus.insert-fx.type": busInsertFxType,
  "bus.insert-fx.on": busInsertFxOn,
  "bus.fx.type": busFxType,
  "bus.fx.parameter": busFxParameter,
  "bus.eq.type": busEqType,
  "bus.eq.on": busEqOn,
  "bus.geq.link": busGeqLink,
  "bus.geq.on": busGeqOn,
  "bus.geq.limit": busGeqLimit,
  "bus.geq.gain": busGeqGain,
  "bus.peq.band.on": busPeqBandOn,
  "bus.peq.band.type": busPeqBandType,
  "bus.peq.band.q": busPeqBandQ,
  "bus.peq.band.frequency": busPeqBandFrequency,
  "bus.peq.band.gain": busPeqBandGain,
  "bus.peq.one-knob.on": busPeqOneKnobOn,
  "bus.peq.one-knob.type": busPeqOneKnobType,
  "bus.peq.one-knob.level": busPeqOneKnobLevel,
  "bus.delay.on": busDelayOn,
  "bus.delay.time": busDelayTime,
  "bus.delay.frame-rate": busDelayFrameRate,
  "output.source": outputSource,
  "bus.source": busSource,
  "bus.mono": busMono,
  "bus.cue-interrupt": busCueInterrupt,
  "output.level": outputLevel,
  "channel.cue": channelCue,
  "bus.cue": busCue,
  "cue.mode": cueMode,
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

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The IDs that accept a target of type `T` (a channel setting with an optional side accepts a plain channel). */
type IdsTaking<T> = { [K in SettingId]: [T] extends [Target<K>] ? K : never }[SettingId];

/** The writable IDs whose target and write types are exactly `T` and `I`. */
type IdsWriting<T, I> = {
  [K in WritableSettingId]: Same<Target<K>, T> extends true ? (Same<Input<K>, I> extends true ? K : never) : never;
}[WritableSettingId];

/**
 * The (id, target) pairs a read takes: each ID with its own target type. An
 * ID may also be any union of the IDs that accept that target, so a list of
 * settings read alike type-checks however many it holds.
 */
export type ReadArgs = { [K in SettingId]: [id: IdsTaking<Target<K>>, target: Target<K>] }[SettingId];

/** The (id, target, value) triples a write takes, grouped the same way by target and write type. */
export type WriteArgs = {
  [K in WritableSettingId]: [id: IdsWriting<Target<K>, Input<K>>, target: Target<K>, value: Input<K>];
}[WritableSettingId];

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

/**
 * The handler a write of `id` uses. An ID outside the catalog is
 * `invalid_input`. A known read-only setting first validates its target, so
 * a malformed one is still `invalid_input`, then is `unsupported_operation`:
 * a known setting without a write.
 */
function writeHandler<K extends WritableSettingId>(id: K, model: string, target: unknown): WriteHandler<K> {
  if (!Object.hasOwn(settingDefinitions, id)) {
    throw new OperationFailureError({ code: "invalid_input", phase: "preparation", progress: null });
  }
  if (!(settingDefinitions as Record<string, { writable: boolean }>)[id]?.writable) {
    (settingHandlers[id as SettingId] as unknown as ReadHandler<SettingId>).check?.(model, target as never);
    throw new OperationFailureError({ code: "unsupported_operation", phase: "preparation", progress: null });
  }
  return settingHandlers[id] as unknown as WriteHandler<K>;
}

/** Writes `value` to `id` for `target`: its single selected request. */
export function writeSetting<A extends WriteArgs>(
  context: OperationContext,
  ...[id, target, value]: A
): Promise<WriteResult<Input<A[0]>>> {
  return settled(() => {
    const handler = writeHandler(id, context.model, target) as WriteHandler<A[0]>;
    return handler.write(context, target as Target<A[0]>, value as Input<A[0]>);
  });
}

/** The plan a write of `value` would send, through the same validation; no traffic. */
export function previewSetting<A extends WriteArgs>(model: string, ...[id, target, value]: A): WritePlan<Input<A[0]>> {
  const handler = writeHandler(id, model, target) as WriteHandler<A[0]>;
  return handler.plan(model, target as Target<A[0]>, value as Input<A[0]>);
}

/**
 * Validates a write of `value` without a device (B2): the setting, target and
 * value checks that do not depend on device state, throwing the refusal they
 * give. A setting whose plan needs device state (an FX-return parameter)
 * checks what it can without it; its remaining checks run with the
 * operation's prerequisite reads.
 */
export function validateSetting<A extends WriteArgs>(model: string, ...[id, target, value]: A): void {
  const handler = writeHandler(id, model, target) as WriteHandler<A[0]>;
  if (handler.validate === undefined) {
    handler.plan(model, target as Target<A[0]>, value as Input<A[0]>);
  } else {
    handler.validate(model, target as Target<A[0]>, value as Input<A[0]>);
  }
}

/**
 * The plan a write of `value` would send, after the operation's required
 * prerequisite reads (O13): no setting write is sent. A setting whose plan
 * needs no device state reads nothing and plans as `previewSetting` does.
 */
export function dryRunSetting<A extends WriteArgs>(
  context: OperationContext,
  ...[id, target, value]: A
): Promise<WritePlan<Input<A[0]>>> {
  return settled(() => {
    const handler = writeHandler(id, context.model, target) as WriteHandler<A[0]>;
    return handler.dryRun === undefined
      ? Promise.resolve(handler.plan(context.model, target as Target<A[0]>, value as Input<A[0]>))
      : handler.dryRun(context, target as Target<A[0]>, value as Input<A[0]>);
  });
}

