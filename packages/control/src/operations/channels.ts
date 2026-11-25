// Basic channel controls (C12, F03-H): on, fader, pan and polarity. Each
// operation reads or writes its own address once; no partner, mode or
// equality reads, no readback.

import {
  CHANNEL_COLORS,
  IDENTITY_PARAMS,
  NAME_MAX_CODE_POINTS,
  REC_POINTS,
  REC_POINT_PARAMS,
  STEREO_REC_POINTS,
  MONO_PAIRS,
  PAIR_PARAMS,
  CHANNEL_PARAMS,
  FADER_DB,
  FADER_NEGATIVE_INFINITY_RAW,
  PAN_RANGE,
  channelIndex,
  type ChannelIndex,
} from "../catalog/channels.js";
import { decodeInteger, decodeSwitch, encodeSwitch, planOnGrid } from "../catalog/codecs.js";
import { INPUT_PORTS, SOURCE_PARAMS, portOfRaw } from "../catalog/ports.js";
import { formatI64, type I64Text } from "../catalog/i64.js";
import type {
  ChannelColor,
  ChannelName,
  ChannelSideTarget,
  ChannelTarget,
  FaderLevel,
  PanMode,
  Polarity,
  RecPoint,
} from "../catalog/settings.js";
import { OperationFailureError } from "./failure.js";
import type { OperationContext } from "./context.js";
import type { Reading, WritePlan, WriteResult } from "./results.js";
import { address, modelOf, readDecoded, refuse, targetOf, writeRaw, writeText } from "./setting-io.js";
import type { ParameterAddress } from "./transport.js";

/** The channel a target names and its side, each read once from the target's own values. */
function selectionOf(model: string, target: unknown): { channel: ChannelIndex; side: unknown } {
  const own = targetOf<ChannelSideTarget>(target, ["channel", "side"]);
  const channel = channelIndex(modelOf(model), own.channel);
  return channel === undefined ? refuse("invalid_input") : { channel, side: own.side };
}

/** A pair-wide or mono setting: a side selector is refused. */
function wholeChannel(model: string, target: unknown): ChannelIndex {
  const { channel, side } = selectionOf(model, target);
  return side === undefined ? channel : refuse("invalid_input");
}

/** A whole-channel setting's address; a kind without an ID lacks the setting. */
function wholeAddress(ids: { mono?: number; stereo?: number }, channel: ChannelIndex): ParameterAddress {
  const paramId = channel.kind === "mono" ? ids.mono : ids.stereo;
  return paramId === undefined ? refuse("unsupported_operation") : address(paramId, channel.index);
}

/** A side-specific setting's address: a side is required for fixed stereo, refused for mono. */
function sideAddress(ids: { mono: number; left: number; right: number }, model: string, target: unknown): ParameterAddress {
  const { channel, side } = selectionOf(model, target);
  if (channel.kind === "mono") {
    return side === undefined ? address(ids.mono, channel.index) : refuse("invalid_input");
  }
  if (side === "left" || side === "right") {
    return address(ids[side], channel.index);
  }
  return refuse("invalid_input");
}

function polarityAddress(model: string, target: unknown): ParameterAddress {
  return sideAddress(CHANNEL_PARAMS.polarity, model, target);
}

/** A whole-channel setting with its codec. */
export function channelSetting<V>(
  ids: { mono?: number; stereo?: number },
  decode: (raw: I64Text) => V | undefined,
  plan: (value: unknown) => { planned: V; raw: I64Text } | undefined,
) {
  const planned = (model: string, target: ChannelTarget, value: V) => {
    const at = wholeAddress(ids, wholeChannel(model, target));
    const result = plan(value);
    return result === undefined ? refuse("invalid_input") : { at, requested: value, ...result };
  };
  return {
    read(context: OperationContext, target: ChannelTarget): Promise<Reading<V>> {
      return readDecoded(context, wholeAddress(ids, wholeChannel(context.model, target)), decode);
    },
    plan(model: string, target: ChannelTarget, value: V): WritePlan<V> {
      const { requested, planned: p } = planned(model, target, value);
      return { requested, planned: p };
    },
    write(context: OperationContext, target: ChannelTarget, value: V): Promise<WriteResult<V>> {
      const { at, raw, requested, planned: p } = planned(context.model, target, value);
      return writeRaw(context, at, raw, { requested, planned: p });
    },
  };
}

function decodeFader(raw: I64Text): FaderLevel | undefined {
  if (raw === FADER_NEGATIVE_INFINITY_RAW) {
    return "-inf";
  }
  const value = decodeInteger(raw, FADER_DB.min * 100, FADER_DB.max * 100);
  return value === undefined ? undefined : value / 100;
}

function planFader(value: unknown): { planned: FaderLevel; raw: I64Text } | undefined {
  if (value === "-inf") {
    return { planned: "-inf", raw: FADER_NEGATIVE_INFINITY_RAW };
  }
  if (typeof value !== "number") {
    return undefined;
  }
  const planned = planOnGrid(value, FADER_DB.min, FADER_DB.max, 100);
  return planned === undefined ? undefined : { planned, raw: formatI64(BigInt(Math.round(planned * 100))) as I64Text };
}

function planPan(value: unknown): { planned: number; raw: I64Text } | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  const planned = planOnGrid(value, PAN_RANGE.min, PAN_RANGE.max, 1);
  return planned === undefined ? undefined : { planned, raw: `${planned}` };
}

export function planSwitch(value: unknown): { planned: boolean; raw: I64Text } | undefined {
  return typeof value === "boolean" ? { planned: value, raw: encodeSwitch(value) } : undefined;
}

export const channelOn = channelSetting(CHANNEL_PARAMS.on, decodeSwitch, planSwitch);
export const channelFader = channelSetting(CHANNEL_PARAMS.fader, decodeFader, planFader);
export const channelPan = channelSetting(
  CHANNEL_PARAMS.pan,
  (raw) => decodeInteger(raw, PAN_RANGE.min, PAN_RANGE.max),
  planPan,
);

function decodePolarity(raw: I64Text): Polarity | undefined {
  const on = decodeSwitch(raw);
  return on === undefined ? undefined : on ? "inverted" : "normal";
}

function polarityPlan(model: string, target: ChannelSideTarget, value: Polarity) {
  const at = polarityAddress(model, target);
  if (value !== "normal" && value !== "inverted") {
    return refuse("invalid_input");
  }
  return { at, requested: value, planned: value, raw: encodeSwitch(value === "inverted") };
}

export const channelPolarity = {
  read(context: OperationContext, target: ChannelSideTarget): Promise<Reading<Polarity>> {
    return readDecoded(context, polarityAddress(context.model, target), decodePolarity);
  },
  plan(model: string, target: ChannelSideTarget, value: Polarity): WritePlan<Polarity> {
    const { requested, planned } = polarityPlan(model, target, value);
    return { requested, planned };
  },
  write(context: OperationContext, target: ChannelSideTarget, value: Polarity): Promise<WriteResult<Polarity>> {
    const { at, raw, requested, planned } = polarityPlan(context.model, target, value);
    return writeRaw(context, at, raw, { requested, planned });
  },
};

function sourcePlan(model: string, target: ChannelSideTarget, value: string) {
  const at = sideAddress(SOURCE_PARAMS, model, target);
  const port = typeof value === "string" && Object.hasOwn(INPUT_PORTS, value) ? INPUT_PORTS[value] : undefined;
  if (port === undefined) {
    return refuse("invalid_input");
  }
  if (!port.models.includes(modelOf(model))) {
    return refuse("unsupported_operation");
  }
  return { at, requested: value, planned: value, raw: port.raw };
}

/** The input port a channel side takes its source lane from (F03-I). */
export const channelSource = {
  read(context: OperationContext, target: ChannelSideTarget): Promise<Reading<string>> {
    const model = modelOf(context.model);
    return readDecoded(context, sideAddress(SOURCE_PARAMS, context.model, target), (raw) => portOfRaw(model, raw));
  },
  plan(model: string, target: ChannelSideTarget, value: string): WritePlan<string> {
    const { requested, planned } = sourcePlan(model, target, value);
    return { requested, planned };
  },
  write(context: OperationContext, target: ChannelSideTarget, value: string): Promise<WriteResult<string>> {
    const { at, raw, requested, planned } = sourcePlan(context.model, target, value);
    return writeRaw(context, at, raw, { requested, planned });
  },
};

/** A mono pair's primary address; the secondary is not an alias, fixed stereo has no pair. */
function pairAddress(paramId: number, model: string, target: unknown): ParameterAddress {
  const known = modelOf(model);
  const { channel, side } = selectionOf(model, target);
  if (side !== undefined) {
    return refuse("invalid_input");
  }
  if (channel.kind === "stereo") {
    return refuse("unsupported_operation");
  }
  const primary = channel.index + 1;
  return MONO_PAIRS[known].includes(primary) ? address(paramId, channel.index) : refuse("invalid_input");
}

/**
 * The mono-pair link (F03-J): read at the primary only. Its write sequence
 * (one write, or both members) needs evidence first, so it is read-only
 * until then.
 */
export const channelStereoLink = {
  check(model: string, target: ChannelTarget): void {
    pairAddress(PAIR_PARAMS.stereoLink, model, target);
  },
  read(context: OperationContext, target: ChannelTarget): Promise<Reading<boolean>> {
    return readDecoded(context, pairAddress(PAIR_PARAMS.stereoLink, context.model, target), decodeSwitch);
  },
};

function decodePanMode(raw: I64Text): PanMode | undefined {
  const balance = decodeSwitch(raw);
  return balance === undefined ? undefined : balance ? "balance" : "pan";
}

function panModePlan(model: string, target: ChannelTarget, value: PanMode) {
  const at = pairAddress(PAIR_PARAMS.panMode, model, target);
  if (value !== "pan" && value !== "balance") {
    return refuse("invalid_input");
  }
  return { at, requested: value, planned: value, raw: encodeSwitch(value === "balance") };
}

/** PAN/BAL of a mono pair (F03-J): one write at the primary, no link-state read. */
export const channelPanMode = {
  read(context: OperationContext, target: ChannelTarget): Promise<Reading<PanMode>> {
    return readDecoded(context, pairAddress(PAIR_PARAMS.panMode, context.model, target), decodePanMode);
  },
  plan(model: string, target: ChannelTarget, value: PanMode): WritePlan<PanMode> {
    const { requested, planned } = panModePlan(model, target, value);
    return { requested, planned };
  },
  write(context: OperationContext, target: ChannelTarget, value: PanMode): Promise<WriteResult<PanMode>> {
    const { at, raw, requested, planned } = panModePlan(context.model, target, value);
    return writeRaw(context, at, raw, { requested, planned });
  },
};

/** Whether `name` is writable: at most 8 Unicode scalar values, no C0/C1 controls (F03-K). */
function writableName(name: unknown): name is string {
  if (typeof name !== "string") {
    return false;
  }
  const points = Array.from(name);
  if (points.length > NAME_MAX_CODE_POINTS) {
    return false;
  }
  return points.every((point) => {
    const code = point.codePointAt(0) as number;
    const surrogate = code >= 0xd800 && code <= 0xdfff;
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    return !surrogate && !control;
  });
}

function namePlan(model: string, target: ChannelTarget, value: string) {
  const at = wholeAddress(IDENTITY_PARAMS.name, wholeChannel(model, target));
  // Validated, never transformed: no trimming, normalization or deletion.
  return writableName(value) ? { at, requested: value, planned: value } : refuse("invalid_input");
}

/** A channel's name (F03-K): text written as given; read as text or a preset index. */
export const channelName = {
  async read(context: OperationContext, target: ChannelTarget): Promise<Reading<ChannelName>> {
    const at = wholeAddress(IDENTITY_PARAMS.name, wholeChannel(context.model, target));
    const { record, observedAt } = await context.getName(at);
    if (record.kind === "failure") {
      throw context.failureOf(record, null);
    }
    if (observedAt === undefined) {
      throw new OperationFailureError({ code: "internal_error", phase: "delivery", progress: null });
    }
    // Received as is: not clipped, trimmed or normalized.
    const value: ChannelName =
      record.value.kind === "text"
        ? { kind: "text", text: record.value.value }
        : { kind: "preset", presetIndex: record.value.value };
    return { value, observedAt };
  },
  plan(model: string, target: ChannelTarget, value: string): WritePlan<string> {
    const { requested, planned } = namePlan(model, target, value);
    return { requested, planned };
  },
  write(context: OperationContext, target: ChannelTarget, value: string): Promise<WriteResult<string>> {
    const { at, requested, planned } = namePlan(context.model, target, value);
    return writeText(context, at, planned, { requested, planned });
  },
};

function decodeColor(raw: I64Text): ChannelColor | undefined {
  const index = decodeInteger(raw, 0, CHANNEL_COLORS.length - 1);
  return index === undefined ? undefined : CHANNEL_COLORS[index];
}

function planColor(value: unknown): { planned: ChannelColor; raw: I64Text } | undefined {
  const index = (CHANNEL_COLORS as readonly unknown[]).indexOf(value);
  return index < 0 ? undefined : { planned: value as ChannelColor, raw: `${index}` };
}

/** A channel's palette color (F03-K). */
export const channelColor = channelSetting(IDENTITY_PARAMS.color, decodeColor, planColor);

/** The Rec Point stages a channel kind has (F03-R). */
function recPointsOf(channel: ChannelIndex): readonly RecPoint[] {
  return channel.kind === "mono" ? REC_POINTS : STEREO_REC_POINTS;
}

function recPointPlan(model: string, target: ChannelTarget, value: RecPoint) {
  const channel = wholeChannel(model, target);
  // Only the channel kind's own stages; a request is sent as given, even
  // pre-eq on a mono channel in SSMCS mode.
  if (!recPointsOf(channel).includes(value)) {
    return refuse("invalid_input");
  }
  return {
    at: wholeAddress(REC_POINT_PARAMS, channel),
    requested: value,
    planned: value,
    raw: `${REC_POINTS.indexOf(value)}`,
  };
}

/** A channel's Rec Point (F03-R): one addressed read or write, no mode read. */
export const channelRecPoint = {
  read(context: OperationContext, target: ChannelTarget): Promise<Reading<RecPoint>> {
    const channel = wholeChannel(context.model, target);
    const stages = recPointsOf(channel);
    return readDecoded(context, wholeAddress(REC_POINT_PARAMS, channel), (raw) => {
      const index = decodeInteger(raw, 0, REC_POINTS.length - 1);
      const stage = index === undefined ? undefined : REC_POINTS[index];
      return stage !== undefined && stages.includes(stage) ? stage : undefined;
    });
  },
  plan(model: string, target: ChannelTarget, value: RecPoint): WritePlan<RecPoint> {
    const { requested, planned } = recPointPlan(model, target, value);
    return { requested, planned };
  },
  write(context: OperationContext, target: ChannelTarget, value: RecPoint): Promise<WriteResult<RecPoint>> {
    const { at, raw, requested, planned } = recPointPlan(context.model, target, value);
    return writeRaw(context, at, raw, { requested, planned });
  },
};
