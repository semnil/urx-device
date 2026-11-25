// Physical inputs (F02-B) and source-owned digital gain (F03-G): model
// coverage, addresses and ranges. Source and router references are in the
// design record; nothing here was measured on hardware.

import { frozen } from "./frozen.js";
import type { Model } from "./models.js";

/** Physical MIC/LINE jacks per model, numbered from 1. */
export const INPUT_JACKS: Readonly<Record<Model, readonly number[]>> = frozen({
  URX22: [1, 2],
  URX44: [1, 2, 3, 4],
  URX44V: [1, 2, 3, 4],
});

/** The jacks with HI-Z per model. */
export const HI_Z_JACKS: Readonly<Record<Model, readonly number[]>> = frozen({
  URX22: [2],
  URX44: [3, 4],
  URX44V: [3, 4],
});

/** Parameter IDs of the physical-input settings; address x 0, y jack − 1. */
export const INPUT_PARAMS = frozen({
  gain: 1,
  phantom: 0,
  hiZ: 6,
  clipSafe: 5,
  clipSafeActive: 864,
} as const);

/** Physical input gain, dB: written in whole dB within this range. */
export const INPUT_GAIN_DB = frozen({ min: -8, max: 70 } as const);

/** Source gain, dB: written in whole dB within this range. */
export const SOURCE_GAIN_DB = frozen({ min: -24, max: 24 } as const);

export const SOURCE_TOKENS = frozen([
  "aux",
  "sd-playback",
  "usb-daw-1-2",
  "usb-daw-3-4",
  "usb-daw-5-6",
  "usb-daw-7-8",
  "usb-daw-9-10",
  "usb-daw-11-12",
  "usb-main-a",
  "usb-main-b",
  "usb-main-c",
  "usb-sub",
  "hdmi",
] as const);

export type SourceToken = (typeof SOURCE_TOKENS)[number];

export interface SourceGainAddress {
  readonly models: readonly Model[];
  readonly paramId: number;
  /** Known instance `y` values; the first is the one read (F03-G). */
  readonly instances: readonly number[];
  /**
   * The instances a write sends, in order, when its write sequence is
   * established; null while the evidence is missing (F03-G, V-HW).
   */
  readonly writes: readonly number[] | null;
}

const ALL: readonly Model[] = ["URX22", "URX44", "URX44V"];
const LARGER: readonly Model[] = ["URX44", "URX44V"];

/** Source gain addresses; x is 0 throughout. */
export const SOURCE_GAIN: Readonly<Record<SourceToken, SourceGainAddress>> = frozen({
  aux: { models: ALL, paramId: 9, instances: [0, 1], writes: null },
  "sd-playback": { models: LARGER, paramId: 11, instances: [0, 1], writes: null },
  "usb-daw-1-2": { models: ALL, paramId: 12, instances: [0], writes: [0] },
  "usb-daw-3-4": { models: ALL, paramId: 12, instances: [2], writes: [2] },
  "usb-daw-5-6": { models: ALL, paramId: 12, instances: [4], writes: [4] },
  "usb-daw-7-8": { models: ALL, paramId: 12, instances: [6], writes: [6] },
  "usb-daw-9-10": { models: ALL, paramId: 12, instances: [8], writes: [8] },
  "usb-daw-11-12": { models: LARGER, paramId: 12, instances: [10], writes: [10] },
  "usb-main-a": { models: ALL, paramId: 13, instances: [0, 1], writes: null },
  "usb-main-b": { models: ALL, paramId: 14, instances: [0, 1], writes: null },
  "usb-main-c": { models: ALL, paramId: 15, instances: [0, 1], writes: null },
  "usb-sub": { models: ALL, paramId: 16, instances: [0, 1], writes: null },
  hdmi: { models: ["URX44V"], paramId: 17, instances: [0, 1], writes: null },
});

export function isSourceToken(value: unknown): value is SourceToken {
  return typeof value === "string" && (SOURCE_TOKENS as readonly string[]).includes(value);
}
