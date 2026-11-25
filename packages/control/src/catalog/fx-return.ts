// FX-return rules (F06-F, F06-V): FX1 selector 679 / array 681, FX2 selector
// 683 / array 685, x 0. Each effect has its own complete parameter catalog;
// a shared public name is resolved by the exact effect.

import { BUS_TOKENS } from "./buses.js";
import { frozen } from "./frozen.js";
import {
  FX2_FREQUENCY_DECIHZ,
  INITIAL_DELAY_DECIMS,
  REV_R3_TIME_DECISECONDS,
  REVX_FREQUENCY_HZ,
  REVX_TIME_MS,
} from "./fx-return-tables.js";
import type {
  BusSettingRule,
  ContextStopsRule,
  FxEffectRule,
  FxParameterRule,
  SelectorRule,
  StopsRule,
  ValueRule,
  ValueUnit,
} from "./rules.js";

export const FX_RETURN_EFFECTS = frozen([
  "rev-x-hall",
  "rev-x-room",
  "rev-x-plate",
  "rev-r3-hall",
  "rev-r3-room",
  "rev-r3-plate",
  "mono-delay",
  "ping-pong",
] as const);

/** Selector values: FX1 offers REV-X and the delays, FX2 Rev.R3 and the delays. */
const SELECTORS: { readonly [E in (typeof FX_RETURN_EFFECTS)[number]]: { "fx-1"?: string; "fx-2"?: string } } = {
  "rev-x-hall": { "fx-1": "0" },
  "rev-x-room": { "fx-1": "1" },
  "rev-x-plate": { "fx-1": "2" },
  "rev-r3-hall": { "fx-2": "768" },
  "rev-r3-room": { "fx-2": "769" },
  "rev-r3-plate": { "fx-2": "770" },
  "mono-delay": { "fx-1": "1024", "fx-2": "1024" },
  "ping-pong": { "fx-1": "1025", "fx-2": "1025" },
};

function menu(bus: "fx-1" | "fx-2"): SelectorRule {
  return {
    kind: "selector",
    known: FX_RETURN_EFFECTS,
    choices: FX_RETURN_EFFECTS.flatMap((token) => {
      const raw = SELECTORS[token][bus];
      return raw === undefined ? [] : [{ token, raw }];
    }),
  };
}

/** A table window, raw = index + `first`. */
const table = (unit: StopsRule["unit"], stops: readonly number[], scale: number, first: number, last: number): StopsRule => ({
  kind: "stops",
  unit,
  stops: stops.slice(first, last + 1),
  scale,
  ordinal: first,
});

const grid = (unit: ValueUnit, min: number, max: number, scale = 1, offset?: number): ValueRule =>
  offset === undefined ? { kind: "grid", unit, min, max, scale } : { kind: "grid", unit, min, max, scale, offset };

const INITIAL_DELAY = table("ms", INITIAL_DELAY_DECIMS, 10, 0, 127);
const HI_RATIO = grid("ratio", 0.1, 1, 10);
const DIFFUSION = grid(null, 0, 10);
const FEEDBACK = grid("%", -99, 99);

/** Rev.R3 / delay HPF: raw 0…5 THRU (written as 0), 6…109 R40 from 21.2 Hz. */
const FX2_HPF: StopsRule = {
  ...table("Hz", FX2_FREQUENCY_DECIHZ, 10, 0, 103),
  ordinal: 6,
  sentinel: { value: "thru", raw: "0", reads: ["1", "2", "3", "4", "5"] },
};
/** Rev.R3 / delay LPF: raw 21…121 R40 from 50 Hz, 122 THRU. */
const FX2_LPF: StopsRule = { ...table("Hz", FX2_FREQUENCY_DECIHZ, 10, 15, 115), ordinal: 21, sentinel: { value: "thru", raw: "122" } };

const REVX_TIME: ContextStopsRule = {
  kind: "context-stops",
  unit: "s",
  scale: 1000,
  contextSlot: 12,
  contexts: { "rev-x-hall": REVX_TIME_MS[0], "rev-x-room": REVX_TIME_MS[1], "rev-x-plate": REVX_TIME_MS[2] },
  envelope: {
    "rev-x-hall": { min: 0.103, max: 31 },
    "rev-x-room": { min: 0.152, max: 45.3 },
    "rev-x-plate": { min: 0.176, max: 52 },
  },
};

const revx = (effect: "rev-x-hall" | "rev-x-room" | "rev-x-plate"): FxEffectRule => ({
  selector: SELECTORS[effect],
  parameters: {
    "reverb-time": { slot: 7, value: REVX_TIME },
    "room-size": { slot: 12, value: grid(null, 0, 31) },
    "initial-delay": { slot: 9, value: INITIAL_DELAY },
    decay: { slot: 15, value: grid(null, 0, 63) },
    diffusion: { slot: 8, value: DIFFUSION },
    hpf: { slot: 10, value: table("Hz", REVX_FREQUENCY_HZ, 1, 0, 52) },
    lpf: { slot: 11, value: table("Hz", REVX_FREQUENCY_HZ, 1, 34, 60) },
    "hi-ratio": { slot: 13, value: HI_RATIO },
    "low-ratio": { slot: 14, value: grid("ratio", 0.1, 1.4, 10) },
    "low-frequency": { slot: 18, value: table("Hz", REVX_FREQUENCY_HZ, 1, 1, 59) },
  },
});

const r3 = (effect: "rev-r3-hall" | "rev-r3-room" | "rev-r3-plate"): FxEffectRule => ({
  selector: SELECTORS[effect],
  parameters: {
    "reverb-time": { slot: 7, value: table("s", REV_R3_TIME_DECISECONDS, 10, 0, 69) },
    "initial-delay": { slot: 8, value: INITIAL_DELAY },
    "hi-ratio": { slot: 9, value: HI_RATIO },
    diffusion: { slot: 10, value: DIFFUSION },
    density: { slot: 11, value: grid(null, 0, 4) },
    feedback: { slot: 12, value: FEEDBACK },
    "er-reverb-delay": { slot: 13, value: INITIAL_DELAY },
    // raw 0…126 is −63…63: negative toward early reflections.
    "er-reverb-balance": { slot: 14, value: grid(null, -63, 63, 1, 63) },
    hpf: { slot: 15, value: FX2_HPF },
    lpf: { slot: 16, value: FX2_LPF },
  },
});

const NOTES = ["off", "1/32t", "1/16t", "1/16", "1/8t", "1/16.", "1/8", "1/4t", "1/8.", "1/4", "1/4.", "1/2", "1/2.", "whole", "double-whole"];

const delay = (effect: "mono-delay" | "ping-pong", time: ValueRule): FxEffectRule => ({
  selector: SELECTORS[effect],
  parameters: {
    "delay-time": { slot: 6, value: time },
    feedback: { slot: 7, value: FEEDBACK },
    "hi-ratio": { slot: 8, value: HI_RATIO },
    hpf: { slot: 9, value: FX2_HPF },
    lpf: { slot: 10, value: FX2_LPF },
    sync: { slot: 4, value: { kind: "switch" } },
    bpm: { slot: 3, value: grid("bpm", 25, 300) },
    note: { slot: 11, value: { kind: "choice", choices: NOTES } },
  },
});

const effects = {
  "rev-x-hall": revx("rev-x-hall"),
  "rev-x-room": revx("rev-x-room"),
  "rev-x-plate": revx("rev-x-plate"),
  "rev-r3-hall": r3("rev-r3-hall"),
  "rev-r3-room": r3("rev-r3-room"),
  "rev-r3-plate": r3("rev-r3-plate"),
  "mono-delay": delay("mono-delay", { kind: "grid", unit: "ms", min: 0.1, max: 2700, scale: 10 }),
  // Written on 1 ms steps; reads keep the tenths raw 10…13500 carries.
  "ping-pong": delay("ping-pong", { kind: "grid", unit: "ms", min: 1, max: 1350, scale: 10, step: 1 }),
};

export const FX_RETURN_RULES = frozen({
  "bus.fx.type": {
    target: "bus",
    known: BUS_TOKENS,
    address: {
      "fx-1": { paramId: 679, y: 0, write: true, value: menu("fx-1") },
      "fx-2": { paramId: 683, y: 0, write: true, value: menu("fx-2") },
    },
    value: menu("fx-1"),
  },
  "bus.fx.parameter": {
    target: "fx-parameter",
    buses: { "fx-1": { selector: 679, array: 681 }, "fx-2": { selector: 683, array: 685 } },
    knownBuses: BUS_TOKENS,
    effects,
    knownParameters: [...new Set(Object.values(effects).flatMap((effect) => Object.keys(effect.parameters)))],
  },
} as const satisfies { "bus.fx.type": BusSettingRule; "bus.fx.parameter": FxParameterRule });
