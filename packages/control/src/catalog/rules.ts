// Value rules of a setting definition (K35 definition metadata): the address
// per channel kind, the unit, and how values map to the wire both ways. The
// operations build their checks and conversions from these rules, and help or
// completion read the same rules offline, so neither restates them.

import type { ChannelKind } from "./channels.js";

/** A public unit; null for unitless numbers. */
export type ValueUnit = "dB" | "ms" | "s" | "min" | "Hz" | "%" | "bpm" | "ratio" | null;

/** A named value outside the finite range, with its exact raw value. */
export interface Sentinel {
  readonly value: string;
  /** The raw value a write sends. */
  readonly raw: string;
  /** Other raw values a read also takes as the sentinel (one public meaning, no alias per raw). */
  readonly reads?: readonly string[];
}

/** On/off: on is raw 1, off raw 0. */
export interface SwitchRule {
  readonly kind: "switch";
}

/** Named choices in raw order 0, 1, … */
export interface ChoiceRule {
  readonly kind: "choice";
  readonly choices: readonly string[];
}

/**
 * Numbers on a uniform write grid within [min, max]: a write is range-checked
 * first, then rounded to the grid with lower ties, raw = value × scale +
 * offset (offset 0 when absent). The grid is `step` (default 1 / scale). A
 * read takes any integer raw from min × scale + offset to max × scale +
 * offset, kept unsnapped when it lies between write steps.
 */
export interface GridRule {
  readonly kind: "grid";
  readonly unit: ValueUnit;
  readonly min: number;
  readonly max: number;
  readonly scale: number;
  readonly step?: number;
  readonly offset?: number;
  readonly sentinel?: Sentinel;
}

/**
 * Numbers on a nonuniform stop table, `stops` in units of 1 / `scale`,
 * increasing: a write is range-checked against the first and last stop, then
 * goes to the nearest stop with lower ties. With `ordinal` absent, raw = the
 * stop, and a read takes any integer raw in `read` (default: first … last
 * stop) without snapping. With `ordinal`, raw = the stop's index + ordinal,
 * and a read takes exactly those raw values.
 */
export interface StopsRule {
  readonly kind: "stops";
  readonly unit: ValueUnit;
  readonly stops: readonly number[];
  readonly scale: number;
  readonly ordinal?: number;
  readonly read?: { readonly min: number; readonly max: number };
  readonly sentinel?: Sentinel;
}

/**
 * An integer from `min` to `max` on a string parameter as exactly `digits`
 * ASCII digits, zero-padded; `labels[n − min]` names n for help only.
 */
export interface TextIndexRule {
  readonly kind: "text-index";
  readonly unit: null;
  readonly min: number;
  readonly max: number;
  readonly digits: number;
  readonly labels: readonly string[];
}

/**
 * A routing-source choice on an unsigned 32-bit port identifier: each model's
 * tokens with the identifier a write sends, untagged, and `none` as the exact
 * sentinel. A read strips an optional high tag bit after the sentinel check
 * and takes only an identifier of the model's tokens. `known` lists every
 * token any model has: one of them absent from the model is unsupported
 * there, anything else invalid.
 */
export interface PortChoiceRule {
  readonly kind: "port-choice";
  readonly none: Sentinel;
  readonly known: readonly string[];
  readonly byModel: { readonly [model: string]: readonly { readonly token: string; readonly id: number }[] };
  /** The tokens a write may send, `none` included where listed; absent: every readable token and `none`. */
  readonly writes?: readonly string[];
  /** Whether a write sends the identifier with the high tag bit set. */
  readonly tagged?: boolean;
}

/**
 * A display name (F03-K): a write is exactly 0 … `maxCodePoints` Unicode
 * scalar values without control characters, sent as given on the string
 * parameter; a read takes the received text as is, or a numeric preset index.
 */
export interface NameRule {
  readonly kind: "name";
  readonly maxCodePoints: number;
}

/**
 * A selector on an unsigned 32-bit value: each token this target takes with
 * its exact raw value, and `none`, where present, as the exact sentinel.
 * `known` lists every token any target of the setting takes: one of them this
 * target lacks is unsupported, anything else invalid. A read takes only the
 * listed raw values.
 */
export interface SelectorRule {
  readonly kind: "selector";
  /** The nothing-selected sentinel, for a selector that has one. */
  readonly none?: Sentinel;
  readonly known: readonly string[];
  readonly choices: readonly { readonly token: string; readonly raw: string }[];
  /**
   * The defined limits of each choice and of `none` where the selector has
   * one, by token, for help. A definition, not a measurement; nothing reads
   * the rate, link or slot state to check them. Undefined for a token this
   * target does not take.
   */
  readonly limits?: { readonly [token: string]: SelectorLimits | undefined };
}

/** A selector choice's defined limits. */
export interface SelectorLimits {
  /** The highest sample rate in Hz it runs at; null when it has no ceiling. */
  readonly maxRateHz: number | null;
  /** True when a stereo-linked pair cannot take it. */
  readonly monoOnly: boolean;
  /** The device-wide processing slot it shares; null when it takes none. */
  readonly slot: string | null;
}

/** Numbers from a fixed set, raw = value: no rounding to a member (F11-C). */
export interface NumericSetRule {
  readonly kind: "numeric-set";
  readonly unit: ValueUnit;
  readonly values: readonly number[];
}

export type ValueRule =
  | NumericSetRule
  | SwitchRule
  | ChoiceRule
  | GridRule
  | StopsRule
  | TextIndexRule
  | PortChoiceRule
  | NameRule
  | SelectorRule;

/** A whole-channel setting: its parameter ID per channel kind and its value rule. */
export interface ChannelSettingRule {
  readonly target: "channel";
  readonly address: { readonly [K in ChannelKind]?: number };
  readonly value: ValueRule;
}

/** A value rule for each band that has the setting. */
export interface ByBandRule {
  readonly kind: "by-band";
  /** Undefined for a band without the setting. */
  readonly rules: { readonly [band: string]: ValueRule | undefined };
}

/** A band's parameter ID per channel kind; a kind without one lacks the setting. */
export type BandAddress = { readonly [K in ChannelKind]?: number };

/**
 * A setting of one band of a channel: the target names a channel and exactly
 * one of `bands`. A band with no address, or a channel kind with no ID for
 * it, lacks the setting.
 */
export interface ChannelBandSettingRule {
  readonly target: "channel-band";
  readonly bands: readonly string[];
  /** Undefined for a band without the setting. */
  readonly address: { readonly [band: string]: BandAddress | undefined };
  readonly value: ValueRule | ByBandRule;
}

/**
 * One send route family: its parameter ID is base + stride × b for the
 * zero-based destination index b, at y the source's index (mono N − 1, the
 * fixed stereo position, or FX number − 1). `write` is false where the design
 * leaves the write unbound (a read-only field, or a write multiplicity that
 * awaits evidence under F03-G).
 */
export interface SendRoute {
  readonly from: "mono" | "stereo" | "fx";
  readonly to: "mix" | "fx";
  readonly base: number;
  readonly stride: number;
  readonly write: boolean;
}

/**
 * A send setting: the target names a source and a destination token. A known
 * token that is no send source or destination, or a pair without a route, is
 * unsupported; an unknown token is invalid.
 */
export interface SendSettingRule {
  readonly target: "send";
  readonly knownSources: readonly string[];
  readonly knownDestinations: readonly string[];
  readonly routes: readonly SendRoute[];
  readonly value: ValueRule;
}

/**
 * A bus setting: the target names one bus token. A known bus without an
 * address has no such field (unsupported); `write` is false where the design
 * leaves the write unbound (an F03-G instance count that awaits evidence).
 */
export interface BusSettingRule {
  readonly target: "bus";
  readonly known: readonly string[];
  /** Undefined for a known bus without the setting. */
  readonly address: {
    readonly [bus: string]:
      | { readonly paramId: number; readonly y: number; readonly write: boolean; readonly value?: ValueRule }
      | undefined;
  };
  /** The value rule; an address entry's own `value` replaces it for that bus. */
  readonly value: ValueRule;
}

/**
 * REV-X Reverb Time (F06-F): seconds from 70 stops chosen by the checked type
 * and a freshly read Room Size; `tables[type][roomSize]` in ms (× 1000 s),
 * raw = stop index. `envelope` is each type's range over every Room Size.
 */
export interface ContextStopsRule {
  readonly kind: "context-stops";
  readonly unit: ValueUnit;
  readonly scale: number;
  readonly contextSlot: number;
  readonly contexts: { readonly [effect: string]: readonly (readonly number[])[] | undefined };
  readonly envelope: { readonly [effect: string]: { readonly min: number; readonly max: number } | undefined };
}

/** One FX-return effect: its selector value per bus that offers it, and its parameters by slot. */
export interface FxEffectRule {
  readonly selector: { readonly [bus: string]: string | undefined };
  readonly parameters: { readonly [parameter: string]: { readonly slot: number; readonly value: ValueRule | ContextStopsRule } | undefined };
}

/**
 * An FX-return parameter (F06-F): the target names an FX bus, the expected
 * effect and a parameter. The bus's selector is read first and must equal the
 * effect; the parameter is then one request at the bus's array, y the slot.
 */
export interface FxParameterRule {
  readonly target: "fx-parameter";
  readonly buses: { readonly [bus: string]: { readonly selector: number; readonly array: number } | undefined };
  readonly knownBuses: readonly string[];
  readonly effects: { readonly [effect: string]: FxEffectRule | undefined };
  readonly knownParameters: readonly string[];
}

/** One side of a bus: its parameter ID and the y of each side. */
export interface BusSideAddress {
  /** One ID for both sides, or one per side. */
  readonly paramId: number | { readonly left: number; readonly right: number };
  readonly y: { readonly left: number; readonly right: number };
  readonly write: boolean;
  /** This bus's own value rule, replacing the shared one. */
  readonly value?: ValueRule;
  /** A mono bus of a per-side setting: it takes no side, and `y.left` is its y. */
  readonly sideless?: true;
}

/** A per-side bus setting: the target names a bus and a side. */
export interface BusSideSettingRule {
  readonly target: "bus-side";
  readonly known: readonly string[];
  readonly address: { readonly [bus: string]: BusSideAddress | undefined };
  readonly value: ValueRule;
}

/**
 * Flex12GEQ band gain (F07-G): the target names a bus, a side and a band
 * identifier. A write first reads the bus's EQ Type (representative y), which
 * must be `type`, then the side's Limit, whose range bounds the request
 * before rounding to `step`. Raw = dB × scale.
 */
export interface GeqGainRule {
  readonly target: "bus-side-band";
  readonly known: readonly string[];
  readonly bands: readonly string[];
  readonly address: {
    readonly [bus: string]:
      | {
          /** The ID of band 0; `perBand` "x" steps x by the band index, "id" steps the ID. */
          readonly paramId: number;
          readonly perBand: "x" | "id";
          readonly y: { readonly left: number; readonly right: number };
          /** The bands a write may address; the others are read-only. */
          readonly writableBands: readonly string[];
          readonly eqType: { readonly paramId: number; readonly y: number };
          readonly limit: number;
        }
      | undefined;
  };
  readonly eqType: { readonly required: string; readonly choices: readonly { readonly token: string; readonly raw: string }[] };
  readonly limits: readonly { readonly token: string; readonly min: number; readonly max: number }[];
  readonly unit: "dB";
  readonly scale: number;
  readonly step: number;
  readonly read: { readonly min: number; readonly max: number };
}

/**
 * A band setting of a bus (F07-P): the target names a bus and one band. A
 * band without an address lacks the setting; `write` false leaves the write
 * unbound.
 */
export interface BusBandSettingRule {
  readonly target: "bus-band";
  readonly known: readonly string[];
  readonly bands: readonly string[];
  readonly address: {
    readonly [bus: string]: { readonly [band: string]: { readonly paramId: number; readonly y: number; readonly write: boolean } | undefined } | undefined;
  };
  readonly value: ValueRule | ByBandRule;
}

/**
 * An output destination's per-side setting (F07-R): the target names an
 * output and a side. An output a model lacks is unsupported there; an address
 * entry's `value` replaces the shared value rule for that output.
 */
export interface OutputSideSettingRule {
  readonly target: "output-side";
  readonly known: readonly string[];
  readonly address: {
    readonly [output: string]:
      | {
          readonly paramId: number;
          readonly y: { readonly left: number; readonly right: number };
          readonly models: readonly string[];
          readonly value?: ValueRule;
        }
      | undefined;
  };
  readonly value: ValueRule;
}

/** An output destination's whole setting (F08-M): the target names an output only. */
export interface OutputSettingRule {
  readonly target: "output";
  readonly known: readonly string[];
  readonly address: { readonly [output: string]: { readonly paramId: number; readonly y: number } | undefined };
  readonly value: ValueRule;
}

/**
 * A state a write requires (F11-C): one read of `paramId`, y, on the listed
 * models only. `allowed` raw values let the write proceed, `refused` ones are
 * a failed precondition, and any other value is an invalid response.
 */
export interface WritePrerequisite {
  readonly paramId: number;
  readonly y: number;
  readonly models: readonly string[];
  readonly allowed: readonly string[];
  readonly refused: readonly string[];
}

/** A device-wide setting (F08-C): the target is empty. */
export interface DeviceSettingRule {
  readonly target: "device";
  readonly address: { readonly paramId: number; readonly y: number };
  readonly value: ValueRule;
  /** The models that have it; absent: every model. */
  readonly models?: readonly string[];
  /** The reads a write (or dry-run) performs first, in order. */
  readonly writePrerequisites?: readonly WritePrerequisite[];
}

export type SettingRule =
  | DeviceSettingRule
  | OutputSettingRule
  | OutputSideSettingRule
  | BusBandSettingRule
  | ChannelSettingRule
  | ChannelBandSettingRule
  | SendSettingRule
  | BusSettingRule
  | FxParameterRule
  | BusSideSettingRule
  | GeqGainRule;
