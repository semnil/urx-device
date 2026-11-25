// Value rules of a setting definition (K35 definition metadata): the address
// per channel kind, the unit, and how values map to the wire both ways. The
// operations build their checks and conversions from these rules, and help or
// completion read the same rules offline, so neither restates them.

import type { ChannelKind } from "./channels.js";

/** A public unit; null for unitless numbers. */
export type ValueUnit = "dB" | "ms" | "Hz" | "%" | "ratio" | null;

/** A named value outside the finite range, with its exact raw value. */
export interface Sentinel {
  readonly value: string;
  readonly raw: string;
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
}

export type ValueRule = SwitchRule | ChoiceRule | GridRule | StopsRule | TextIndexRule | PortChoiceRule;

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

export type SettingRule = ChannelSettingRule | ChannelBandSettingRule | SendSettingRule;
