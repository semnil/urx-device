// Value rules of a setting definition (K35 definition metadata): the address
// per channel kind, the unit, and how values map to the wire both ways. The
// operations build their checks and conversions from these rules, and help or
// completion read the same rules offline, so neither restates them.

import type { ChannelKind } from "./channels.js";

/** A public unit; null for unitless numbers. */
export type ValueUnit = "dB" | "ms" | "ratio" | null;

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
 * Numbers on a uniform grid of 1 / `scale` within [min, max]: a write is
 * range-checked first, then rounded to the grid with lower ties, raw =
 * value × scale. A read takes any integer raw in [min × scale, max × scale].
 */
export interface GridRule {
  readonly kind: "grid";
  readonly unit: ValueUnit;
  readonly min: number;
  readonly max: number;
  readonly scale: number;
  readonly sentinel?: Sentinel;
}

/**
 * Numbers on a nonuniform stop table, `stops` in raw units (value × scale),
 * increasing: a write is range-checked against the first and last stop, then
 * goes to the nearest stop with lower ties, raw = the stop. A read takes any
 * integer raw in `read` (default: first … last stop) without snapping.
 */
export interface StopsRule {
  readonly kind: "stops";
  readonly unit: ValueUnit;
  readonly stops: readonly number[];
  readonly scale: number;
  readonly read?: { readonly min: number; readonly max: number };
  readonly sentinel?: Sentinel;
}

export type ValueRule = SwitchRule | ChoiceRule | GridRule | StopsRule;

/** A whole-channel setting: its parameter ID per channel kind and its value rule. */
export interface ChannelSettingRule {
  readonly target: "channel";
  readonly address: { readonly [K in ChannelKind]?: number };
  readonly value: ValueRule;
}

export type SettingRule = ChannelSettingRule;
