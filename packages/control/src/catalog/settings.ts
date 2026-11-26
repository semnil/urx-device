// The closed setting catalog (K2, K35). Each entry is one stable semantic
// setting ID with its definition; operations bind every ID to a handler.
// Rows are added per K35 catalog part (stages D7–D15).

import { frozen } from "./frozen.js";
import type { CHANNEL_COLORS, REC_POINTS } from "./channels.js";
import { BASIC_RULES } from "./basic-rules.js";
import { DUCKER_RULES } from "./ducker.js";
import { SEND_RULES } from "./sends.js";
import { BUS_RULES, CHANNEL_STEREO_ASSIGN_RULE, type BUS_TOKENS } from "./buses.js";
import { INSERT_FX_RULES, type INSERT_FX_EFFECTS } from "./insert-fx.js";
import { FX_RETURN_RULES, type FX_RETURN_EFFECTS } from "./fx-return.js";
import { OUTPUT_EQ_RULES, type GEQ_BANDS } from "./output-eq.js";
import { OUTPUT_PEQ_RULES } from "./output-peq.js";
import { CUE_RULES, MONITOR_RULES, OUTPUT_SOURCE_RULES, STREAM_DELAY_RULES, type OUTPUT_TOKENS } from "./output-routing.js";
import { OSCILLATOR_RULES } from "./oscillator.js";
import { DEVICE_RULES } from "./device.js";
import { INTEGRATION_RULES, KNOB_RULES } from "./integration-panel.js";
import { SCENE_RECORDER_RULES } from "./scene-recorder.js";
import { DYNAMICS_RULES } from "./dynamics.js";
import type { I64Text } from "./i64.js";
import { EQ_RULES, type EQ_BANDS, type EQ_ONE_KNOB_TYPES } from "./eq.js";
import type { SourceToken } from "./inputs.js";
import type { PROCESSING_MODES } from "./processing.js";
import type { SettingRule } from "./rules.js";
import { SSMCS_RULES, type SSMCS_BANDS } from "./ssmcs.js";

/** What every setting definition states, independent of its value types. */
export interface SettingDefinitionBase {
  /** Whether the setting can be read; every catalog setting is readable. */
  readonly readable: true;
  /** Whether the setting can be written. */
  readonly writable: boolean;
  /** The target, address and value rule (K35 metadata): the operations are built from it. */
  readonly rule: SettingRule;
}

/**
 * The catalog: setting ID to definition. It is a static literal, never
 * extended at runtime (K2: no dynamic registration).
 */
export const settingDefinitions = frozen({
  "input.gain": { readable: true, writable: true, rule: BASIC_RULES["input.gain"] },
  "input.phantom": { readable: true, writable: true, rule: BASIC_RULES["input.phantom"] },
  "input.hi-z": { readable: true, writable: true, rule: BASIC_RULES["input.hi-z"] },
  "input.clip-safe": { readable: true, writable: true, rule: BASIC_RULES["input.clip-safe"] },
  "input.clip-safe-active": { readable: true, writable: false, rule: BASIC_RULES["input.clip-safe-active"] },
  "source.gain": { readable: true, writable: true, rule: BASIC_RULES["source.gain"] },
  "channel.on": { readable: true, writable: true, rule: BASIC_RULES["channel.on"] },
  "channel.fader": { readable: true, writable: true, rule: BASIC_RULES["channel.fader"] },
  "channel.pan": { readable: true, writable: true, rule: BASIC_RULES["channel.pan"] },
  "channel.polarity": { readable: true, writable: true, rule: BASIC_RULES["channel.polarity"] },
  "channel.source": { readable: true, writable: true, rule: BASIC_RULES["channel.source"] },
  // Its write sequence needs evidence first (F03-J); readable until then.
  "channel.stereo-link": { readable: true, writable: false, rule: BASIC_RULES["channel.stereo-link"] },
  "channel.pan-mode": { readable: true, writable: true, rule: BASIC_RULES["channel.pan-mode"] },
  "channel.name": { readable: true, writable: true, rule: BASIC_RULES["channel.name"] },
  "channel.color": { readable: true, writable: true, rule: BASIC_RULES["channel.color"] },
  "channel.rec-point": { readable: true, writable: true, rule: BASIC_RULES["channel.rec-point"] },
  "channel.processing-mode": { readable: true, writable: true, rule: BASIC_RULES["channel.processing-mode"] },
  "channel.hpf.on": { readable: true, writable: true, rule: BASIC_RULES["channel.hpf.on"] },
  "channel.hpf.frequency": { readable: true, writable: true, rule: BASIC_RULES["channel.hpf.frequency"] },
  "channel.gate.on": { readable: true, writable: true, rule: BASIC_RULES["channel.gate.on"] },
  "channel.comp.on": { readable: true, writable: true, rule: BASIC_RULES["channel.comp.on"] },
  "channel.eq.on": { readable: true, writable: true, rule: BASIC_RULES["channel.eq.on"] },
  "channel.ssmcs.on": { readable: true, writable: true, rule: BASIC_RULES["channel.ssmcs.on"] },
  "channel.ssmcs.comp.on": { readable: true, writable: true, rule: BASIC_RULES["channel.ssmcs.comp.on"] },
  "channel.ssmcs.eq.on": { readable: true, writable: true, rule: BASIC_RULES["channel.ssmcs.eq.on"] },
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
  "channel.eq.band.on": { readable: true, writable: true, rule: EQ_RULES["channel.eq.band.on"] },
  "channel.eq.band.type": { readable: true, writable: true, rule: EQ_RULES["channel.eq.band.type"] },
  "channel.eq.band.q": { readable: true, writable: true, rule: EQ_RULES["channel.eq.band.q"] },
  "channel.eq.band.frequency": { readable: true, writable: true, rule: EQ_RULES["channel.eq.band.frequency"] },
  "channel.eq.band.gain": { readable: true, writable: true, rule: EQ_RULES["channel.eq.band.gain"] },
  "channel.eq.one-knob.on": { readable: true, writable: true, rule: EQ_RULES["channel.eq.one-knob.on"] },
  "channel.eq.one-knob.type": { readable: true, writable: true, rule: EQ_RULES["channel.eq.one-knob.type"] },
  "channel.eq.one-knob.level": { readable: true, writable: true, rule: EQ_RULES["channel.eq.one-knob.level"] },
  "channel.ssmcs.preset": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.preset"] },
  "channel.ssmcs.comp-drive": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.comp-drive"] },
  "channel.ssmcs.morphing": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.morphing"] },
  "channel.ssmcs.output-gain": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.output-gain"] },
  "channel.ssmcs.comp.attack": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.comp.attack"] },
  "channel.ssmcs.comp.release": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.comp.release"] },
  "channel.ssmcs.comp.ratio": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.comp.ratio"] },
  "channel.ssmcs.comp.knee": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.comp.knee"] },
  "channel.ssmcs.sidechain.on": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.sidechain.on"] },
  "channel.ssmcs.sidechain.q": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.sidechain.q"] },
  "channel.ssmcs.sidechain.frequency": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.sidechain.frequency"] },
  "channel.ssmcs.sidechain.gain": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.sidechain.gain"] },
  "channel.ssmcs.eq.band.on": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.eq.band.on"] },
  "channel.ssmcs.eq.band.frequency": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.eq.band.frequency"] },
  "channel.ssmcs.eq.band.gain": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.eq.band.gain"] },
  "channel.ssmcs.eq.band.q": { readable: true, writable: true, rule: SSMCS_RULES["channel.ssmcs.eq.band.q"] },
  "channel.ducker.on": { readable: true, writable: true, rule: DUCKER_RULES["channel.ducker.on"] },
  "channel.ducker.key-source": { readable: true, writable: true, rule: DUCKER_RULES["channel.ducker.key-source"] },
  "channel.ducker.threshold": { readable: true, writable: true, rule: DUCKER_RULES["channel.ducker.threshold"] },
  "channel.ducker.range": { readable: true, writable: true, rule: DUCKER_RULES["channel.ducker.range"] },
  "channel.ducker.attack": { readable: true, writable: true, rule: DUCKER_RULES["channel.ducker.attack"] },
  "channel.ducker.decay": { readable: true, writable: true, rule: DUCKER_RULES["channel.ducker.decay"] },
  "send.on": { readable: true, writable: true, rule: SEND_RULES["send.on"] },
  "send.level": { readable: true, writable: true, rule: SEND_RULES["send.level"] },
  "send.pan": { readable: true, writable: true, rule: SEND_RULES["send.pan"] },
  "send.tap": { readable: true, writable: true, rule: SEND_RULES["send.tap"] },
  "bus.on": { readable: true, writable: true, rule: BUS_RULES["bus.on"] },
  "bus.fader": { readable: true, writable: true, rule: BUS_RULES["bus.fader"] },
  "bus.balance": { readable: true, writable: true, rule: BUS_RULES["bus.balance"] },
  "bus.type": { readable: true, writable: false, rule: BUS_RULES["bus.type"] },
  "bus.pan-link": { readable: true, writable: true, rule: BUS_RULES["bus.pan-link"] },
  "bus.stereo-assign": { readable: true, writable: true, rule: BUS_RULES["bus.stereo-assign"] },
  "bus.name": { readable: true, writable: true, rule: BUS_RULES["bus.name"] },
  "bus.color": { readable: true, writable: true, rule: BUS_RULES["bus.color"] },
  "channel.stereo-assign": { readable: true, writable: true, rule: CHANNEL_STEREO_ASSIGN_RULE },
  "channel.insert-fx.type": { readable: true, writable: true, rule: INSERT_FX_RULES["channel.insert-fx.type"] },
  "channel.insert-fx.on": { readable: true, writable: true, rule: INSERT_FX_RULES["channel.insert-fx.on"] },
  "bus.insert-fx.type": { readable: true, writable: true, rule: INSERT_FX_RULES["bus.insert-fx.type"] },
  "bus.insert-fx.on": { readable: true, writable: true, rule: INSERT_FX_RULES["bus.insert-fx.on"] },
  "bus.fx.type": { readable: true, writable: true, rule: FX_RETURN_RULES["bus.fx.type"] },
  "bus.fx.parameter": { readable: true, writable: true, rule: FX_RETURN_RULES["bus.fx.parameter"] },
  "bus.eq.type": { readable: true, writable: false, rule: OUTPUT_EQ_RULES["bus.eq.type"] },
  "bus.eq.on": { readable: true, writable: true, rule: OUTPUT_EQ_RULES["bus.eq.on"] },
  "bus.geq.link": { readable: true, writable: true, rule: OUTPUT_EQ_RULES["bus.geq.link"] },
  "bus.geq.on": { readable: true, writable: true, rule: OUTPUT_EQ_RULES["bus.geq.on"] },
  "bus.geq.limit": { readable: true, writable: true, rule: OUTPUT_EQ_RULES["bus.geq.limit"] },
  "bus.geq.gain": { readable: true, writable: true, rule: OUTPUT_EQ_RULES["bus.geq.gain"] },
  "bus.peq.band.on": { readable: true, writable: true, rule: OUTPUT_PEQ_RULES["bus.peq.band.on"] },
  "bus.peq.band.type": { readable: true, writable: true, rule: OUTPUT_PEQ_RULES["bus.peq.band.type"] },
  "bus.peq.band.q": { readable: true, writable: true, rule: OUTPUT_PEQ_RULES["bus.peq.band.q"] },
  "bus.peq.band.frequency": { readable: true, writable: true, rule: OUTPUT_PEQ_RULES["bus.peq.band.frequency"] },
  "bus.peq.band.gain": { readable: true, writable: true, rule: OUTPUT_PEQ_RULES["bus.peq.band.gain"] },
  "bus.peq.one-knob.on": { readable: true, writable: true, rule: OUTPUT_PEQ_RULES["bus.peq.one-knob.on"] },
  "bus.peq.one-knob.type": { readable: true, writable: true, rule: OUTPUT_PEQ_RULES["bus.peq.one-knob.type"] },
  "bus.peq.one-knob.level": { readable: true, writable: true, rule: OUTPUT_PEQ_RULES["bus.peq.one-knob.level"] },
  "bus.delay.on": { readable: true, writable: true, rule: STREAM_DELAY_RULES["bus.delay.on"] },
  "bus.delay.time": { readable: true, writable: true, rule: STREAM_DELAY_RULES["bus.delay.time"] },
  "bus.delay.frame-rate": { readable: true, writable: true, rule: STREAM_DELAY_RULES["bus.delay.frame-rate"] },
  "output.source": { readable: true, writable: true, rule: OUTPUT_SOURCE_RULES["output.source"] },
  "bus.source": { readable: true, writable: true, rule: OUTPUT_SOURCE_RULES["bus.source"] },
  "bus.mono": { readable: true, writable: true, rule: MONITOR_RULES["bus.mono"] },
  "bus.cue-interrupt": { readable: true, writable: true, rule: MONITOR_RULES["bus.cue-interrupt"] },
  "output.level": { readable: true, writable: true, rule: MONITOR_RULES["output.level"] },
  "channel.cue": { readable: true, writable: true, rule: CUE_RULES["channel.cue"] },
  "bus.cue": { readable: true, writable: true, rule: CUE_RULES["bus.cue"] },
  "cue.mode": { readable: true, writable: true, rule: CUE_RULES["cue.mode"] },
  "oscillator.on": { readable: true, writable: true, rule: OSCILLATOR_RULES["oscillator.on"] },
  "oscillator.mode": { readable: true, writable: true, rule: OSCILLATOR_RULES["oscillator.mode"] },
  "oscillator.frequency": { readable: true, writable: true, rule: OSCILLATOR_RULES["oscillator.frequency"] },
  "oscillator.level": { readable: true, writable: true, rule: OSCILLATOR_RULES["oscillator.level"] },
  "oscillator.burst-width": { readable: true, writable: true, rule: OSCILLATOR_RULES["oscillator.burst-width"] },
  "oscillator.burst-interval": { readable: true, writable: true, rule: OSCILLATOR_RULES["oscillator.burst-interval"] },
  "oscillator.assign": { readable: true, writable: true, rule: OSCILLATOR_RULES["oscillator.assign"] },
  "device.brightness": { readable: true, writable: true, rule: DEVICE_RULES["device.brightness"] },
  "device.auto-power-off": { readable: true, writable: true, rule: DEVICE_RULES["device.auto-power-off"] },
  "device.auto-power-off-time": { readable: true, writable: true, rule: DEVICE_RULES["device.auto-power-off-time"] },
  "device.language": { readable: true, writable: true, rule: DEVICE_RULES["device.language"] },
  "device.usb-suppression": { readable: true, writable: true, rule: DEVICE_RULES["device.usb-suppression"] },
  "device.date-format": { readable: true, writable: true, rule: DEVICE_RULES["device.date-format"] },
  "device.time-format": { readable: true, writable: true, rule: DEVICE_RULES["device.time-format"] },
  "device.time-zone-index": { readable: true, writable: true, rule: DEVICE_RULES["device.time-zone-index"] },
  "device.hdmi-hdcp": { readable: true, writable: true, rule: DEVICE_RULES["device.hdmi-hdcp"] },
  "device.hdmi-input-channels": { readable: true, writable: true, rule: DEVICE_RULES["device.hdmi-input-channels"] },
  "device.sample-rate": { readable: true, writable: true, rule: DEVICE_RULES["device.sample-rate"] },
  "device.follow-usb": { readable: true, writable: true, rule: DEVICE_RULES["device.follow-usb"] },
  "device.console-lock": { readable: true, writable: false, rule: DEVICE_RULES["device.console-lock"] },
  "knob.assignment": { readable: true, writable: true, rule: KNOB_RULES["knob.assignment"] },
  "knob.bank": { readable: true, writable: false, rule: KNOB_RULES["knob.bank"] },
  "integration.active": { readable: true, writable: false, rule: INTEGRATION_RULES["integration.active"] },
  "integration.post-fader-source": { readable: true, writable: true, rule: INTEGRATION_RULES["integration.post-fader-source"] },
  "panel.sends-target": { readable: true, writable: true, rule: INTEGRATION_RULES["panel.sends-target"] },
  "scene.current": { readable: true, writable: false, rule: SCENE_RECORDER_RULES["scene.current"] },
  "scene.cursor": { readable: true, writable: false, rule: SCENE_RECORDER_RULES["scene.cursor"] },
  "recorder.state": { readable: true, writable: false, rule: SCENE_RECORDER_RULES["recorder.state"] },
  "recorder.card-present": { readable: true, writable: false, rule: SCENE_RECORDER_RULES["recorder.card-present"] },
  "recorder.track-count": { readable: true, writable: false, rule: SCENE_RECORDER_RULES["recorder.track-count"] },
  "recorder.source": { readable: true, writable: true, rule: SCENE_RECORDER_RULES["recorder.source"] },
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
  /** Bands belong to band targets only. */
  readonly band?: never;
}

/** A digital input source (F03-G). */
export interface SourceTarget {
  readonly source: SourceToken;
  readonly band?: never;
}

/**
 * A whole channel by its C12 number: mono n, or a fixed stereo pair's first
 * number. It takes no side.
 */
export interface ChannelTarget {
  readonly channel: number;
  readonly side?: undefined;
  readonly band?: never;
}

/** A whole channel and one EQ band (F04-E). It takes no side. */
export interface ChannelBandTarget {
  readonly channel: number;
  readonly band: EqBand;
  readonly side?: undefined;
}

/** A mono channel and one SSMCS EQ band (F04-M). It takes no side. */
export interface ChannelSsmcsBandTarget {
  readonly channel: number;
  readonly band: SsmcsBand;
  readonly side?: undefined;
}

/** One bus by its token (F05-B). */
export interface BusTarget {
  readonly bus: (typeof BUS_TOKENS)[number];
  /** A whole bus takes no side; one given is undefined only. */
  readonly side?: undefined;
  readonly band?: never;
  readonly effect?: never;
  readonly parameter?: never;
}

/** One side of an output bus (F07-G). */
export interface BusSideTarget {
  readonly bus: (typeof BUS_TOKENS)[number];
  readonly side: "left" | "right";
  readonly band?: never;
}

/** A whole output destination (F08-M: the PHONES levels). */
export interface OutputTarget {
  readonly output: (typeof OUTPUT_TOKENS)[number];
  readonly side?: undefined;
  readonly band?: never;
}

/** A device-wide setting's target: no keys (F08-C). */
export type DeviceTarget = Readonly<Record<PropertyKey, never>>;

/** A knob by bank 1…4 and panel letter (F12-K). */
export interface KnobTarget {
  readonly bank: number;
  readonly knob: "a" | "b" | "c" | "d";
  readonly band?: never;
}

/** A knob assignment write: the three exact device strings (F12-K). */
export interface KnobAssignment {
  readonly function: string;
  readonly parameter1: string;
  readonly parameter2: string;
}

/** One component of a knob assignment read, with its own observation time (O12). */
export interface KnobComponentReading {
  readonly value: string;
  readonly observedAt: string;
}

/** A knob assignment read: each component with its own observation time (F12-K, O12). */
export interface KnobAssignmentReading {
  readonly function: KnobComponentReading;
  readonly parameter1: KnobComponentReading;
  readonly parameter2: KnobComponentReading;
}

/** A recorder track 1…16 (F16-R). */
export interface TrackTarget {
  readonly track: number;
  readonly band?: never;
}

/** The recorder transport state (F16-R). */
export type RecorderState = "stopped" | "playing" | "playback-paused" | "recording" | "record-standby" | "recording-paused";

/** The panel SEND display target (F13-S). */
export type SendsTarget = "stereo" | "fx-1" | "fx-2" | "mix-1" | "mix-2";

/** Device utility enums (F11-U, F11-H). */
export type DeviceLanguage = "en" | "ja" | "zh-cn";
export type UsbSuppression = "none" | "2-channels";
export type DateFormat = "mm/dd/yyyy" | "dd/mm/yyyy" | "yyyy/mm/dd";
export type TimeFormat = "24h" | "12h";
export type HdmiInputChannels = "2-channels" | "multi-channels";

/** An oscillator mode (F09-O). */
export type OscillatorMode = "sine" | "pink-noise" | "burst-noise";

/** An oscillator destination: STEREO/MIX with a side, FX 1/2 without (F09-O). */
export type OscillatorAssignTarget =
  | { readonly bus: "stereo" | "mix-1" | "mix-2"; readonly side: "left" | "right"; readonly band?: never }
  | { readonly bus: "fx-1" | "fx-2"; readonly side?: undefined; readonly band?: never; readonly effect?: never; readonly parameter?: never };

/** The device-wide CUE Mode (F08-C). */
export type CueMode = "mix" | "last";

/** One side of a physical or USB output destination (F07-R). */
export interface OutputSideTarget {
  readonly output: "main" | "line" | "usb-main-a" | "usb-main-b" | "usb-main-c" | "usb-sub";
  readonly side: "left" | "right";
  readonly band?: never;
}

/** One output PEQ band of a bus (F07-P). It takes no side. */
export interface BusBandTarget {
  readonly bus: (typeof BUS_TOKENS)[number];
  readonly band: EqBand;
  readonly side?: undefined;
}

/** One Flex12GEQ band of one side of an output bus, by its exact Hz identifier (F07-G). */
export interface BusSideBandTarget {
  readonly bus: (typeof BUS_TOKENS)[number];
  readonly side: "left" | "right";
  readonly band: (typeof GEQ_BANDS)[number];
}

/** One FX-return parameter: the FX bus, the expected effect and the parameter name (F06-F). */
export interface FxParameterTarget {
  readonly bus: (typeof BUS_TOKENS)[number];
  readonly effect: FxReturnType;
  readonly parameter: string;
  readonly band?: never;
}

/** One existing send, by source and destination token (F05-S). */
export interface SendTarget {
  readonly source: string;
  readonly destination: string;
  readonly band?: never;
}

/** A channel with a side, required for side-specific fixed stereo settings. */
export interface ChannelSideTarget {
  readonly channel: number;
  readonly side?: "left" | "right";
  readonly band?: never;
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

/** An FX-return effect (F06-F). */
export type FxReturnType = (typeof FX_RETURN_EFFECTS)[number];
/** An FX-return parameter value: a number in its unit, "thru", a switch or a note token (F06-V). */
export type FxParameterValue = number | string | boolean;

/** An output EQ type (F07-G). */
export type OutputEqType = "peq" | "flex12-geq";
/** A Flex12GEQ Link direction (F07-G). */
export type GeqLink = "off" | "left-to-right" | "right-to-left";
/** A Flex12GEQ Limit (F07-G). */
export type GeqLimit = "plus-minus-15" | "plus-minus-12" | "plus-minus-6" | "minus-24-to-0";

/** An Insert-FX selection (F06-I). */
export type InsertFxType = "none" | (typeof INSERT_FX_EFFECTS)[number];

/** A MIX bus type (F05-B). */
export type BusType = "vari" | "fixed";

/** A send tap point (F05-S). */
export type SendTap = "pre" | "post";

export type EqBand = (typeof EQ_BANDS)[number];
/** A band filter type; low takes `hpf`, high `lpf` (F04-E). */
export type EqBandType = "peaking" | "shelving" | "hpf" | "lpf";
export type EqOneKnobType = (typeof EQ_ONE_KNOB_TYPES)[number];
export type SsmcsBand = (typeof SSMCS_BANDS)[number];

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
  "channel.eq.band.on": { target: ChannelBandTarget; value: boolean };
  "channel.eq.band.type": { target: ChannelBandTarget; value: EqBandType };
  "channel.eq.band.q": { target: ChannelBandTarget; value: number };
  "channel.eq.band.frequency": { target: ChannelBandTarget; value: number };
  "channel.eq.band.gain": { target: ChannelBandTarget; value: number };
  "channel.eq.one-knob.on": { target: ChannelTarget; value: boolean };
  "channel.eq.one-knob.type": { target: ChannelTarget; value: EqOneKnobType };
  "channel.eq.one-knob.level": { target: ChannelTarget; value: number };
  "channel.ssmcs.preset": { target: ChannelTarget; value: number };
  "channel.ssmcs.comp-drive": { target: ChannelTarget; value: number };
  "channel.ssmcs.morphing": { target: ChannelTarget; value: number };
  "channel.ssmcs.output-gain": { target: ChannelTarget; value: number };
  "channel.ssmcs.comp.attack": { target: ChannelTarget; value: number };
  "channel.ssmcs.comp.release": { target: ChannelTarget; value: number };
  "channel.ssmcs.comp.ratio": { target: ChannelTarget; value: CompRatio };
  "channel.ssmcs.comp.knee": { target: ChannelTarget; value: CompKnee };
  "channel.ssmcs.sidechain.on": { target: ChannelTarget; value: boolean };
  "channel.ssmcs.sidechain.q": { target: ChannelTarget; value: number };
  "channel.ssmcs.sidechain.frequency": { target: ChannelTarget; value: number };
  "channel.ssmcs.sidechain.gain": { target: ChannelTarget; value: number };
  "channel.ssmcs.eq.band.on": { target: ChannelSsmcsBandTarget; value: boolean };
  "channel.ssmcs.eq.band.frequency": { target: ChannelSsmcsBandTarget; value: number };
  "channel.ssmcs.eq.band.gain": { target: ChannelSsmcsBandTarget; value: number };
  "channel.ssmcs.eq.band.q": { target: ChannelSsmcsBandTarget; value: number };
  "channel.ducker.on": { target: ChannelTarget; value: boolean };
  "channel.ducker.key-source": { target: ChannelTarget; value: string };
  "channel.ducker.threshold": { target: ChannelTarget; value: number };
  "channel.ducker.range": { target: ChannelTarget; value: number };
  "channel.ducker.attack": { target: ChannelTarget; value: number };
  "channel.ducker.decay": { target: ChannelTarget; value: number };
  "send.on": { target: SendTarget; value: boolean };
  "send.level": { target: SendTarget; value: FaderLevel };
  "send.pan": { target: SendTarget; value: number };
  "send.tap": { target: SendTarget; value: SendTap };
  "bus.on": { target: BusTarget; value: boolean };
  "bus.fader": { target: BusTarget; value: FaderLevel };
  "bus.balance": { target: BusTarget; value: number };
  "bus.type": { target: BusTarget; value: BusType };
  "bus.pan-link": { target: BusTarget; value: boolean };
  "bus.stereo-assign": { target: BusTarget; value: boolean };
  "bus.name": { target: BusTarget; value: ChannelName; input: string };
  "bus.color": { target: BusTarget; value: ChannelColor };
  "channel.stereo-assign": { target: ChannelTarget; value: boolean };
  "channel.insert-fx.type": { target: ChannelTarget; value: InsertFxType };
  "channel.insert-fx.on": { target: ChannelTarget; value: boolean };
  "bus.insert-fx.type": { target: BusTarget; value: InsertFxType };
  "bus.insert-fx.on": { target: BusTarget; value: boolean };
  "bus.fx.type": { target: BusTarget; value: FxReturnType };
  "bus.fx.parameter": { target: FxParameterTarget; value: FxParameterValue };
  "bus.eq.type": { target: BusTarget; value: OutputEqType };
  "bus.eq.on": { target: BusTarget; value: boolean };
  "bus.geq.link": { target: BusTarget; value: GeqLink };
  "bus.geq.on": { target: BusSideTarget; value: boolean };
  "bus.geq.limit": { target: BusSideTarget; value: GeqLimit };
  "bus.geq.gain": { target: BusSideBandTarget; value: number };
  "bus.peq.band.on": { target: BusBandTarget; value: boolean };
  "bus.peq.band.type": { target: BusBandTarget; value: EqBandType };
  "bus.peq.band.q": { target: BusBandTarget; value: number };
  "bus.peq.band.frequency": { target: BusBandTarget; value: number };
  "bus.peq.band.gain": { target: BusBandTarget; value: number };
  "bus.peq.one-knob.on": { target: BusTarget; value: boolean };
  "bus.peq.one-knob.type": { target: BusTarget; value: EqOneKnobType };
  "bus.peq.one-knob.level": { target: BusTarget; value: number };
  "bus.delay.on": { target: BusTarget; value: boolean };
  "bus.delay.time": { target: BusTarget; value: number };
  "bus.delay.frame-rate": { target: BusTarget; value: string };
  "output.source": { target: OutputSideTarget; value: string };
  "bus.source": { target: BusSideTarget; value: string };
  "bus.mono": { target: BusTarget; value: boolean };
  "bus.cue-interrupt": { target: BusTarget; value: boolean };
  "output.level": { target: OutputTarget; value: number };
  "channel.cue": { target: ChannelTarget; value: boolean };
  "bus.cue": { target: BusTarget; value: boolean };
  "cue.mode": { target: DeviceTarget; value: CueMode };
  "oscillator.on": { target: DeviceTarget; value: boolean };
  "oscillator.mode": { target: DeviceTarget; value: OscillatorMode };
  "oscillator.frequency": { target: DeviceTarget; value: number };
  "oscillator.level": { target: DeviceTarget; value: number };
  "oscillator.burst-width": { target: DeviceTarget; value: number };
  "oscillator.burst-interval": { target: DeviceTarget; value: number };
  "oscillator.assign": { target: OscillatorAssignTarget; value: boolean };
  "device.brightness": { target: DeviceTarget; value: number };
  "device.auto-power-off": { target: DeviceTarget; value: boolean };
  "device.auto-power-off-time": { target: DeviceTarget; value: number };
  "device.language": { target: DeviceTarget; value: DeviceLanguage };
  "device.usb-suppression": { target: DeviceTarget; value: UsbSuppression };
  "device.date-format": { target: DeviceTarget; value: DateFormat };
  "device.time-format": { target: DeviceTarget; value: TimeFormat };
  "device.time-zone-index": { target: DeviceTarget; value: number };
  "device.hdmi-hdcp": { target: DeviceTarget; value: boolean };
  "device.hdmi-input-channels": { target: DeviceTarget; value: HdmiInputChannels };
  "device.sample-rate": { target: DeviceTarget; value: number };
  "device.follow-usb": { target: DeviceTarget; value: boolean };
  "device.console-lock": { target: DeviceTarget; value: boolean };
  "knob.assignment": { target: KnobTarget; value: KnobAssignmentReading; input: KnobAssignment };
  "knob.bank": { target: DeviceTarget; value: number };
  "integration.active": { target: DeviceTarget; value: boolean };
  "integration.post-fader-source": { target: BusTarget; value: "mix-1" | "mix-2" };
  "panel.sends-target": { target: DeviceTarget; value: SendsTarget };
  "scene.current": { target: DeviceTarget; value: string };
  "scene.cursor": { target: DeviceTarget; value: string };
  "recorder.state": { target: DeviceTarget; value: RecorderState };
  "recorder.card-present": { target: DeviceTarget; value: boolean };
  "recorder.track-count": { target: DeviceTarget; value: number };
  "recorder.source": { target: TrackTarget; value: string };
}

// Every catalog ID has its types, and every typed ID is in the catalog.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const typesMatchCatalog: Exact<keyof SettingTypes, SettingId> = true;
void typesMatchCatalog;

/** The setting IDs, in catalog order. */
export function settingIds(): SettingId[] {
  return Object.keys(settingDefinitions) as SettingId[];
}
