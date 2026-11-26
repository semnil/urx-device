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
  BusBandSettingRule,
  BusSideSettingRule,
  DeviceSettingRule,
  OutputSettingRule,
  OutputSideSettingRule,
  ContextStopsRule,
  FxParameterRule,
  GeqGainRule,
  GridRule,
  PortChoiceRule,
  SendSettingRule,
  StopsRule,
  TextIndexRule,
  ValueRule,
} from "../catalog/rules.js";
import { planSwitch, writableName } from "./channels.js";
import type { OperationContext } from "./context.js";
import { OperationFailureError } from "./failure.js";
import type { DryRunPlan, Reading, UnverifiedCondition, VerifiedPlan, WritePlan, WriteResult } from "./results.js";
import {
  address,
  modelOf,
  readDecoded,
  readName,
  readRawValue,
  readTextDecoded,
  refuse,
  targetOf,
  writeRaw,
  writeText,
} from "./setting-io.js";
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
      const writable = (token: string) => rule.writes === undefined || rule.writes.includes(token);
      if (value === rule.none.value) {
        return writable(value) ? { planned: value, raw: rule.none.raw } : "unsupported";
      }
      const choice = choices.find((each) => each.token === value);
      if (choice !== undefined && writable(choice.token)) {
        return { planned: value, raw: `${rule.tagged === true ? BigInt(choice.id) + PORT_TAG : choice.id}` };
      }
      return rule.known.includes(value as string) ? "unsupported" : undefined;
    },
  };
}

/** The codec of `rule` on `model` (only a port choice depends on the model). */
export function codecOf(rule: ValueRule, model = ""): Codec {
  switch (rule.kind) {
    case "numeric-set":
      return {
        text: false,
        decode: (raw) => {
          const value = /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : undefined;
          return value !== undefined && rule.values.includes(value) ? value : undefined;
        },
        // Exact membership: no rounding to the nearest member.
        plan: (value) => (typeof value === "number" && rule.values.includes(value) ? { planned: value, raw: `${value}` } : undefined),
      };
    case "selector":
      return {
        text: false,
        decode: (raw) => (raw === rule.none?.raw ? rule.none.value : rule.choices.find((choice) => choice.raw === raw)?.token),
        plan: (value) => {
          if (rule.none !== undefined && value === rule.none.value) {
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
        decode: (raw) => (raw === sentinel.raw || sentinel.reads?.includes(raw) === true ? sentinel.value : finite.decode(raw)),
        plan: (value) => (value === sentinel.value ? { planned: value, raw: sentinel.raw } : finite.plan(value)),
      };
    }
  }
}

/**
 * A dry run in both call forms (O13): with no `affected` nothing is
 * unverified and the planned value is set; with it, the conditions earlier
 * unsent writes can change. The set is copied at the call, so a caller's
 * later change cannot alter a dry run already started.
 */
export interface DryRun<V> {
  (context: OperationContext, target: unknown, requested: V): Promise<VerifiedPlan<V>>;
  (context: OperationContext, target: unknown, requested: V, affected: ReadonlySet<UnverifiedCondition>): Promise<DryRunPlan<V>>;
}

function dryRunOf<V>(run: (context: OperationContext, target: unknown, requested: V, affected: ReadonlySet<UnverifiedCondition>) => Promise<DryRunPlan<V>>): DryRun<V> {
  // With no affected condition a plan is never left null, so the first form's type holds.
  return ((context: OperationContext, target: unknown, requested: V, affected?: ReadonlySet<UnverifiedCondition>) =>
    run(context, target, requested, new Set(affected ?? []))) as DryRun<V>;
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
 * Each band's codec. For per-band rules, a choice another band takes (a
 * known filter type on the wrong band) plans as unsupported, apart from an
 * unknown name, which stays invalid.
 */
function bandCodecs(value: ChannelBandSettingRule["value"], bands: readonly string[]): Map<string, Codec> {
  if (value.kind !== "by-band") {
    return new Map(bands.map((band) => [band, codecOf(value)]));
  }
  const rules = Object.entries(value.rules).flatMap(([band, each]) => (each === undefined ? [] : [[band, each] as const]));
  const siblings = new Set(rules.flatMap(([, each]) => (each.kind === "choice" ? each.choices : [])));
  return new Map(
    rules.map(([band, each]) => {
      const codec = codecOf(each);
      return [
        band,
        {
          ...codec,
          plan: (requested: unknown) => {
            const planned = codec.plan(requested);
            return planned === undefined && typeof requested === "string" && siblings.has(requested) ? "unsupported" : planned;
          },
        },
      ] as const;
    }),
  );
}

/**
 * A band setting whose handler is built from `rule`: the target names a
 * channel and exactly one band, and takes no side.
 */
export function bandRuleSetting<V>(rule: ChannelBandSettingRule) {
  const value = rule.value;
  const codecs = bandCodecs(value, rule.bands);
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
  const shared = codecOf(rule.value);
  const perBus = new Map(
    Object.entries(rule.address).flatMap(([bus, entry]) => (entry?.value === undefined ? [] : [[bus, codecOf(entry.value)] as const])),
  );
  return handler<V, I>((model, target, write) => {
    modelOf(model);
    // A side key is taken only as undefined, as for the band targets.
    const own = targetOf<{ bus?: unknown; side?: unknown }>(target, ["bus", "side"]);
    if (own.side !== undefined || typeof own.bus !== "string" || !rule.known.includes(own.bus)) {
      return refuse("invalid_input");
    }
    const at = Object.hasOwn(rule.address, own.bus) ? rule.address[own.bus] : undefined;
    if (at === undefined || (write && !at.write)) {
      return refuse("unsupported_operation");
    }
    const value = at.value ?? rule.value;
    const codec = value.kind === "port-choice" ? codecOf(value, model) : (perBus.get(own.bus) ?? shared);
    return { at: address(at.paramId, at.y), codec };
  });
}

/** A stop table in units of 1 / scale, raw = index (a context-stops rule's chosen table). */
function contextCodec(rule: ContextStopsRule, stops: readonly number[]): Codec {
  return stopsCodec({ kind: "stops", unit: rule.unit, stops, scale: rule.scale, ordinal: 0 });
}

/** A failure with no progress, raised by a prerequisite check. */
function failed(code: "precondition_failed" | "invalid_response"): never {
  throw new OperationFailureError({ code, phase: code === "invalid_response" ? "response" : "preparation", progress: null });
}

/**
 * An FX-return parameter (F06-F): static checks first (bus, effect, parameter,
 * value or the type-wide envelope), then one read of the bus's selector, which
 * must equal the expected effect, then a Room Size read where the value needs
 * that context, then the one parameter request. Nothing is cached between
 * calls; no other FX bus's selector is read.
 */
export function fxParameterSetting<V>(rule: FxParameterRule) {
  const resolve = (model: string, target: unknown) => {
    modelOf(model);
    const own = targetOf<{ bus?: unknown; effect?: unknown; parameter?: unknown }>(target, ["bus", "effect", "parameter"]);
    const { bus, effect, parameter } = own;
    if (typeof bus !== "string" || !rule.knownBuses.includes(bus) || typeof effect !== "string" || typeof parameter !== "string") {
      return refuse("invalid_input");
    }
    const effectRule = Object.hasOwn(rule.effects, effect) ? rule.effects[effect] : undefined;
    if (effectRule === undefined || !rule.knownParameters.includes(parameter)) {
      return refuse("invalid_input");
    }
    const at = Object.hasOwn(rule.buses, bus) ? rule.buses[bus] : undefined;
    const selector = Object.hasOwn(effectRule.selector, bus) ? effectRule.selector[bus] : undefined;
    const field = Object.hasOwn(effectRule.parameters, parameter) ? effectRule.parameters[parameter] : undefined;
    if (at === undefined || selector === undefined || field === undefined) {
      // A known bus, effect or parameter that this combination lacks.
      return refuse("unsupported_operation");
    }
    return { bus, at, selector, field, effect };
  };
  /** The static plan check: the value, or for a context value its type-wide envelope. */
  const staticCheck = (field: { value: ValueRule | ContextStopsRule }, effect: string, value: unknown) => {
    if (field.value.kind === "context-stops") {
      const envelope = field.value.envelope[effect];
      if (typeof value !== "number" || !Number.isFinite(value) || envelope === undefined || value < envelope.min || value > envelope.max) {
        return refuse("invalid_input");
      }
      return undefined;
    }
    const planned = codecOf(field.value).plan(value);
    return planned === undefined || planned === "unsupported" ? refuse("invalid_input") : planned;
  };
  /**
   * The prerequisite reads; the codec for the leaf. With `affected` (a dry
   * run after unsent writes, O13), an affected selector match or Room Size
   * conversion is reported in `unverified` instead of refused, and the leaf's
   * codec is null where its conversion is unverified.
   */
  const prepare = async (
    context: OperationContext,
    resolved: ReturnType<typeof resolve>,
    affected: ReadonlySet<UnverifiedCondition> = new Set(),
    unverified: UnverifiedCondition[] = [],
  ): Promise<Codec | null> => {
    const { raw } = await readRawValue(context, address(resolved.at.selector, 0));
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
      return failed("invalid_response");
    }
    const offered = Object.values(rule.effects).flatMap((each) => {
      const own = each?.selector[resolved.bus];
      return own === undefined ? [] : [own];
    });
    if (!offered.includes(raw)) {
      return failed("invalid_response");
    }
    const typeAffected = affected.has("fx_type_matches");
    if (typeAffected) {
      unverified.push("fx_type_matches");
    }
    const matches = raw === resolved.selector;
    if (!matches && !typeAffected) {
      return failed("precondition_failed");
    }
    const value = resolved.field.value;
    if (value.kind !== "context-stops") {
      return codecOf(value);
    }
    // The array is read only in the layout the live selector establishes: Room Size is read where the
    // selected type defines the same context slot (every REV-X type), and not interpreted otherwise.
    if (!matches) {
      const observed = Object.entries(rule.effects).find(([, each]) => each?.selector[resolved.bus] === raw)?.[0];
      const observedTables = observed === undefined ? undefined : value.contexts[observed];
      if (observedTables !== undefined) {
        const room = await readRawValue(context, address(resolved.at.array, value.contextSlot));
        if (decodeInteger(room.raw, 0, observedTables.length - 1) === undefined) {
          return failed("invalid_response");
        }
      }
      unverified.push("revx_room_size");
      return null;
    }
    const room = await readRawValue(context, address(resolved.at.array, value.contextSlot));
    const tables = value.contexts[resolved.effect] ?? [];
    const index = decodeInteger(room.raw, 0, tables.length - 1);
    if (index === undefined) {
      return failed("invalid_response");
    }
    if (affected.has("revx_room_size")) {
      unverified.push("revx_room_size");
      return null;
    }
    return contextCodec(value, tables[index] as readonly number[]);
  };
  const leaf = (resolved: ReturnType<typeof resolve>) => address(resolved.at.array, resolved.field.slot);
  const plannedWith = (codec: Codec, requested: V) => {
    const result = codec.plan(requested);
    return result === undefined || result === "unsupported" ? refuse("invalid_input") : result;
  };
  return {
    async read(context: OperationContext, target: unknown): Promise<Reading<V>> {
      const resolved = resolve(context.model, target);
      const codec = (await prepare(context, resolved)) as Codec;
      return readDecoded(context, leaf(resolved), (raw) => codec.decode(raw) as V | undefined);
    },
    /**
     * No static plan: an FX-return plan needs the live selector (and Room
     * Size), so a connection-free preview refuses it after the static checks;
     * `dryRun` performs those reads.
     */
    plan(model: string, target: unknown, requested: V): WritePlan<V> {
      const resolved = resolve(model, target);
      staticCheck(resolved.field, resolved.effect, requested);
      return refuse("invalid_input");
    },
    /** The static checks alone: bus, effect, parameter and value or its type-wide envelope. */
    validate(model: string, target: unknown, requested: V): void {
      const resolved = resolve(model, target);
      staticCheck(resolved.field, resolved.effect, requested);
    },
    dryRun: dryRunOf<V>(async (context, target, requested, affected) => {
      const resolved = resolve(context.model, target);
      staticCheck(resolved.field, resolved.effect, requested);
      const unverified: UnverifiedCondition[] = [];
      const codec = await prepare(context, resolved, affected, unverified);
      return { requested, planned: codec === null ? null : (plannedWith(codec, requested).planned as V), unverified };
    }),
    async write(context: OperationContext, target: unknown, requested: V): Promise<WriteResult<V>> {
      const resolved = resolve(context.model, target);
      staticCheck(resolved.field, resolved.effect, requested);
      const result = plannedWith((await prepare(context, resolved)) as Codec, requested);
      return writeRaw(context, leaf(resolved), result.raw as I64Text, { requested, planned: result.planned as V });
    },
  };
}

const SIDES = ["left", "right"] as const;

/** The bus and side a target names, and nothing else (`extra` keys allowed besides). */
function busSide(model: string, target: unknown, known: readonly string[], extra: readonly string[] = []) {
  modelOf(model);
  const own = targetOf<{ bus?: unknown; side?: unknown; band?: unknown }>(target, ["bus", "side", ...extra]);
  if (typeof own.bus !== "string" || !known.includes(own.bus) || !SIDES.includes(own.side as "left")) {
    return refuse("invalid_input");
  }
  return { bus: own.bus, side: own.side as (typeof SIDES)[number], band: own.band };
}

/** A per-side bus setting whose handler is built from `rule`: the target names a bus and one side. */
export function busSideRuleSetting<V>(rule: BusSideSettingRule) {
  // A port choice depends on the model; any other codec is built once.
  const fixed = rule.value.kind === "port-choice" ? undefined : codecOf(rule.value);
  // Only a setting with a sideless destination (oscillator.assign's FX) lets a target omit the side.
  const sideOptional = Object.values(rule.address).some((entry) => entry?.sideless === true);
  return handler<V>((model, target, write) => {
    modelOf(model);
    const own = targetOf<{ bus?: unknown; side?: unknown }>(target, ["bus", "side"]);
    if (typeof own.bus !== "string" || !rule.known.includes(own.bus)) {
      return refuse("invalid_input");
    }
    const bus = own.bus;
    const at = Object.hasOwn(rule.address, bus) ? rule.address[bus] : undefined;
    // A known bus without the setting is unsupported given a valid side, or no side where the setting takes
    // sideless targets; a missing side elsewhere, or a malformed one, is invalid.
    if (at === undefined) {
      const sideOk = SIDES.includes(own.side as "left") || (sideOptional && own.side === undefined);
      return refuse(sideOk ? "unsupported_operation" : "invalid_input");
    }
    // A mono bus takes no side; every other bus requires one.
    if (at?.sideless === true ? own.side !== undefined : !SIDES.includes(own.side as "left")) {
      return refuse("invalid_input");
    }
    const side = at?.sideless === true ? "left" : (own.side as (typeof SIDES)[number]);
    if (at === undefined || (write && !at.write)) {
      return refuse("unsupported_operation");
    }
    const codec = at.value === undefined ? (fixed ?? codecOf(rule.value, model)) : codecOf(at.value, model);
    const paramId = typeof at.paramId === "number" ? at.paramId : at.paramId[side];
    return { at: address(paramId, at.y[side]), codec };
  });
}

/**
 * The one representative EQ Type read a GEQ write or dry run makes first
 * (F07-G): the required type proceeds, another known type is
 * `precondition_failed`, any other value `invalid_response`.
 */
async function requireEqType(
  context: OperationContext,
  rule: GeqGainRule,
  at: { paramId: number; y: number },
  affected: ReadonlySet<UnverifiedCondition> = new Set(),
  unverified: UnverifiedCondition[] = [],
): Promise<void> {
  const type = await readRawValue(context, address(at.paramId, at.y));
  const token = rule.eqType.choices.find((choice) => choice.raw === type.raw)?.token;
  if (token === undefined) {
    failed("invalid_response");
  }
  // An earlier unsent write can change the type (O13): unverified, whatever it reads now.
  if (affected.has("geq_type_selected")) {
    unverified.push("geq_type_selected");
    return;
  }
  if (token !== rule.eqType.required) {
    failed("precondition_failed");
  }
}

/**
 * A GEQ bank setting other than gain (F07-G: On, Link, Limit) built on
 * `base`: reads go straight to the field; a write or dry run checks the
 * target and value, then reads the bus's EQ Type once (`requireEqType`),
 * then the write makes its one request. A connection-free preview refuses
 * it, since it needs the live type; `validate` makes the static checks.
 */
export function eqTypeGated<V, I = V>(base: ReturnType<typeof handler<V, I>>, gain: GeqGainRule) {
  /**
   * The caller's target, checked and read once before any request: its keys
   * must be `bus` and `side` only (anything else is refused before any other
   * value is read), and the type read and the write then address the same
   * bus and side even if the caller's object changes meanwhile.
   */
  const fixed = (target: unknown): unknown => {
    const own = targetOf<{ bus?: unknown; side?: unknown }>(target, ["bus", "side"]);
    const copy: { bus?: unknown; side?: unknown } = {};
    if (Object.hasOwn(own, "bus")) {
      copy.bus = own.bus;
    }
    if (Object.hasOwn(own, "side")) {
      copy.side = own.side;
    }
    return Object.freeze(copy);
  };
  const eqTypeOf = (target: unknown) => {
    const bus = (target as { bus?: unknown }).bus as string;
    return (gain.address[bus] as { eqType: { paramId: number; y: number } }).eqType;
  };
  return {
    ...base,
    plan(model: string, target: unknown, requested: I): WritePlan<I> {
      base.plan(model, target, requested);
      return refuse("invalid_input");
    },
    validate(model: string, target: unknown, requested: I): void {
      base.plan(model, target, requested);
    },
    dryRun: dryRunOf<I>(async (context, target, requested, affected) => {
      const own = fixed(target);
      const plan = base.plan(context.model, own, requested);
      const unverified: UnverifiedCondition[] = [];
      await requireEqType(context, gain, eqTypeOf(own), affected, unverified);
      return { requested: plan.requested, planned: plan.planned, unverified };
    }),
    async write(context: OperationContext, target: unknown, requested: I): Promise<WriteResult<I>> {
      const own = fixed(target);
      base.plan(context.model, own, requested);
      await requireEqType(context, gain, eqTypeOf(own));
      return base.write(context, own, requested);
    },
  };
}

/**
 * Flex12GEQ band gain (F07-G): a read takes the band's address directly; a
 * write (or dry-run) first reads the bus's EQ Type, which must be the GEQ,
 * then the side's Limit, whose range bounds the request before rounding.
 */
export function geqGainSetting(rule: GeqGainRule) {
  const resolve = (model: string, target: unknown, write: boolean) => {
    const { bus, side, band } = busSide(model, target, rule.known, ["band"]);
    if (typeof band !== "string" || !rule.bands.includes(band)) {
      return refuse("invalid_input");
    }
    const at = Object.hasOwn(rule.address, bus) ? rule.address[bus] : undefined;
    if (at === undefined || (write && !at.writableBands.includes(band))) {
      return refuse("unsupported_operation");
    }
    const index = rule.bands.indexOf(band);
    const leaf: ParameterAddress =
      at.perBand === "x"
        ? { paramId: at.paramId, x: `${index}`, y: `${at.y[side]}` }
        : address(at.paramId + index, at.y[side]);
    return { at, side, leaf };
  };
  const union = { min: Math.min(...rule.limits.map((limit) => limit.min)), max: Math.max(...rule.limits.map((limit) => limit.max)) };
  const staticCheck = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= union.min && value <= union.max ? value : refuse("invalid_input");
  /** The EQ Type and Limit reads; the side's current range, or null where an unsent write can change it (O13). */
  const prepare = async (
    context: OperationContext,
    resolved: ReturnType<typeof resolve>,
    affected: ReadonlySet<UnverifiedCondition> = new Set(),
    unverified: UnverifiedCondition[] = [],
  ) => {
    await requireEqType(context, rule, resolved.at.eqType, affected, unverified);
    const limit = await readRawValue(context, address(resolved.at.limit, resolved.at.y[resolved.side]));
    const index = decodeInteger(limit.raw, 0, rule.limits.length - 1);
    if (index === undefined) {
      return failed("invalid_response");
    }
    if (affected.has("geq_limit_allows_gain")) {
      unverified.push("geq_limit_allows_gain");
      return null;
    }
    return rule.limits[index] as { min: number; max: number };
  };
  const planWithin = (range: { min: number; max: number }, value: number) => {
    const planned = planOnGrid(value, range.min, range.max, 1 / rule.step);
    return planned === undefined ? refuse("invalid_input") : { planned, raw: `${Math.round(planned * rule.scale)}` as I64Text };
  };
  return {
    read(context: OperationContext, target: unknown): Promise<Reading<number>> {
      const { leaf } = resolve(context.model, target, false);
      return readDecoded(context, leaf, (raw) => {
        const value = decodeInteger(raw, rule.read.min, rule.read.max);
        return value === undefined ? undefined : value / rule.scale;
      });
    },
    /** No static plan: the range depends on the live Limit (`dryRun` reads it). */
    plan(model: string, target: unknown, requested: number): WritePlan<number> {
      resolve(model, target, true);
      staticCheck(requested);
      return refuse("invalid_input");
    },
    /** The static checks alone: the target and the union of every Limit's range. */
    validate(model: string, target: unknown, requested: number): void {
      resolve(model, target, true);
      staticCheck(requested);
    },
    dryRun: dryRunOf<number>(async (context, target, requested, affected) => {
      const resolved = resolve(context.model, target, true);
      const value = staticCheck(requested);
      const unverified: UnverifiedCondition[] = [];
      const range = await prepare(context, resolved, affected, unverified);
      return { requested, planned: range === null ? null : planWithin(range, value).planned, unverified };
    }),
    async write(context: OperationContext, target: unknown, requested: number): Promise<WriteResult<number>> {
      const resolved = resolve(context.model, target, true);
      // Static checks before any read.
      const value = staticCheck(requested);
      const { planned, raw } = planWithin((await prepare(context, resolved)) as { min: number; max: number }, value);
      return writeRaw(context, resolved.leaf, raw, { requested, planned });
    },
  };
}

/** A bus band setting whose handler is built from `rule`: the target names a bus and one band. */
export function busBandRuleSetting<V>(rule: BusBandSettingRule) {
  const value = rule.value;
  const codecs = bandCodecs(value, rule.bands);
  return handler<V>((model, target, write) => {
    modelOf(model);
    // A side key is taken only as undefined, as for the channel band targets.
    const own = targetOf<{ bus?: unknown; band?: unknown; side?: unknown }>(target, ["bus", "band", "side"]);
    if (
      own.side !== undefined ||
      typeof own.bus !== "string" ||
      !rule.known.includes(own.bus) ||
      typeof own.band !== "string" ||
      !rule.bands.includes(own.band)
    ) {
      return refuse("invalid_input");
    }
    const bands = Object.hasOwn(rule.address, own.bus) ? rule.address[own.bus] : undefined;
    const at = bands !== undefined && Object.hasOwn(bands, own.band) ? bands[own.band] : undefined;
    const codec = codecs.get(own.band);
    if (at === undefined || codec === undefined || (write && !at.write)) {
      return refuse("unsupported_operation");
    }
    return { at: address(at.paramId, at.y), codec };
  });
}

/** An output per-side setting whose handler is built from `rule`: the target names an output and one side. */
export function outputSideRuleSetting<V>(rule: OutputSideSettingRule) {
  return handler<V>((model, target) => {
    const known = modelOf(model);
    const own = targetOf<{ output?: unknown; side?: unknown }>(target, ["output", "side"]);
    if (typeof own.output !== "string" || !rule.known.includes(own.output) || !SIDES.includes(own.side as "left")) {
      return refuse("invalid_input");
    }
    const at = Object.hasOwn(rule.address, own.output) ? rule.address[own.output] : undefined;
    if (at === undefined || !at.models.includes(known)) {
      return refuse("unsupported_operation");
    }
    return { at: address(at.paramId, at.y[own.side as "left" | "right"]), codec: codecOf(at.value ?? rule.value, known) };
  });
}

/** An output setting whose handler is built from `rule`: the target names an output only. */
export function outputRuleSetting<V>(rule: OutputSettingRule) {
  const codec = codecOf(rule.value);
  return handler<V>((model, target) => {
    modelOf(model);
    // A side key is taken only as undefined, as the target type declares.
    const own = targetOf<{ output?: unknown; side?: unknown }>(target, ["output", "side"]);
    if (own.side !== undefined || typeof own.output !== "string" || !rule.known.includes(own.output)) {
      return refuse("invalid_input");
    }
    const at = Object.hasOwn(rule.address, own.output) ? rule.address[own.output] : undefined;
    return at === undefined ? refuse("unsupported_operation") : { at: address(at.paramId, at.y), codec };
  });
}

/**
 * A device-wide setting whose handler is built from `rule`: the target has no
 * keys. A model without it is unsupported. With write prerequisites, a write
 * or dry-run reads each applicable one in order first, stopping at the first
 * that does not allow it; the connection-free preview refuses such a setting.
 */
export function deviceRuleSetting<V>(rule: DeviceSettingRule) {
  const codec = codecOf(rule.value);
  const resolve = (model: string, target: unknown) => {
    const known = modelOf(model);
    targetOf<object>(target, []);
    return rule.models === undefined || rule.models.includes(known)
      ? { at: address(rule.address.paramId, rule.address.y), codec }
      : refuse("unsupported_operation");
  };
  const base = handler<V>(resolve);
  const checks = rule.writePrerequisites;
  if (checks === undefined) {
    return base;
  }
  /** The applicable checks of `model`, in order: none means the plan needs no device state. */
  const applicable = (model: string) => checks.filter((check) => check.models.includes(model));
  const prepare = async (
    context: OperationContext,
    affected: ReadonlySet<UnverifiedCondition> = new Set(),
    unverified: UnverifiedCondition[] = [],
  ) => {
    for (const check of applicable(context.model)) {
      const { raw } = await readRawValue(context, address(check.paramId, check.y));
      if (!check.allowed.includes(raw) && !check.refused.includes(raw)) {
        failed("invalid_response");
      }
      // An earlier unsent write can change this one (O13): unverified, whatever it reads now.
      if (check.condition !== undefined && affected.has(check.condition)) {
        unverified.push(check.condition);
        continue;
      }
      if (check.refused.includes(raw)) {
        failed("precondition_failed");
      }
    }
  };
  const planned = (model: string, target: unknown, requested: V) => {
    const { at } = resolve(model, target);
    const result = codec.plan(requested);
    return result === undefined || result === "unsupported"
      ? refuse(result === "unsupported" ? "unsupported_operation" : "invalid_input")
      : { at, raw: result.raw as I64Text, planned: result.planned as V };
  };
  return {
    read: base.read,
    /** A connection-free plan where `model` has no applicable prerequisite; refused where the plan needs device state. */
    plan(model: string, target: unknown, requested: V): WritePlan<V> {
      const { planned: p } = planned(model, target, requested);
      return applicable(model).length === 0 ? { requested, planned: p } : refuse("invalid_input");
    },
    /** The static checks alone: model, target and value; the prerequisites are read by the operation. */
    validate(model: string, target: unknown, requested: V): void {
      planned(model, target, requested);
    },
    dryRun: dryRunOf<V>(async (context, target, requested, affected) => {
      const { planned: p } = planned(context.model, target, requested);
      const unverified: UnverifiedCondition[] = [];
      await prepare(context, affected, unverified);
      return { requested, planned: p, unverified };
    }),
    async write(context: OperationContext, target: unknown, requested: V): Promise<WriteResult<V>> {
      const { at, raw, planned: p } = planned(context.model, target, requested);
      await prepare(context);
      return writeRaw(context, at, raw, { requested, planned: p });
    },
  };
}

