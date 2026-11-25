// Ordinary four-band EQ and EQ 1-knob rules (F04-E): addresses resolved from
// the EQ-ON anchor of the channel kind. Band i (0…3) has its base at
// anchor + 5 + 5i: on, type, Q, frequency, gain at base + 0…4; only the low
// and high bands have a type. 1-knob on/type/level are anchor + 2/3/4.

import type { ChannelKind } from "./channels.js";
import { frozen } from "./frozen.js";
import { PROCESSING_SWITCHES } from "./processing.js";
import type { ChannelBandSettingRule, ChannelSettingRule, GridRule } from "./rules.js";

/** EQ-ON anchors: ordinary mono bank 44, fixed stereo 213. */
export const EQ_ANCHORS = PROCESSING_SWITCHES["eq.on"].ids;

export const EQ_BANDS = frozen(["low", "low-mid", "high-mid", "high"] as const);

/** Field offsets from a band's base. */
export const EQ_BAND_FIELDS = frozen({ on: 0, type: 1, q: 2, frequency: 3, gain: 4 } as const);

/** 1-knob field offsets from the anchor. */
export const EQ_ONE_KNOB_FIELDS = frozen({ on: 2, type: 3, level: 4 } as const);

export const EQ_ONE_KNOB_TYPES = frozen(["intensity", "vocal", "loudness"] as const);

function ids(offset: number): { [K in ChannelKind]: number } {
  return { mono: EQ_ANCHORS.mono + offset, stereo: EQ_ANCHORS.stereo + offset };
}

function bandAddress(field: keyof typeof EQ_BAND_FIELDS, bands: readonly (typeof EQ_BANDS)[number][] = EQ_BANDS) {
  return Object.fromEntries(
    bands.map((band) => [band, ids(5 + 5 * EQ_BANDS.indexOf(band) + EQ_BAND_FIELDS[field])]),
  ) as { readonly [band: string]: { readonly [K in ChannelKind]?: number } };
}

const Q: GridRule = { kind: "grid", unit: null, min: 0.5, max: 16, scale: 100 };
const FREQUENCY: GridRule = { kind: "grid", unit: "Hz", min: 20, max: 20000, scale: 10 };
const GAIN: GridRule = { kind: "grid", unit: "dB", min: -18, max: 18, scale: 100 };

const band = (field: keyof typeof EQ_BAND_FIELDS, value: ChannelBandSettingRule["value"], bands?: readonly (typeof EQ_BANDS)[number][]) =>
  ({ target: "channel-band", bands: EQ_BANDS, address: bandAddress(field, bands), value }) satisfies ChannelBandSettingRule;

export const EQ_RULES = frozen({
  "channel.eq.band.on": band("on", { kind: "switch" }),
  // Only low and high have a type; the middle bands are fixed peaking.
  "channel.eq.band.type": band(
    "type",
    {
      kind: "by-band",
      rules: {
        low: { kind: "choice", choices: ["peaking", "shelving", "hpf"] },
        high: { kind: "choice", choices: ["peaking", "shelving", "lpf"] },
      },
    },
    ["low", "high"],
  ),
  "channel.eq.band.q": band("q", Q),
  "channel.eq.band.frequency": band("frequency", FREQUENCY),
  "channel.eq.band.gain": band("gain", GAIN),
  "channel.eq.one-knob.on": { target: "channel", address: ids(EQ_ONE_KNOB_FIELDS.on), value: { kind: "switch" } },
  "channel.eq.one-knob.type": {
    target: "channel",
    address: ids(EQ_ONE_KNOB_FIELDS.type),
    value: { kind: "choice", choices: EQ_ONE_KNOB_TYPES },
  },
  "channel.eq.one-knob.level": {
    target: "channel",
    address: ids(EQ_ONE_KNOB_FIELDS.level),
    value: { kind: "grid", unit: "%", min: 0, max: 100, scale: 1 },
  },
} as const satisfies Record<string, ChannelSettingRule | ChannelBandSettingRule>);
