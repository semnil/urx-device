// Physical inputs and source gain (F02-B, F03-G), channel identity and basic
// controls (C12, F03-H/I/J/K/R) and the processing switches and mode (F04-S):
// one addressed read or write each, built from the catalog rules.

import { BASIC_RULES } from "../catalog/basic-rules.js";
import type { ChannelColor, ChannelName, FaderLevel, PanMode, Polarity, ProcessingMode, RecPoint } from "../catalog/settings.js";
import { channelSideRuleSetting, inputRuleSetting, pairRuleSetting, ruleSetting, sourceRuleSetting } from "./rules.js";

const rules = BASIC_RULES;

export const inputGain = inputRuleSetting<number>(rules["input.gain"]);
export const inputPhantom = inputRuleSetting<boolean>(rules["input.phantom"]);
export const inputHiZ = inputRuleSetting<boolean>(rules["input.hi-z"]);
export const inputClipSafe = inputRuleSetting<boolean>(rules["input.clip-safe"]);
export const inputClipSafeActive = inputRuleSetting<boolean>(rules["input.clip-safe-active"]);
export const sourceGain = sourceRuleSetting<number>(rules["source.gain"]);

export const channelOn = ruleSetting<boolean>(rules["channel.on"]);
export const channelFader = ruleSetting<FaderLevel>(rules["channel.fader"]);
export const channelPan = ruleSetting<number>(rules["channel.pan"]);
export const channelPolarity = channelSideRuleSetting<Polarity>(rules["channel.polarity"]);
export const channelSource = channelSideRuleSetting<string>(rules["channel.source"]);
export const channelStereoLink = pairRuleSetting<boolean>(rules["channel.stereo-link"]);
export const channelPanMode = pairRuleSetting<PanMode>(rules["channel.pan-mode"]);
export const channelName = ruleSetting<ChannelName, string>(rules["channel.name"]);
export const channelColor = ruleSetting<ChannelColor>(rules["channel.color"]);
export const channelRecPoint = ruleSetting<RecPoint>(rules["channel.rec-point"]);

export const processingMode = ruleSetting<ProcessingMode>(rules["channel.processing-mode"]);
export const hpfOn = ruleSetting<boolean>(rules["channel.hpf.on"]);
export const hpfFrequency = ruleSetting<number>(rules["channel.hpf.frequency"]);
export const gateOn = ruleSetting<boolean>(rules["channel.gate.on"]);
export const compOn = ruleSetting<boolean>(rules["channel.comp.on"]);
export const eqOn = ruleSetting<boolean>(rules["channel.eq.on"]);
export const ssmcsOn = ruleSetting<boolean>(rules["channel.ssmcs.on"]);
export const ssmcsCompOn = ruleSetting<boolean>(rules["channel.ssmcs.comp.on"]);
export const ssmcsEqOn = ruleSetting<boolean>(rules["channel.ssmcs.eq.on"]);
