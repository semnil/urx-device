// Bus controls (F05-B): one addressed read or write each at the bus's
// representative instance. No BUS Type, Pan Link or equality read; native
// effects of a type or Pan Link change are accepted, not restored. Built from
// the catalog rules.

import type { BusType, ChannelColor, ChannelName, FaderLevel } from "../catalog/settings.js";
import { BUS_RULES, CHANNEL_STEREO_ASSIGN_RULE } from "../catalog/buses.js";
import { busRuleSetting, ruleSetting } from "./rules.js";

const rules = BUS_RULES;

export const busOn = busRuleSetting<boolean>(rules["bus.on"]);
export const busFader = busRuleSetting<FaderLevel>(rules["bus.fader"]);
export const busBalance = busRuleSetting<number>(rules["bus.balance"]);
export const busType = busRuleSetting<BusType>(rules["bus.type"]);
export const busPanLink = busRuleSetting<boolean>(rules["bus.pan-link"]);
export const busStereoAssign = busRuleSetting<boolean>(rules["bus.stereo-assign"]);
export const busName = busRuleSetting<ChannelName, string>(rules["bus.name"]);
export const busColor = busRuleSetting<ChannelColor>(rules["bus.color"]);
export const channelStereoAssign = ruleSetting<boolean>(CHANNEL_STEREO_ASSIGN_RULE);
