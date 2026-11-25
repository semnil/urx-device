// STREAMING delay (F07-D) and output source lanes (F07-R): one addressed read
// or write each. Built from the catalog rules.

import { CUE_RULES, MONITOR_RULES, OUTPUT_SOURCE_RULES, STREAM_DELAY_RULES } from "../catalog/output-routing.js";
import type { CueMode } from "../catalog/settings.js";
import {
  busRuleSetting,
  busSideRuleSetting,
  deviceRuleSetting,
  outputRuleSetting,
  outputSideRuleSetting,
  ruleSetting,
} from "./rules.js";

export const busDelayOn = busRuleSetting<boolean>(STREAM_DELAY_RULES["bus.delay.on"]);
export const busDelayTime = busRuleSetting<number>(STREAM_DELAY_RULES["bus.delay.time"]);
export const busDelayFrameRate = busRuleSetting<string>(STREAM_DELAY_RULES["bus.delay.frame-rate"]);
export const outputSource = outputSideRuleSetting<string>(OUTPUT_SOURCE_RULES["output.source"]);
export const busSource = busSideRuleSetting<string>(OUTPUT_SOURCE_RULES["bus.source"]);

// MONITOR / PHONES (F08-M) and CUE (F08-C).
export const busMono = busRuleSetting<boolean>(MONITOR_RULES["bus.mono"]);
export const busCueInterrupt = busRuleSetting<boolean>(MONITOR_RULES["bus.cue-interrupt"]);
export const outputLevel = outputRuleSetting<number>(MONITOR_RULES["output.level"]);
export const channelCue = ruleSetting<boolean>(CUE_RULES["channel.cue"]);
export const busCue = busRuleSetting<boolean>(CUE_RULES["bus.cue"]);
export const cueMode = deviceRuleSetting<CueMode>(CUE_RULES["cue.mode"]);
