// The closed setting catalog (K2, K35). Each entry is one stable semantic
// setting ID with its definition; operations bind every ID to a handler.
// Rows are added per K35 catalog part (stages D7–D15).

import type { SourceToken } from "./inputs.js";

/** What every setting definition states, independent of its value types. */
export interface SettingDefinitionBase {
  /** Whether the setting can be read; every catalog setting is readable. */
  readonly readable: true;
  /** Whether the setting can be written. */
  readonly writable: boolean;
}

/**
 * The catalog: setting ID to definition. It is a static literal, never
 * extended at runtime (K2: no dynamic registration).
 */
export const settingDefinitions = {
  "input.gain": { readable: true, writable: true },
  "input.phantom": { readable: true, writable: true },
  "input.hi-z": { readable: true, writable: true },
  "input.clip-safe": { readable: true, writable: true },
  "input.clip-safe-active": { readable: true, writable: false },
  "source.gain": { readable: true, writable: true },
  "channel.on": { readable: true, writable: true },
  "channel.fader": { readable: true, writable: true },
  "channel.pan": { readable: true, writable: true },
  "channel.polarity": { readable: true, writable: true },
  "channel.source": { readable: true, writable: true },
  // Its write sequence needs evidence first (F03-J); readable until then.
  "channel.stereo-link": { readable: true, writable: false },
  "channel.pan-mode": { readable: true, writable: true },
} as const satisfies Record<string, SettingDefinitionBase>;

/** A known setting ID. */
export type SettingId = keyof typeof settingDefinitions;

/** A setting ID that can be written. */
export type WritableSettingId = {
  [K in SettingId]: (typeof settingDefinitions)[K]["writable"] extends true ? K : never;
}[SettingId];

/** A physical MIC/LINE jack, numbered from 1 (F02-B). */
export interface InputTarget {
  readonly input: number;
}

/** A digital input source (F03-G). */
export interface SourceTarget {
  readonly source: SourceToken;
}

/**
 * A whole channel by its C12 number: mono n, or a fixed stereo pair's first
 * number. It takes no side.
 */
export interface ChannelTarget {
  readonly channel: number;
  readonly side?: undefined;
}

/** A channel with a side, required for side-specific fixed stereo settings. */
export interface ChannelSideTarget {
  readonly channel: number;
  readonly side?: "left" | "right";
}

/** A fader level: finite dB, or negative infinity. */
export type FaderLevel = number | "-inf";

export type Polarity = "normal" | "inverted";

export type PanMode = "pan" | "balance";

/**
 * Each setting's target, observed value and requested value types (K35:
 * switches are boolean, levels are dB numbers).
 */
export interface SettingTypes {
  "input.gain": { target: InputTarget; value: number };
  "input.phantom": { target: InputTarget; value: boolean };
  "input.hi-z": { target: InputTarget; value: boolean };
  "input.clip-safe": { target: InputTarget; value: boolean };
  "input.clip-safe-active": { target: InputTarget; value: boolean };
  "source.gain": { target: SourceTarget; value: number };
  "channel.on": { target: ChannelTarget; value: boolean };
  "channel.fader": { target: ChannelTarget; value: FaderLevel };
  "channel.pan": { target: ChannelTarget; value: number };
  "channel.polarity": { target: ChannelSideTarget; value: Polarity };
  "channel.source": { target: ChannelSideTarget; value: string };
  "channel.stereo-link": { target: ChannelTarget; value: boolean };
  "channel.pan-mode": { target: ChannelTarget; value: PanMode };
}

// Every catalog ID has its types, and every typed ID is in the catalog.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const typesMatchCatalog: Exact<keyof SettingTypes, SettingId> = true;
void typesMatchCatalog;

/** The setting IDs, in catalog order. */
export function settingIds(): SettingId[] {
  return Object.keys(settingDefinitions) as SettingId[];
}
