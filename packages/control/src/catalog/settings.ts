// The closed setting catalog (K2, K35). Each entry is one stable semantic
// setting ID with its definition; operations bind every ID to a handler.
// Rows are added per K35 catalog part (stages D7–D15).

import { frozen } from "./frozen.js";
import type { CHANNEL_COLORS, REC_POINTS } from "./channels.js";
import { DYNAMICS_RULES } from "./dynamics.js";
import type { I64Text } from "./i64.js";
import type { SourceToken } from "./inputs.js";
import type { PROCESSING_MODES } from "./processing.js";
import type { SettingRule } from "./rules.js";

/** What every setting definition states, independent of its value types. */
export interface SettingDefinitionBase {
  /** Whether the setting can be read; every catalog setting is readable. */
  readonly readable: true;
  /** Whether the setting can be written. */
  readonly writable: boolean;
  /** The target, address and value rule, for the settings that carry one (K35 metadata). */
  readonly rule?: SettingRule;
}

/**
 * The catalog: setting ID to definition. It is a static literal, never
 * extended at runtime (K2: no dynamic registration).
 */
export const settingDefinitions = frozen({
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
  "channel.name": { readable: true, writable: true },
  "channel.color": { readable: true, writable: true },
  "channel.rec-point": { readable: true, writable: true },
  "channel.processing-mode": { readable: true, writable: true },
  "channel.hpf.on": { readable: true, writable: true },
  "channel.hpf.frequency": { readable: true, writable: true },
  "channel.gate.on": { readable: true, writable: true },
  "channel.comp.on": { readable: true, writable: true },
  "channel.eq.on": { readable: true, writable: true },
  "channel.ssmcs.on": { readable: true, writable: true },
  "channel.ssmcs.comp.on": { readable: true, writable: true },
  "channel.ssmcs.eq.on": { readable: true, writable: true },
  "channel.gate.threshold": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.gate.threshold"] },
  "channel.gate.range": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.gate.range"] },
  "channel.gate.attack": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.gate.attack"] },
  "channel.gate.hold": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.gate.hold"] },
  "channel.gate.decay": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.gate.decay"] },
  "channel.comp.threshold": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.comp.threshold"] },
  "channel.comp.ratio": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.comp.ratio"] },
  "channel.comp.knee": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.comp.knee"] },
  "channel.comp.gain": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.comp.gain"] },
  "channel.comp.attack": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.comp.attack"] },
  "channel.comp.release": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.comp.release"] },
  "channel.comp.auto-makeup": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.comp.auto-makeup"] },
  "channel.comp.one-knob.on": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.comp.one-knob.on"] },
  "channel.comp.one-knob.level": { readable: true, writable: true, rule: DYNAMICS_RULES["channel.comp.one-knob.level"] },
} as const satisfies Record<string, SettingDefinitionBase>);

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

/** An observed channel name: the received text, or a numeric preset index (F03-K). */
export type ChannelName = { kind: "text"; text: string } | { kind: "preset"; presetIndex: I64Text };

export type ChannelColor = (typeof CHANNEL_COLORS)[number];

export type RecPoint = (typeof REC_POINTS)[number];

export type ProcessingMode = (typeof PROCESSING_MODES)[number];

/** A GATE range: finite dB, or negative infinity (F04-D). */
export type GateRange = number | "-inf";
/** A compressor ratio: finite N for N:1, or infinity (F04-D). */
export type CompRatio = number | "inf";
export type CompKnee = "soft" | "medium" | "hard";

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
  "channel.name": { target: ChannelTarget; value: ChannelName; input: string };
  "channel.color": { target: ChannelTarget; value: ChannelColor };
  "channel.rec-point": { target: ChannelTarget; value: RecPoint };
  "channel.processing-mode": { target: ChannelTarget; value: ProcessingMode };
  "channel.hpf.on": { target: ChannelTarget; value: boolean };
  "channel.hpf.frequency": { target: ChannelTarget; value: number };
  "channel.gate.on": { target: ChannelTarget; value: boolean };
  "channel.comp.on": { target: ChannelTarget; value: boolean };
  "channel.eq.on": { target: ChannelTarget; value: boolean };
  "channel.ssmcs.on": { target: ChannelTarget; value: boolean };
  "channel.ssmcs.comp.on": { target: ChannelTarget; value: boolean };
  "channel.ssmcs.eq.on": { target: ChannelTarget; value: boolean };
  "channel.gate.threshold": { target: ChannelTarget; value: number };
  "channel.gate.range": { target: ChannelTarget; value: GateRange };
  "channel.gate.attack": { target: ChannelTarget; value: number };
  "channel.gate.hold": { target: ChannelTarget; value: number };
  "channel.gate.decay": { target: ChannelTarget; value: number };
  "channel.comp.threshold": { target: ChannelTarget; value: number };
  "channel.comp.ratio": { target: ChannelTarget; value: CompRatio };
  "channel.comp.knee": { target: ChannelTarget; value: CompKnee };
  "channel.comp.gain": { target: ChannelTarget; value: number };
  "channel.comp.attack": { target: ChannelTarget; value: number };
  "channel.comp.release": { target: ChannelTarget; value: number };
  "channel.comp.auto-makeup": { target: ChannelTarget; value: boolean };
  "channel.comp.one-knob.on": { target: ChannelTarget; value: boolean };
  "channel.comp.one-knob.level": { target: ChannelTarget; value: number };
}

// Every catalog ID has its types, and every typed ID is in the catalog.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const typesMatchCatalog: Exact<keyof SettingTypes, SettingId> = true;
void typesMatchCatalog;

/** The setting IDs, in catalog order. */
export function settingIds(): SettingId[] {
  return Object.keys(settingDefinitions) as SettingId[];
}
