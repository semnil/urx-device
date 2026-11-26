// Output PEQ (F07-P): one addressed read or write each at the bus's
// representative instance; no EQ Type, 1-knob, filter-type or on-state read.
// Built from the catalog rules.

import { OUTPUT_PEQ_RULES } from "../catalog/output-peq.js";
import type { EqBandType, EqOneKnobType } from "../catalog/settings.js";
import { busBandRuleSetting, busRuleSetting } from "./rules.js";

const rules = OUTPUT_PEQ_RULES;

export const busPeqBandOn = busBandRuleSetting<boolean>(rules["bus.peq.band.on"]);
export const busPeqBandType = busBandRuleSetting<EqBandType>(rules["bus.peq.band.type"]);
export const busPeqBandQ = busBandRuleSetting<number>(rules["bus.peq.band.q"]);
export const busPeqBandFrequency = busBandRuleSetting<number>(rules["bus.peq.band.frequency"]);
export const busPeqBandGain = busBandRuleSetting<number>(rules["bus.peq.band.gain"]);
export const busPeqOneKnobOn = busRuleSetting<boolean>(rules["bus.peq.one-knob.on"]);
export const busPeqOneKnobType = busRuleSetting<EqOneKnobType>(rules["bus.peq.one-knob.type"]);
export const busPeqOneKnobLevel = busRuleSetting<number>(rules["bus.peq.one-knob.level"]);
