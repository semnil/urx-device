// Ordinary four-band EQ and EQ 1-knob settings (F04-E): one addressed read or
// write each, on mono or fixed stereo. No mode, 1-knob, filter-type or
// on-state read; a band setting takes exactly one band, the others none.
// Built from the catalog rules.

import { EQ_RULES } from "../catalog/eq.js";
import type { EqBandType, EqOneKnobType } from "../catalog/settings.js";
import { bandRuleSetting, ruleSetting } from "./rules.js";

const rules = EQ_RULES;

export const eqBandOn = bandRuleSetting<boolean>(rules["channel.eq.band.on"]);
export const eqBandType = bandRuleSetting<EqBandType>(rules["channel.eq.band.type"]);
export const eqBandQ = bandRuleSetting<number>(rules["channel.eq.band.q"]);
export const eqBandFrequency = bandRuleSetting<number>(rules["channel.eq.band.frequency"]);
export const eqBandGain = bandRuleSetting<number>(rules["channel.eq.band.gain"]);
export const eqOneKnobOn = ruleSetting<boolean>(rules["channel.eq.one-knob.on"]);
export const eqOneKnobType = ruleSetting<EqOneKnobType>(rules["channel.eq.one-knob.type"]);
export const eqOneKnobLevel = ruleSetting<number>(rules["channel.eq.one-knob.level"]);
