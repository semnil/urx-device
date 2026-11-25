// STREAMING delay (F07-D) and output source lanes (F07-R): one addressed read
// or write each. Built from the catalog rules.

import { OUTPUT_SOURCE_RULES, STREAM_DELAY_RULES } from "../catalog/output-routing.js";
import { busRuleSetting, busSideRuleSetting, outputSideRuleSetting } from "./rules.js";

export const busDelayOn = busRuleSetting<boolean>(STREAM_DELAY_RULES["bus.delay.on"]);
export const busDelayTime = busRuleSetting<number>(STREAM_DELAY_RULES["bus.delay.time"]);
export const busDelayFrameRate = busRuleSetting<string>(STREAM_DELAY_RULES["bus.delay.frame-rate"]);
export const outputSource = outputSideRuleSetting<string>(OUTPUT_SOURCE_RULES["output.source"]);
export const busSource = busSideRuleSetting<string>(OUTPUT_SOURCE_RULES["bus.source"]);
