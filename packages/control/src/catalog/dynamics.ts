// GATE and ordinary-COMP rules (F04-D, F18-P): mono only; dB settings on
// 0.01 dB, times and ratios on the shared nonuniform stops.

import { frozen } from "./frozen.js";
import { ATTACK_STOPS_RAW, HOLD_STOPS_RAW, RATIO_STOPS_RAW, RELEASE_STOPS_RAW } from "./dynamics-stops.js";
import type { ChannelSettingRule } from "./rules.js";

const mono = (paramId: number) => ({ mono: paramId }) as const;

export const DYNAMICS_RULES = frozen({
  "channel.gate.threshold": {
    target: "channel",
    address: mono(29),
    value: { kind: "grid", unit: "dB", min: -72, max: 0, scale: 100 },
  },
  "channel.gate.range": {
    target: "channel",
    address: mono(30),
    value: { kind: "grid", unit: "dB", min: -72, max: 0, scale: 100, sentinel: { value: "-inf", raw: "-32768" } },
  },
  "channel.gate.attack": {
    target: "channel",
    address: mono(31),
    value: { kind: "stops", unit: "ms", stops: ATTACK_STOPS_RAW, scale: 1000 },
  },
  "channel.gate.hold": {
    target: "channel",
    address: mono(32),
    value: { kind: "stops", unit: "ms", stops: HOLD_STOPS_RAW, scale: 100 },
  },
  "channel.gate.decay": {
    target: "channel",
    address: mono(33),
    value: { kind: "stops", unit: "ms", stops: RELEASE_STOPS_RAW, scale: 10 },
  },
  "channel.comp.threshold": {
    target: "channel",
    address: mono(35),
    value: { kind: "grid", unit: "dB", min: -54, max: 0, scale: 100 },
  },
  "channel.comp.ratio": {
    target: "channel",
    address: mono(36),
    // A finite read wider than the write stops is an observation, kept as is.
    value: {
      kind: "stops",
      unit: "ratio",
      stops: RATIO_STOPS_RAW,
      scale: 100,
      read: { min: 100, max: 65534 },
      sentinel: { value: "inf", raw: "65535" },
    },
  },
  "channel.comp.knee": {
    target: "channel",
    address: mono(37),
    value: { kind: "choice", choices: ["soft", "medium", "hard"] },
  },
  "channel.comp.gain": {
    target: "channel",
    address: mono(38),
    value: { kind: "grid", unit: "dB", min: 0, max: 18, scale: 100 },
  },
  "channel.comp.attack": {
    target: "channel",
    address: mono(39),
    value: { kind: "stops", unit: "ms", stops: ATTACK_STOPS_RAW, scale: 1000 },
  },
  "channel.comp.release": {
    target: "channel",
    address: mono(40),
    value: { kind: "stops", unit: "ms", stops: RELEASE_STOPS_RAW, scale: 10 },
  },
  "channel.comp.auto-makeup": { target: "channel", address: mono(41), value: { kind: "switch" } },
  "channel.comp.one-knob.on": { target: "channel", address: mono(42), value: { kind: "switch" } },
  "channel.comp.one-knob.level": {
    target: "channel",
    address: mono(43),
    value: { kind: "grid", unit: null, min: 0, max: 100, scale: 1 },
  },
} as const satisfies Record<string, ChannelSettingRule>);
