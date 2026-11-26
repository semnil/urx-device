// Oscillator settings and assignment (F09-O): one addressed read or write
// each. Built from the catalog rules.

import { OSCILLATOR_RULES } from "../catalog/oscillator.js";
import type { OscillatorMode } from "../catalog/settings.js";
import { busSideRuleSetting, deviceRuleSetting } from "./rules.js";

const rules = OSCILLATOR_RULES;

export const oscillatorOn = deviceRuleSetting<boolean>(rules["oscillator.on"]);
export const oscillatorMode = deviceRuleSetting<OscillatorMode>(rules["oscillator.mode"]);
export const oscillatorFrequency = deviceRuleSetting<number>(rules["oscillator.frequency"]);
export const oscillatorLevel = deviceRuleSetting<number>(rules["oscillator.level"]);
export const oscillatorBurstWidth = deviceRuleSetting<number>(rules["oscillator.burst-width"]);
export const oscillatorBurstInterval = deviceRuleSetting<number>(rules["oscillator.burst-interval"]);
export const oscillatorAssign = busSideRuleSetting<boolean>(rules["oscillator.assign"]);
