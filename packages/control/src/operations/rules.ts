// Handlers built from a setting definition's value rule (K35 metadata): the
// checks and conversions come from the rule, not a restatement of it. Each
// handler reads or writes its one resolved address once.

import { channelIndex } from "../catalog/channels.js";
import { decodeInteger, decodeSwitch, nearestStopIndex, planOnGrid } from "../catalog/codecs.js";
import type { I64Text } from "../catalog/i64.js";
import type {
  BusSettingRule,
  ChannelBandSettingRule,
  ChannelSettingRule,
  GridRule,
  PortChoiceRule,
  SendSettingRule,
  StopsRule,
  TextIndexRule,
  ValueRule,
} from "../catalog/rules.js";
import { planSwitch, writableName } from "./channels.js";
import type { OperationContext } from "./context.js";
import type { Reading, WritePlan, WriteResult } from "./results.js";
import { address, modelOf, readDecoded, readName, readTextDecoded, refuse, targetOf, writeRaw, writeText } from "./setting-io.js";
import type { ParameterAddress } from "./transport.js";

/**
 * A value's wire form both ways; `text` marks a string parameter. A plan is
 * undefined for an invalid value and "unsupported" for a known value the
 * model lacks.
 */
interface Codec {
  readonly text: boolean;
  /** A display name, read through the name-specific read. */
  readonly name?: true;
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
    case "selector":
      return {
        text: false,
        decode: (raw) => (raw === rule.none.raw ? rule.none.value : rule.choices.find((choice) => choice.raw === raw)?.token),
        plan: (value) => {
          if (value === rule.none.value) {
            return { planned: value, raw: rule.none.raw };
          }
          const choice = rule.choices.find((each) => each.token === value);
          if (choice !== undefined) {
            return { planned: value, raw: choice.raw };
          }
          return rule.known.includes(value as string) ? "unsupported" : undefined;
        },
      };
    case "name":
      return {
        text: true,
        name: true,
        decode: () => undefined,
        // Validated, never transformed: no trimming, normalization or deletion.
        plan: (value) => (writableName(value, rule.maxCodePoints) ? { planned: value, raw: value } : undefined),
      };
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

/** A handler for the address and codec `resolve` gives a target, for a read or a write. */
function handler<V, I = V>(resolve: (model: string, target: unknown, write: boolean) => { at: ParameterAddress; codec: Codec }) {
  const planned = (model: string, target: unknown, requested: I) => {
    const { at, codec } = resolve(model, target, true);
    const result = codec.plan(requested);
    if (result === "unsupported") {
      return refuse("unsupported_operation");
    }
    return result === undefined
      ? refuse("invalid_input")
      : { at, codec, raw: result.raw as I64Text, requested, planned: result.planned as I };
  };
  return {
    /** The target's read resolution without traffic: its refusal, if any. */
    check(model: string, target: unknown): void {
      resolve(model, target, false);
    },
    read(context: OperationContext, target: unknown): Promise<Reading<V>> {
      const { at, codec } = resolve(context.model, target, false);
      if (codec.name === true) {
        return readName(context, at) as Promise<Reading<V>>;
      }
      const decode = (raw: string) => codec.decode(raw) as V | undefined;
      return codec.text ? readTextDecoded(context, at, decode) : readDecoded(context, at, decode);
    },
    plan(model: string, target: unknown, requested: I): WritePlan<I> {
      const { requested: r, planned: p } = planned(model, target, requested);
      return { requested: r, planned: p };
    },
    write(context: OperationContext, target: unknown, requested: I): Promise<WriteResult<I>> {
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

const SEND_SOURCE = /^(channel|fx)-([1-9][0-9]*)$/;
const SEND_DESTINATION = /^(mix|fx)-([12])$/;

/**
 * A send setting whose handler is built from `rule`: the target names one
 * send by its source and destination token, and takes nothing else. A known
 * pair or channel the model or field lacks is unsupported; so is a write
 * where the route's write is not selected.
 */
export function sendRuleSetting<V>(rule: SendSettingRule) {
  const codec = codecOf(rule.value);
  return handler<V>((model, target, write) => {
    const own = targetOf<{ source?: unknown; destination?: unknown }>(target, ["source", "destination"]);
    const known = modelOf(model);
    if (
      typeof own.source !== "string" ||
      typeof own.destination !== "string" ||
      !rule.knownSources.includes(own.source) ||
      !rule.knownDestinations.includes(own.destination)
    ) {
      return refuse("invalid_input");
    }
    const source = SEND_SOURCE.exec(own.source);
    const destination = SEND_DESTINATION.exec(own.destination);
    if (source === null || destination === null) {
      // A known bus token that is not a send source or destination.
      return refuse("unsupported_operation");
    }
    let from: "mono" | "stereo" | "fx";
    let y: number;
    if (source[1] === "channel") {
      const channel = channelIndex(known, Number(source[2])) ?? refuse("unsupported_operation");
      from = channel.kind;
      y = channel.index;
    } else {
      from = "fx";
      y = Number(source[2]) - 1;
    }
    const to = destination[1] as "mix" | "fx";
    const route = rule.routes.find((each) => each.from === from && each.to === to) ?? refuse("unsupported_operation");
    if (write && !route.write) {
      return refuse("unsupported_operation");
    }
    return { at: address(route.base + route.stride * (Number(destination[2]) - 1), y), codec };
  });
}

/** A bus setting whose handler is built from `rule`: the target names one bus token and nothing else. */
export function busRuleSetting<V, I = V>(rule: BusSettingRule) {
  const codec = codecOf(rule.value);
  return handler<V, I>((model, target, write) => {
    modelOf(model);
    const own = targetOf<{ bus?: unknown }>(target, ["bus"]);
    if (typeof own.bus !== "string" || !rule.known.includes(own.bus)) {
      return refuse("invalid_input");
    }
    const at = Object.hasOwn(rule.address, own.bus) ? rule.address[own.bus] : undefined;
    if (at === undefined || (write && !at.write)) {
      return refuse("unsupported_operation");
    }
    return { at: address(at.paramId, at.y), codec };
  });
}

