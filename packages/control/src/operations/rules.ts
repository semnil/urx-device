// Handlers built from a setting definition's value rule (K35 metadata): the
// checks and conversions come from the rule, not a restatement of it. Each
// handler reads or writes its one resolved address once.

import { channelIndex } from "../catalog/channels.js";
import { decodeInteger, decodeSwitch, nearestStopIndex, planOnGrid } from "../catalog/codecs.js";
import type { I64Text } from "../catalog/i64.js";
import type {
  ChannelBandSettingRule,
  ChannelSettingRule,
  GridRule,
  PortChoiceRule,
  StopsRule,
  TextIndexRule,
  ValueRule,
} from "../catalog/rules.js";
import { planSwitch } from "./channels.js";
import type { OperationContext } from "./context.js";
import type { Reading, WritePlan, WriteResult } from "./results.js";
import { address, modelOf, readDecoded, readTextDecoded, refuse, targetOf, writeRaw, writeText } from "./setting-io.js";
import type { ParameterAddress } from "./transport.js";

/**
 * A value's wire form both ways; `text` marks a string parameter. A plan is
 * undefined for an invalid value and "unsupported" for a known value the
 * model lacks.
 */
interface Codec {
  readonly text: boolean;
  decode(raw: string): unknown;
  plan(value: unknown): { planned: unknown; raw: string } | "unsupported" | undefined;
}

function gridCodec(rule: GridRule): Codec {
  const offset = rule.offset ?? 0;
  // Write steps per public unit: the step, or the wire resolution.
  const perUnit = rule.step === undefined ? rule.scale : 1 / rule.step;
  return {
    text: false,
    decode: (raw) => {
      const value = decodeInteger(raw, Math.round(rule.min * rule.scale) + offset, Math.round(rule.max * rule.scale) + offset);
      return value === undefined ? undefined : (value - offset) / rule.scale;
    },
    plan: (value) => {
      const planned = typeof value === "number" ? planOnGrid(value, rule.min, rule.max, perUnit) : undefined;
      return planned === undefined ? undefined : { planned, raw: `${Math.round(planned * rule.scale) + offset}` };
    },
  };
}

function stopsCodec(rule: StopsRule): Codec {
  const first = rule.stops[0] as number;
  const last = rule.stops[rule.stops.length - 1] as number;
  const ordinal = rule.ordinal;
  return {
    text: false,
    decode: (raw) => {
      if (ordinal !== undefined) {
        // The raw is the stop's index: each valid raw names exactly one stop.
        const index = decodeInteger(raw, ordinal, ordinal + rule.stops.length - 1);
        return index === undefined ? undefined : (rule.stops[index - ordinal] as number) / rule.scale;
      }
      // Decoded without snapping to a stop.
      const value = decodeInteger(raw, rule.read?.min ?? first, rule.read?.max ?? last);
      return value === undefined ? undefined : value / rule.scale;
    },
    plan: (value) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < first / rule.scale || value > last / rule.scale) {
        return undefined;
      }
      const index = nearestStopIndex(rule.stops, rule.scale, value);
      const stop = rule.stops[index] as number;
      return { planned: stop / rule.scale, raw: `${ordinal === undefined ? stop : index + ordinal}` };
    },
  };
}

function textIndexCodec(rule: TextIndexRule): Codec {
  return {
    text: true,
    decode: (text) => {
      if (text.length !== rule.digits || !/^[0-9]+$/.test(text)) {
        return undefined;
      }
      const value = Number(text);
      return value >= rule.min && value <= rule.max ? value : undefined;
    },
    // Selectors: fractions are refused, not rounded.
    plan: (value) =>
      typeof value === "number" && Number.isInteger(value) && value >= rule.min && value <= rule.max
        ? { planned: value, raw: `${value}`.padStart(rule.digits, "0") }
        : undefined,
  };
}

const PORT_TAG = 0x80000000n;
const U32_MAX = 0xffffffffn;

function portChoiceCodec(rule: PortChoiceRule, model: string): Codec {
  const choices = Object.hasOwn(rule.byModel, model) ? (rule.byModel[model] ?? []) : [];
  return {
    text: false,
    decode: (raw) => {
      // An unsigned 32-bit integer first, then the exact sentinel, then the tag bit.
      if (!/^(0|[1-9][0-9]*)$/.test(raw) || BigInt(raw) > U32_MAX) {
        return undefined;
      }
      if (raw === rule.none.raw) {
        return rule.none.value;
      }
      const value = BigInt(raw);
      const id = Number(value & PORT_TAG ? value - PORT_TAG : value);
      return choices.find((choice) => choice.id === id)?.token;
    },
    plan: (value) => {
      if (value === rule.none.value) {
        return { planned: value, raw: rule.none.raw };
      }
      const choice = choices.find((each) => each.token === value);
      if (choice !== undefined) {
        return { planned: value, raw: `${choice.id}` };
      }
      return rule.known.includes(value as string) ? "unsupported" : undefined;
    },
  };
}

/** The codec of `rule` on `model` (only a port choice depends on the model). */
export function codecOf(rule: ValueRule, model = ""): Codec {
  switch (rule.kind) {
    case "port-choice":
      return portChoiceCodec(rule, model);
    case "switch":
      return { text: false, decode: decodeSwitch, plan: planSwitch };
    case "choice":
      return {
        text: false,
        decode: (raw) => {
          const index = decodeInteger(raw, 0, rule.choices.length - 1);
          return index === undefined ? undefined : rule.choices[index];
        },
        plan: (value) => {
          const index = rule.choices.indexOf(value as string);
          return index < 0 ? undefined : { planned: value, raw: `${index}` };
        },
      };
    case "text-index":
      return textIndexCodec(rule);
    case "grid":
    case "stops": {
      const finite = rule.kind === "grid" ? gridCodec(rule) : stopsCodec(rule);
      const sentinel = rule.sentinel;
      if (sentinel === undefined) {
        return finite;
      }
      // Only the exact sentinel raw and value: nothing near them is an alias.
      return {
        text: false,
        decode: (raw) => (raw === sentinel.raw ? sentinel.value : finite.decode(raw)),
        plan: (value) => (value === sentinel.value ? { planned: value, raw: sentinel.raw } : finite.plan(value)),
      };
    }
  }
}

/** A handler for the address and codec `resolve` gives a target. */
function handler<V>(resolve: (model: string, target: unknown) => { at: ParameterAddress; codec: Codec }) {
  const planned = (model: string, target: unknown, requested: V) => {
    const { at, codec } = resolve(model, target);
    const result = codec.plan(requested);
    if (result === "unsupported") {
      return refuse("unsupported_operation");
    }
    return result === undefined
      ? refuse("invalid_input")
      : { at, codec, raw: result.raw as I64Text, requested, planned: result.planned as V };
  };
  return {
    read(context: OperationContext, target: unknown): Promise<Reading<V>> {
      const { at, codec } = resolve(context.model, target);
      const decode = (raw: string) => codec.decode(raw) as V | undefined;
      return codec.text ? readTextDecoded(context, at, decode) : readDecoded(context, at, decode);
    },
    plan(model: string, target: unknown, requested: V): WritePlan<V> {
      const { requested: r, planned: p } = planned(model, target, requested);
      return { requested: r, planned: p };
    },
    write(context: OperationContext, target: unknown, requested: V): Promise<WriteResult<V>> {
      const { at, codec, raw, requested: r, planned: p } = planned(context.model, target, requested);
      const plan = { requested: r, planned: p };
      return codec.text ? writeText(context, at, raw, plan) : writeRaw(context, at, raw, plan);
    },
  };
}

/**
 * The channel a target names, its side key taken only as undefined; a kind
 * without an ID (`ids`) lacks the setting.
 */
function channelAddress(
  model: string,
  own: { channel?: unknown; side?: unknown },
  ids: { readonly mono?: number; readonly stereo?: number } | undefined,
): ParameterAddress {
  const channel = channelIndex(modelOf(model), own.channel) ?? refuse("invalid_input");
  if (own.side !== undefined) {
    return refuse("invalid_input");
  }
  const paramId = ids?.[channel.kind];
  return paramId === undefined ? refuse("unsupported_operation") : address(paramId, channel.index);
}

/** A whole-channel setting whose handler is built from `rule`; `V` is its catalog value type. */
export function ruleSetting<V>(rule: ChannelSettingRule) {
  const fixed = rule.value.kind === "port-choice" ? undefined : codecOf(rule.value);
  return handler<V>((model, target) => {
    const own = targetOf<{ channel?: unknown; side?: unknown }>(target, ["channel", "side"]);
    const at = channelAddress(model, own, rule.address);
    return { at, codec: fixed ?? codecOf(rule.value, model) };
  });
}

/**
 * A band setting whose handler is built from `rule`: the target names a
 * channel and exactly one band, and takes no side.
 */
export function bandRuleSetting<V>(rule: ChannelBandSettingRule) {
  const value = rule.value;
  const codecs = new Map<string, Codec>(
    value.kind === "by-band"
      ? Object.entries(value.rules).flatMap(([band, each]) => (each === undefined ? [] : [[band, codecOf(each)] as const]))
      : rule.bands.map((band) => [band, codecOf(value)]),
  );
  return handler<V>((model, target) => {
    const own = targetOf<{ channel?: unknown; band?: unknown; side?: unknown }>(target, ["channel", "band", "side"]);
    if (typeof own.band !== "string" || !rule.bands.includes(own.band)) {
      return refuse("invalid_input");
    }
    const codec = codecs.get(own.band);
    // A band without the setting (no address or no value rule) lacks it.
    const ids = codec === undefined || !Object.hasOwn(rule.address, own.band) ? undefined : rule.address[own.band];
    return { at: channelAddress(model, own, ids), codec: codec as Codec };
  });
}
