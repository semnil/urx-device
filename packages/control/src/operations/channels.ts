// Basic channel controls (C12, F03-H): on, fader, pan and polarity. Each
// operation reads or writes its own address once; no partner, mode or
// equality reads, no readback.

import {
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
import type { ChannelSideTarget, ChannelTarget, FaderLevel, Polarity } from "../catalog/settings.js";
import type { OperationContext } from "./context.js";
import type { Reading, WritePlan, WriteResult } from "./results.js";
import { address, modelOf, readDecoded, refuse, writeRaw } from "./setting-io.js";
import type { ParameterAddress } from "./transport.js";

function channelOf(model: string, target: unknown): ChannelIndex {
  const channel = channelIndex(modelOf(model), (target as ChannelTarget | null)?.channel);
  return channel ?? refuse("invalid_input");
}

/** A pair-wide or mono setting: a side selector is refused. */
function wholeChannel(model: string, target: unknown): ChannelIndex {
  const channel = channelOf(model, target);
  return (target as ChannelSideTarget).side === undefined ? channel : refuse("invalid_input");
}

function wholeAddress(ids: { mono: number; stereo: number }, channel: ChannelIndex): ParameterAddress {
  return address(channel.kind === "mono" ? ids.mono : ids.stereo, channel.index);
}

/** A side-specific setting's address: a side is required for fixed stereo, refused for mono. */
function sideAddress(ids: { mono: number; left: number; right: number }, model: string, target: unknown): ParameterAddress {
  const channel = channelOf(model, target);
  const side = (target as ChannelSideTarget).side;
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
function channelSetting<V>(
  ids: { mono: number; stereo: number },
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

function planSwitch(value: unknown): { planned: boolean; raw: I64Text } | undefined {
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
