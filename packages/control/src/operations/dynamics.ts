// GATE and ordinary-COMP settings (F04-D): mono only, one addressed read or
// write each; no 1-knob, Auto Makeup or processing-mode read, no automatic
// disabling. Built from the catalog rules.

import { DYNAMICS_RULES } from "../catalog/dynamics.js";
import type { CompKnee, CompRatio, GateRange } from "../catalog/settings.js";
import { ruleSetting } from "./rules.js";

const rules = DYNAMICS_RULES;

export const gateThreshold = ruleSetting<number>(rules["channel.gate.threshold"]);
export const gateRange = ruleSetting<GateRange>(rules["channel.gate.range"]);
export const gateAttack = ruleSetting<number>(rules["channel.gate.attack"]);
export const gateHold = ruleSetting<number>(rules["channel.gate.hold"]);
export const gateDecay = ruleSetting<number>(rules["channel.gate.decay"]);
export const compThreshold = ruleSetting<number>(rules["channel.comp.threshold"]);
export const compRatio = ruleSetting<CompRatio>(rules["channel.comp.ratio"]);
export const compKnee = ruleSetting<CompKnee>(rules["channel.comp.knee"]);
export const compGain = ruleSetting<number>(rules["channel.comp.gain"]);
export const compAttack = ruleSetting<number>(rules["channel.comp.attack"]);
export const compRelease = ruleSetting<number>(rules["channel.comp.release"]);
export const compAutoMakeup = ruleSetting<boolean>(rules["channel.comp.auto-makeup"]);
export const compOneKnobOn = ruleSetting<boolean>(rules["channel.comp.one-knob.on"]);
export const compOneKnobLevel = ruleSetting<number>(rules["channel.comp.one-knob.level"]);
