// DUCKER settings (F04-U): fixed stereo only, one addressed read or write
// each. A key-source change does not enable DUCKER, and no setting reads or
// changes its on state. Built from the catalog rules.

import { DUCKER_RULES } from "../catalog/ducker.js";
import { ruleSetting } from "./rules.js";

const rules = DUCKER_RULES;

export const duckerOn = ruleSetting<boolean>(rules["channel.ducker.on"]);
export const duckerKeySource = ruleSetting<string>(rules["channel.ducker.key-source"]);
export const duckerThreshold = ruleSetting<number>(rules["channel.ducker.threshold"]);
export const duckerRange = ruleSetting<number>(rules["channel.ducker.range"]);
export const duckerAttack = ruleSetting<number>(rules["channel.ducker.attack"]);
export const duckerDecay = ruleSetting<number>(rules["channel.ducker.decay"]);
