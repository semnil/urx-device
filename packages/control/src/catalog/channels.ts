// Channel identity (C12) and the basic channel controls' addresses
// (F03-H). A fixed stereo channel is named by its first channel number.

import type { Model } from "./models.js";

/** Mono channel numbers per model. */
export const MONO_CHANNELS: Readonly<Record<Model, readonly number[]>> = {
  URX22: [1, 2],
  URX44: [1, 2, 3, 4],
  URX44V: [1, 2, 3, 4],
};

/** Fixed stereo channels per model, by first channel number, in position order. */
export const STEREO_CHANNELS: Readonly<Record<Model, readonly number[]>> = {
  URX22: [3, 5, 7, 9],
  URX44: [5, 7, 9, 11],
  URX44V: [5, 7, 9, 11],
};

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
export const CHANNEL_PARAMS = {
  fader: { mono: 139, stereo: 266 },
  on: { mono: 140, stereo: 267 },
  pan: { mono: 141, stereo: 268 },
  polarity: { mono: 24, left: 211, right: 212 },
} as const;

/**
 * Mono pairs per model, by primary channel (F03-J): URX22 CH1/2; URX44 and
 * URX44V CH1/2 and CH3/4.
 */
export const MONO_PAIRS: Readonly<Record<Model, readonly number[]>> = {
  URX22: [1],
  URX44: [1, 3],
  URX44V: [1, 3],
};

/** Pair settings at the primary: x 0, y primary − 1. */
export const PAIR_PARAMS = { stereoLink: 23, panMode: 891 } as const;

/** Finite fader writes and reads, dB; written in 0.01 dB steps. */
export const FADER_DB = { min: -96, max: 10 } as const;
/** The raw value of negative infinity, and only that. */
export const FADER_NEGATIVE_INFINITY_RAW = "-32768";
/** Pan positions; negative left, zero center. */
export const PAN_RANGE = { min: -63, max: 63 } as const;
