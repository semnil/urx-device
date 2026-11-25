// Sends (F05-S): one existing send by source and destination, one addressed
// read or write each. No bus type, Pan Link, source PAN/BAL, stereo-link or
// send-on read; native Pan Link effects are accepted, not compensated.
// Built from the catalog rules.

import type { FaderLevel, SendTap } from "../catalog/settings.js";
import { SEND_RULES } from "../catalog/sends.js";
import { sendRuleSetting } from "./rules.js";

const rules = SEND_RULES;

export const sendOn = sendRuleSetting<boolean>(rules["send.on"]);
export const sendLevel = sendRuleSetting<FaderLevel>(rules["send.level"]);
export const sendPan = sendRuleSetting<number>(rules["send.pan"]);
export const sendTap = sendRuleSetting<SendTap>(rules["send.tap"]);
