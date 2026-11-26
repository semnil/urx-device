// Output EQ switches and Flex12GEQ rules (F07-G): STEREO, MIX 1 and MIX 2.
// EQ Type and overall EQ On are read at the representative y; their writes
// follow F03-G's evidence-selected address plan: the MIX EQ On writes the
// representative once on the models in PARTNER_FOLLOWS, and every other EQ
// Type and EQ On write stays unbound until evidence exists. Link writes the representative instance once; GEQ On,
// Limit and band gain write the named side once.

import { BUS_TOKENS } from "./buses.js";
import { byToken, frozen } from "./frozen.js";
import { PARTNER_FOLLOWS } from "./models.js";
import type { BusSettingRule, BusSideSettingRule, GeqGainRule, SelectorRule, WriteGate } from "./rules.js";

export const GEQ_BANDS = frozen([
  "20", "25", "31.5", "40", "50", "63", "80", "100", "125", "160", "200", "250", "315", "400", "500", "630",
  "800", "1000", "1250", "1600", "2000", "2500", "3150", "4000", "5000", "6300", "8000", "10000", "12500", "16000", "20000",
] as const);

const SIDES = {
  stereo: { left: 0, right: 1 },
  "mix-1": { left: 0, right: 1 },
  "mix-2": { left: 2, right: 3 },
} as const;
const REPRESENTATIVE = { stereo: 0, "mix-1": 0, "mix-2": 2 } as const;

const EQ_TYPES = [
  { token: "peq", raw: "0" },
  { token: "flex12-geq", raw: "2" },
] as const;
/**
 * F07-G's definition limit, for help: Flex12GEQ runs up to 48 kHz (a rate
 * change above it returns the bus to PEQ). A definition, not a measurement;
 * nothing reads the rate.
 */
const EQ_TYPE: SelectorRule = {
  kind: "selector",
  known: ["peq", "flex12-geq"],
  choices: EQ_TYPES,
  limits: byToken({
    peq: { maxRateHz: null, monoOnly: false, slot: null },
    "flex12-geq": { maxRateHz: 48000, monoOnly: false, slot: null },
  }),
};

function representative(stereo: number, mix: number, stereoWrite: WriteGate, mixWrite: WriteGate): BusSettingRule["address"] {
  return {
    stereo: { paramId: stereo, y: REPRESENTATIVE.stereo, write: stereoWrite },
    "mix-1": { paramId: mix, y: REPRESENTATIVE["mix-1"], write: mixWrite },
    "mix-2": { paramId: mix, y: REPRESENTATIVE["mix-2"], write: mixWrite },
  };
}

function sides(stereo: number, mix: number): BusSideSettingRule["address"] {
  return {
    stereo: { paramId: stereo, y: SIDES.stereo, write: true },
    "mix-1": { paramId: mix, y: SIDES["mix-1"], write: true },
    "mix-2": { paramId: mix, y: SIDES["mix-2"], write: true },
  };
}

const LIMITS = [
  { token: "plus-minus-15", min: -15, max: 15 },
  { token: "plus-minus-12", min: -12, max: 12 },
  { token: "plus-minus-6", min: -6, max: 6 },
  { token: "minus-24-to-0", min: -24, max: 0 },
] as const;

export const OUTPUT_EQ_RULES = frozen({
  "bus.eq.type": { target: "bus", known: BUS_TOKENS, address: representative(497, 590, false, false), value: EQ_TYPE },
  "bus.eq.on": { target: "bus", known: BUS_TOKENS, address: representative(498, 591, false, PARTNER_FOLLOWS), value: { kind: "switch" } },
  "bus.geq.link": {
    target: "bus",
    known: BUS_TOKENS,
    address: representative(544, 637, true, true),
    value: { kind: "choice", choices: ["off", "left-to-right", "right-to-left"] },
  },
  "bus.geq.on": { target: "bus-side", known: BUS_TOKENS, address: sides(543, 636), value: { kind: "switch" } },
  "bus.geq.limit": {
    target: "bus-side",
    known: BUS_TOKENS,
    address: {
      stereo: { paramId: 893, y: SIDES.stereo, write: true },
      "mix-1": { paramId: 894, y: SIDES["mix-1"], write: true },
      "mix-2": { paramId: 894, y: SIDES["mix-2"], write: true },
    },
    value: { kind: "choice", choices: LIMITS.map((limit) => limit.token) },
  },
  "bus.geq.gain": {
    target: "bus-side-band",
    known: BUS_TOKENS,
    bands: GEQ_BANDS,
    address: {
      // STEREO keeps its software-write exclusion: only the 20 Hz band is writable.
      stereo: { paramId: 545, perBand: "x", y: SIDES.stereo, writableBands: ["20"], eqType: { paramId: 497, y: 0 }, limit: 893 },
      "mix-1": { paramId: 638, perBand: "id", y: SIDES["mix-1"], writableBands: GEQ_BANDS, eqType: { paramId: 590, y: 0 }, limit: 894 },
      "mix-2": { paramId: 638, perBand: "id", y: SIDES["mix-2"], writableBands: GEQ_BANDS, eqType: { paramId: 590, y: 2 }, limit: 894 },
    },
    eqType: { required: "flex12-geq", choices: EQ_TYPES },
    limits: LIMITS,
    unit: "dB",
    scale: 100,
    step: 0.5,
    read: { min: -2400, max: 1500 },
  },
} as const satisfies Record<string, BusSettingRule | BusSideSettingRule | GeqGainRule>);
