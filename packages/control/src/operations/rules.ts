// Handlers built from a setting definition's value rule (K35 metadata): the
// checks and conversions come from the rule, not a restatement of it.

import { decodeInteger, decodeSwitch, nearestStopIndex, planOnGrid } from "../catalog/codecs.js";
import type { I64Text } from "../catalog/i64.js";
import { channelIndex } from "../catalog/channels.js";
import type { ChannelBandSettingRule, ChannelSettingRule, ValueRule } from "../catalog/rules.js";
import { channelSetting, planSwitch } from "./channels.js";
import type { OperationContext } from "./context.js";
import type { Reading, WritePlan, WriteResult } from "./results.js";
import { address, modelOf, readDecoded, refuse, targetOf, writeRaw } from "./setting-io.js";
import type { ParameterAddress } from "./transport.js";

type Codec = {
  decode: (raw: I64Text) => unknown;
  plan: (value: unknown) => { planned: unknown; raw: I64Text } | undefined;
};

function finiteCodec(rule: Exclude<ValueRule, { kind: "switch" } | { kind: "choice" }>): Codec {
  if (rule.kind === "grid") {
    return {
      decode: (raw) => {
        const value = decodeInteger(raw, Math.round(rule.min * rule.scale), Math.round(rule.max * rule.scale));
        return value === undefined ? undefined : value / rule.scale;
      },
      plan: (value) => {
        const planned = typeof value === "number" ? planOnGrid(value, rule.min, rule.max, rule.scale) : undefined;
        return planned === undefined ? undefined : { planned, raw: `${Math.round(planned * rule.scale)}` };
      },
    };
  }
  const first = rule.stops[0] as number;
  const last = rule.stops[rule.stops.length - 1] as number;
  return {
    // Decoded without snapping to a stop.
    decode: (raw) => {
      const value = decodeInteger(raw, rule.read?.min ?? first, rule.read?.max ?? last);
      return value === undefined ? undefined : value / rule.scale;
    },
    plan: (value) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < first / rule.scale || value > last / rule.scale) {
        return undefined;
      }
      const stop = rule.stops[nearestStopIndex(rule.stops, rule.scale, value)] as number;
      return { planned: stop / rule.scale, raw: `${stop}` };
    },
  };
}

export function codecOf(rule: ValueRule): Codec {
  switch (rule.kind) {
    case "switch":
      return { decode: decodeSwitch, plan: planSwitch };
    case "choice":
      return {
        decode: (raw) => {
          const index = decodeInteger(raw, 0, rule.choices.length - 1);
          return index === undefined ? undefined : rule.choices[index];
        },
        plan: (value) => {
          const index = rule.choices.indexOf(value as string);
          return index < 0 ? undefined : { planned: value, raw: `${index}` };
        },
      };
    default: {
      const finite = finiteCodec(rule);
      const sentinel = rule.sentinel;
      if (sentinel === undefined) {
        return finite;
      }
      // Only the exact sentinel raw and value: nothing near them is an alias.
      return {
        decode: (raw) => (raw === sentinel.raw ? sentinel.value : finite.decode(raw)),
        plan: (value) => (value === sentinel.value ? { planned: value, raw: sentinel.raw } : finite.plan(value)),
      };
    }
  }
}

/** A whole-channel setting whose handler is built from `rule`; `V` is its catalog value type. */
export function ruleSetting<V>(rule: ChannelSettingRule) {
  const codec = codecOf(rule.value);
  return channelSetting<V>(
    rule.address,
    codec.decode as (raw: I64Text) => V | undefined,
    codec.plan as (value: unknown) => { planned: V; raw: I64Text } | undefined,
  );
}

/**
 * A band setting whose handler is built from `rule`: the target names a
 * channel and exactly one band, and takes no side.
 */
export function bandRuleSetting<V>(rule: ChannelBandSettingRule) {
  const value = rule.value;
  const codecs = new Map<string, Codec>(
    value.kind === "by-band"
      ? Object.entries(value.rules).map(([band, each]) => [band, codecOf(each)])
      : rule.bands.map((band) => [band, codecOf(value)]),
  );
  const resolve = (model: string, target: unknown): { at: ParameterAddress; codec: Codec } => {
    // A side key is taken only as undefined, as for whole-channel targets.
    const own = targetOf<{ channel: unknown; band: unknown; side: unknown }>(target, ["channel", "band", "side"]);
    const channel = channelIndex(modelOf(model), own.channel) ?? refuse("invalid_input");
    if (own.side !== undefined || typeof own.band !== "string" || !rule.bands.includes(own.band)) {
      return refuse("invalid_input");
    }
    // A band or channel kind without an ID lacks the setting.
    const paramId = Object.hasOwn(rule.address, own.band) ? rule.address[own.band]?.[channel.kind] : undefined;
    const codec = codecs.get(own.band);
    return paramId === undefined || codec === undefined
      ? refuse("unsupported_operation")
      : { at: address(paramId, channel.index), codec };
  };
  const planned = (model: string, target: unknown, requested: V) => {
    const { at, codec } = resolve(model, target);
    const result = codec.plan(requested);
    return result === undefined
      ? refuse("invalid_input")
      : { at, raw: result.raw, requested, planned: result.planned as V };
  };
  return {
    read(context: OperationContext, target: unknown): Promise<Reading<V>> {
      const { at, codec } = resolve(context.model, target);
      return readDecoded(context, at, codec.decode as (raw: I64Text) => V | undefined);
    },
    plan(model: string, target: unknown, requested: V): WritePlan<V> {
      const { requested: r, planned: p } = planned(model, target, requested);
      return { requested: r, planned: p };
    },
    write(context: OperationContext, target: unknown, requested: V): Promise<WriteResult<V>> {
      const { at, raw, requested: r, planned: p } = planned(context.model, target, requested);
      return writeRaw(context, at, raw, { requested: r, planned: p });
    },
  };
}

