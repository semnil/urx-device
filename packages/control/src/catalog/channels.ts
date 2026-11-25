// Channel identity (C12) and the basic channel controls' addresses
// (F03-H). A fixed stereo channel is named by its first channel number.

import { frozen } from "./frozen.js";
import type { Model } from "./models.js";

/** Mono channel numbers per model. */
export const MONO_CHANNELS: Readonly<Record<Model, readonly number[]>> = frozen({
  URX22: [1, 2],
  URX44: [1, 2, 3, 4],
  URX44V: [1, 2, 3, 4],
});

/** Fixed stereo channels per model, by first channel number, in position order. */
export const STEREO_CHANNELS: Readonly<Record<Model, readonly number[]>> = frozen({
  URX22: [3, 5, 7, 9],
  URX44: [5, 7, 9, 11],
  URX44V: [5, 7, 9, 11],
});

export type ChannelKind = "mono" | "stereo";

/** A channel on a model: its kind and raw index (mono n − 1, or stereo position). */
export interface ChannelIndex {
  readonly kind: ChannelKind;
  readonly index: number;
}

/** The channel `channel` names on `model`, or undefined (no aliases, no pair tokens). */
export function channelIndex(model: Model, channel: unknown): ChannelIndex | undefined {
  if (typeof channel !== "number" || !Number.isInteger(channel)) {
    return undefined;
  }
  if (MONO_CHANNELS[model].includes(channel)) {
    return { kind: "mono", index: channel - 1 };
  }
  const position = STEREO_CHANNELS[model].indexOf(channel);
  return position < 0 ? undefined : { kind: "stereo", index: position };
}

/** Parameter IDs of the basic controls (F03-H); address x 0, y the raw index. */
export const CHANNEL_PARAMS = frozen({
  fader: { mono: 139, stereo: 266 },
  on: { mono: 140, stereo: 267 },
  pan: { mono: 141, stereo: 268 },
  polarity: { mono: 24, left: 211, right: 212 },
} as const);

/**
 * Mono pairs per model, by primary channel (F03-J): URX22 CH1/2; URX44 and
 * URX44V CH1/2 and CH3/4.
 */
export const MONO_PAIRS: Readonly<Record<Model, readonly number[]>> = frozen({
  URX22: [1],
  URX44: [1, 3],
  URX44V: [1, 3],
});

/** Pair settings at the primary: x 0, y primary − 1. */
export const PAIR_PARAMS = frozen({ stereoLink: 23, panMode: 891 } as const);

/** Name and color IDs (F03-K): mono 18 / 20, fixed stereo 206 / 208. */
export const IDENTITY_PARAMS = frozen({
  name: { mono: 18, stereo: 206 },
  color: { mono: 20, stereo: 208 },
} as const);

/** Palette tokens in raw index order (F03-K). */
export const CHANNEL_COLORS = frozen([
  "blue",
  "orange",
  "yellow",
  "purple",
  "cyan",
  "magenta",
  "red",
  "green",
  "light-green",
  "white",
  "off",
] as const);

/** Rec Point stages in raw value order (F03-R), and the stages fixed stereo has. */
export const REC_POINTS = frozen(["pre-gate", "pre-comp", "pre-eq", "pre-insert-fx", "pre-fader"] as const);
export const STEREO_REC_POINTS: readonly (typeof REC_POINTS)[number][] = frozen(["pre-eq", "pre-fader"]);
/** Rec Point IDs: mono 137, fixed stereo 264. */
export const REC_POINT_PARAMS = frozen({ mono: 137, stereo: 264 } as const);

/** Names are written with at most this many Unicode scalar values. */
export const NAME_MAX_CODE_POINTS = 8;

/** Finite fader writes and reads, dB; written in 0.01 dB steps. */
export const FADER_DB = frozen({ min: -96, max: 10 } as const);
/** The raw value of negative infinity, and only that. */
export const FADER_NEGATIVE_INFINITY_RAW = "-32768";
/** Pan positions; negative left, zero center. */
export const PAN_RANGE = frozen({ min: -63, max: 63 } as const);

/**
 * The shared level rule (F03-H): finite FADER_DB on 0.01 dB over centi-dB raw,
 * and exactly the negative-infinity raw. Channel, bus and send levels use it.
 */
export const FADER_LEVEL_RULE = frozen({
  kind: "grid",
  unit: "dB",
  min: FADER_DB.min,
  max: FADER_DB.max,
  scale: 100,
  sentinel: { value: "-inf", raw: FADER_NEGATIVE_INFINITY_RAW },
} as const);

/** The shared PAN/BAL rule: integers within PAN_RANGE. Channel pan, send pan and bus balance use it. */
export const PAN_RULE = frozen({ kind: "grid", unit: null, min: PAN_RANGE.min, max: PAN_RANGE.max, scale: 1 } as const);
