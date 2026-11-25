// Meter points (F10-M): meter addresses (meterId, x), not parameters, read by
// subscription only. Mono points have one address; stereo points a left and
// a right one. i = N − 1 for a mono channel, p the fixed stereo position.

import { MONO_CHANNELS, STEREO_CHANNELS, channelIndex } from "./channels.js";
import { frozen } from "./frozen.js";
import type { I64Text } from "./i64.js";
import { isModel } from "./models.js";

export interface MeterAddress {
  readonly meterId: number;
  readonly x: I64Text;
}

/** A meter point: one address (mono) or a left and a right one (stereo). */
export type MeterPoint =
  | { readonly shape: "mono"; readonly address: MeterAddress }
  | { readonly shape: "stereo"; readonly left: MeterAddress; readonly right: MeterAddress };

/** Level taps → meter ID. */
export const LEVEL_TAPS = frozen({
  mono: { input: 100, "pre-gate": 106, "pre-comp": 108, sidechain: 109, "pre-eq": 111, "pre-insert-fx": 112, "pre-fader": 113, post: 115 },
  stereo: { input: 101, "pre-fader": 114, "pre-ducker": 116, post: 120 },
  stereoBus: { "pre-eq": 104, "pre-fader": 121, "pre-insert-fx": 123, post: 125 },
  mix: { "pre-eq": 105, "pre-fader": 122, "pre-insert-fx": 124, post: 126 },
  fx: { input: 131, "pre-fader": 103, post: 118 },
  stream: { post: 127 },
  monitor: { post: 129 },
} as const);

export const METER_BUSES = frozen(["stereo", "mix-1", "mix-2", "fx-1", "fx-2", "stream", "monitor-1", "monitor-2"] as const);
export const METER_PROCESSORS = frozen(["gate", "comp", "ducker"] as const);

const at = (meterId: number, x: number): MeterAddress => ({ meterId, x: `${x}` });
const mono = (meterId: number, x: number): MeterPoint => ({ shape: "mono", address: at(meterId, x) });
const stereo = (meterId: number, left: number): MeterPoint => ({ shape: "stereo", left: at(meterId, left), right: at(meterId, left + 1) });

/** Why a selection names no point: a known one this model or target lacks, or an unknown one. */
export type MeterRefusal = "unsupported_operation" | "invalid_input";

const known = new Set<string>(Object.values(LEVEL_TAPS).flatMap((taps) => Object.keys(taps)));
const allChannels = new Set(Object.values(MONO_CHANNELS).flat().concat(Object.values(STEREO_CHANNELS).flat()));

/** The level point of a channel tap, or why there is none. */
export function channelLevelPoint(model: string, channel: unknown, tap: unknown): MeterPoint | MeterRefusal {
  if (!isModel(model) || typeof tap !== "string" || !known.has(tap)) {
    return "invalid_input";
  }
  const index = channelIndex(model, channel);
  if (index === undefined) {
    return typeof channel === "number" && allChannels.has(channel) ? "unsupported_operation" : "invalid_input";
  }
  const taps: Readonly<Record<string, number>> = index.kind === "mono" ? LEVEL_TAPS.mono : LEVEL_TAPS.stereo;
  const meterId = Object.hasOwn(taps, tap) ? taps[tap] : undefined;
  if (meterId === undefined) {
    return "unsupported_operation";
  }
  return index.kind === "mono" ? mono(meterId, index.index) : stereo(meterId, 2 * index.index);
}

/** The level point of a bus tap, or why there is none. */
export function busLevelPoint(model: string, bus: unknown, tap: unknown): MeterPoint | MeterRefusal {
  if (!isModel(model) || typeof bus !== "string" || !METER_BUSES.includes(bus as "stereo") || typeof tap !== "string" || !known.has(tap)) {
    return "invalid_input";
  }
  const [family, index] = busFamily(bus);
  const taps: Readonly<Record<string, number>> = LEVEL_TAPS[family];
  const meterId = Object.hasOwn(taps, tap) ? taps[tap] : undefined;
  if (meterId === undefined) {
    return "unsupported_operation";
  }
  // FX input is mono before the effect; every other bus point is stereo.
  return family === "fx" && tap === "input" ? mono(meterId, index) : stereo(meterId, 2 * index);
}

function busFamily(bus: string): [keyof typeof LEVEL_TAPS, number] {
  switch (bus) {
    case "stereo":
      return ["stereoBus", 0];
    case "mix-1":
    case "mix-2":
      return ["mix", Number(bus.slice(-1)) - 1];
    case "fx-1":
    case "fx-2":
      return ["fx", Number(bus.slice(-1)) - 1];
    case "stream":
      return ["stream", 0];
    default:
      return ["monitor", Number(bus.slice(-1)) - 1];
  }
}

/** The singleton level points. */
export function pointLevel(point: unknown): MeterPoint | MeterRefusal {
  if (point === "cue") {
    return stereo(128, 0);
  }
  return point === "oscillator" ? mono(135, 0) : "invalid_input";
}

/** A channel processor's reduction point (always mono), or why there is none. */
export function channelReductionPoint(model: string, channel: unknown, processor: unknown): MeterPoint | MeterRefusal {
  if (!isModel(model) || !METER_PROCESSORS.includes(processor as "gate")) {
    return "invalid_input";
  }
  const index = channelIndex(model, channel);
  if (index === undefined) {
    return typeof channel === "number" && allChannels.has(channel) ? "unsupported_operation" : "invalid_input";
  }
  if (processor === "ducker") {
    return index.kind === "stereo" ? mono(119, index.index) : "unsupported_operation";
  }
  return index.kind === "mono" ? mono(processor === "gate" ? 107 : 110, index.index) : "unsupported_operation";
}

/** A shared Insert-FX engine's reduction: the input engine, or one output engine band 1…3. */
export function engineReductionPoint(engine: unknown, band: unknown): MeterPoint | MeterRefusal {
  if (engine === "input-insert") {
    return band === undefined ? mono(132, 0) : "invalid_input";
  }
  if (engine === "output-insert") {
    return band === 1 || band === 2 || band === 3 ? mono(133, band - 1) : "invalid_input";
  }
  return "invalid_input";
}

/** A level reading: finite dBFS, or over. */
export type MeterLevel = { readonly state: "finite"; readonly value: number } | { readonly state: "over" };

const OVER = "32767";

function tenths(raw: I64Text): number | undefined {
  if (!/^(0|-[1-9][0-9]*)$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return value >= -1280 ? value / 10 : undefined;
}

/** Level: raw −1280…0 is raw / 10 dBFS (−128 stays finite); exactly 32767 is over. */
export function decodeMeterLevel(raw: I64Text): MeterLevel | undefined {
  if (raw === OVER) {
    return { state: "over" };
  }
  const value = tenths(raw);
  return value === undefined ? undefined : { state: "finite", value };
}

/** Reduction: raw −1280…0 is raw / 10 dB; 32767 also means no reported reduction, 0 dB. */
export function decodeMeterReduction(raw: I64Text): number | undefined {
  if (raw === OVER) {
    return 0;
  }
  const value = tenths(raw);
  return value === undefined ? undefined : Object.is(value, -0) ? 0 : value;
}

