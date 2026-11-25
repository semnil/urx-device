// SSMCS controls (F04-M): the explicit SSMCS bank, mono only, one addressed
// read or write each. No mode, section, band-on or preset read; changes a
// preset or Morphing makes on the device are not resent or restored. Built
// from the catalog rules.

import type { CompKnee, CompRatio } from "../catalog/settings.js";
import { SSMCS_RULES } from "../catalog/ssmcs.js";
import { bandRuleSetting, ruleSetting } from "./rules.js";

const rules = SSMCS_RULES;

export const ssmcsPreset = ruleSetting<number>(rules["channel.ssmcs.preset"]);
export const ssmcsCompDrive = ruleSetting<number>(rules["channel.ssmcs.comp-drive"]);
export const ssmcsMorphing = ruleSetting<number>(rules["channel.ssmcs.morphing"]);
export const ssmcsOutputGain = ruleSetting<number>(rules["channel.ssmcs.output-gain"]);
export const ssmcsCompAttack = ruleSetting<number>(rules["channel.ssmcs.comp.attack"]);
export const ssmcsCompRelease = ruleSetting<number>(rules["channel.ssmcs.comp.release"]);
export const ssmcsCompRatio = ruleSetting<CompRatio>(rules["channel.ssmcs.comp.ratio"]);
export const ssmcsCompKnee = ruleSetting<CompKnee>(rules["channel.ssmcs.comp.knee"]);
export const ssmcsSidechainOn = ruleSetting<boolean>(rules["channel.ssmcs.sidechain.on"]);
export const ssmcsSidechainQ = ruleSetting<number>(rules["channel.ssmcs.sidechain.q"]);
export const ssmcsSidechainFrequency = ruleSetting<number>(rules["channel.ssmcs.sidechain.frequency"]);
export const ssmcsSidechainGain = ruleSetting<number>(rules["channel.ssmcs.sidechain.gain"]);
export const ssmcsEqBandOn = bandRuleSetting<boolean>(rules["channel.ssmcs.eq.band.on"]);
export const ssmcsEqBandFrequency = bandRuleSetting<number>(rules["channel.ssmcs.eq.band.frequency"]);
export const ssmcsEqBandGain = bandRuleSetting<number>(rules["channel.ssmcs.eq.band.gain"]);
export const ssmcsEqBandQ = bandRuleSetting<number>(rules["channel.ssmcs.eq.band.q"]);
