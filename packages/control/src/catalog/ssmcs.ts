// SSMCS rules (F04-M): the explicit SSMCS bank, mono only (x 0, y channel − 1).
// The frequency and Q steps are the parameter's named steps, written out, not
// response-curve coordinates: frequency raw r (4…124) is the R40 preferred
// number preferredNumber(R40, r − 4 + 52), and Q raw r (0…60) the two-decimal
// display of 0.5 × 32^(r / 60), both as in urx-router ced9c7d2. The preset
// labels are the router's SWEET_SPOT_DATA_OPTIONS at the same revision. The
// internal Threshold (100) and Makeup (101) fields have no rule.

import { frozen } from "./frozen.js";
import { ATTACK_STOPS_RAW, RATIO_STOPS_RAW, RELEASE_STOPS_RAW } from "./dynamics-stops.js";
import type { ChannelBandSettingRule, ChannelSettingRule, GridRule, StopsRule } from "./rules.js";

export const SSMCS_BANDS = frozen(["low", "mid", "high"] as const);

/** Frequency steps in 0.1 Hz for raw 4…124 (20 … 20000 Hz). */
export const SSMCS_FREQUENCY_STEPS_DECIHZ: readonly number[] = frozen([
  200, 212, 224, 236, 250, 265, 280, 300, 315, 335, 355, 375, 400, 425, 450, 475, 500, 530, 560, 600,
  630, 670, 710, 750, 800, 850, 900, 950, 1000, 1060, 1120, 1180, 1250, 1320, 1400, 1500, 1600, 1700, 1800, 1900,
  2000, 2120, 2240, 2360, 2500, 2650, 2800, 3000, 3150, 3350, 3550, 3750, 4000, 4250, 4500, 4750, 5000, 5300, 5600, 6000,
  6300, 6700, 7100, 7500, 8000, 8500, 9000, 9500, 10000, 10600, 11200, 11800, 12500, 13200, 14000, 15000, 16000, 17000, 18000, 19000,
  20000, 21200, 22400, 23600, 25000, 26500, 28000, 30000, 31500, 33500, 35500, 37500, 40000, 42500, 45000, 47500, 50000, 53000, 56000, 60000,
  63000, 67000, 71000, 75000, 80000, 85000, 90000, 95000, 100000, 106000, 112000, 118000, 125000, 132000, 140000, 150000, 160000, 170000, 180000, 190000,
  200000,
]);

/** Q steps in 0.01 for raw 0…60 (0.50 … 16.00). */
export const SSMCS_Q_STEPS_CENTI: readonly number[] = frozen([
  50, 53, 56, 59, 63, 67, 71, 75, 79, 84, 89, 94, 100, 106, 112, 119, 126, 133, 141, 150,
  159, 168, 178, 189, 200, 212, 224, 238, 252, 267, 283, 300, 317, 336, 356, 378, 400, 424, 449, 476,
  504, 534, 566, 599, 635, 673, 713, 755, 800, 848, 898, 951, 1008, 1068, 1131, 1199, 1270, 1345, 1425, 1510,
  1600,
]);

/** Preset labels by preset number 1…34 (index + 1); a label's own prefix is not its number. */
export const SSMCS_PRESET_LABELS: readonly string[] = frozen([
  "01 Basic",
  "02 Color",
  "03 Tone",
  "04 Sweep - Boost",
  "05 Sweep - Cut",
  "06 Lo Cut",
  "01 AK Bass",
  "02 AK Drums",
  "03 AK Master",
  "04 MZ A.Guitar",
  "05 MZ Kick",
  "06 MZ Snare",
  "07 MZ Master",
  "08 MR Vocal",
  "09 MR Drums",
  "10 MR Master",
  "11 SH Piano",
  "12 SH Drums",
  "13 SH Master",
  "14 OK Master - Vocal",
  "15 OK Master - Bass",
  "16 OK Master - Vigour",
  "17 OK Master - TV",
  "18 IO Vocal",
  "19 IO A.Guitar",
  "20 IO Drums",
  "21 TK Notch - Resonation",
  "22 TK Programmed Kick",
  "23 TK Pumping",
  "24 ZK Vocal",
  "25 ZK Bass",
  "26 ZK Drums",
  "27 ZK Master",
  "28 ZK Filter",
]);

const FREQUENCY_RAW_MIN = 4;

/** The frequency steps from raw `min` to raw `max`, raw = index + ordinal. */
function frequency(min: number, max: number): StopsRule {
  return {
    kind: "stops",
    unit: "Hz",
    stops: SSMCS_FREQUENCY_STEPS_DECIHZ.slice(min - FREQUENCY_RAW_MIN, max - FREQUENCY_RAW_MIN + 1),
    scale: 10,
    ordinal: min,
  };
}

const Q: StopsRule = { kind: "stops", unit: null, stops: SSMCS_Q_STEPS_CENTI, scale: 100, ordinal: 0 };
/** Gains: dB × 10 + 180, −18 … 18 dB on 0.1 dB. */
const GAIN: GridRule = { kind: "grid", unit: "dB", min: -18, max: 18, scale: 10, offset: 180 };

const mono = (paramId: number) => ({ mono: paramId }) as const;
const channel = (paramId: number, value: ChannelSettingRule["value"]) =>
  ({ target: "channel", address: mono(paramId), value }) satisfies ChannelSettingRule;
const band = (address: ChannelBandSettingRule["address"], value: ChannelBandSettingRule["value"]) =>
  ({ target: "channel-band", bands: SSMCS_BANDS, address, value }) satisfies ChannelBandSettingRule;

export const SSMCS_RULES = frozen({
  "channel.ssmcs.preset": channel(91, {
    kind: "text-index",
    unit: null,
    min: 1,
    max: 34,
    digits: 4,
    labels: SSMCS_PRESET_LABELS,
  }),
  "channel.ssmcs.comp-drive": channel(95, { kind: "grid", unit: null, min: 0, max: 10, scale: 20 }),
  "channel.ssmcs.morphing": channel(93, { kind: "grid", unit: null, min: 0, max: 120, scale: 1 }),
  "channel.ssmcs.output-gain": channel(117, GAIN),
  "channel.ssmcs.comp.attack": channel(96, { kind: "stops", unit: "ms", stops: ATTACK_STOPS_RAW, scale: 1000, ordinal: 57 }),
  "channel.ssmcs.comp.release": channel(97, { kind: "stops", unit: "ms", stops: RELEASE_STOPS_RAW, scale: 10, ordinal: 24 }),
  // The finite stops are indices 0…119; the last index, 120, is infinity.
  "channel.ssmcs.comp.ratio": channel(98, {
    kind: "stops",
    unit: "ratio",
    stops: RATIO_STOPS_RAW,
    scale: 100,
    ordinal: 0,
    sentinel: { value: "inf", raw: `${RATIO_STOPS_RAW.length}` },
  }),
  "channel.ssmcs.comp.knee": channel(99, { kind: "choice", choices: ["soft", "medium", "hard"] }),
  "channel.ssmcs.sidechain.on": channel(102, { kind: "switch" }),
  "channel.ssmcs.sidechain.q": channel(103, Q),
  "channel.ssmcs.sidechain.frequency": channel(104, frequency(4, 124)),
  "channel.ssmcs.sidechain.gain": channel(105, GAIN),
  "channel.ssmcs.eq.band.on": band({ low: mono(107), mid: mono(110), high: mono(114) }, { kind: "switch" }),
  "channel.ssmcs.eq.band.frequency": band(
    { low: mono(108), mid: mono(112), high: mono(115) },
    { kind: "by-band", rules: { low: frequency(4, 72), mid: frequency(4, 124), high: frequency(60, 124) } },
  ),
  "channel.ssmcs.eq.band.gain": band({ low: mono(109), mid: mono(113), high: mono(116) }, GAIN),
  // Low and high are fixed shelves: only the mid band has a Q.
  "channel.ssmcs.eq.band.q": band({ mid: mono(111) }, Q),
} as const satisfies Record<string, ChannelSettingRule | ChannelBandSettingRule>);
