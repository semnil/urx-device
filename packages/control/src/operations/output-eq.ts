// Output EQ switches and Flex12GEQ (F07-G). Type, EQ On and Link reads use the
// representative instance; GEQ On, Limit and gain address the named side.
// Gain writes check EQ Type and the side's Limit first; no capacity, Link or
// other-side read. Built from the catalog rules.

import { OUTPUT_EQ_RULES } from "../catalog/output-eq.js";
import type { GeqLimit, GeqLink, OutputEqType } from "../catalog/settings.js";
import { busRuleSetting, busSideRuleSetting, geqGainSetting } from "./rules.js";

const rules = OUTPUT_EQ_RULES;

export const busEqType = busRuleSetting<OutputEqType>(rules["bus.eq.type"]);
export const busEqOn = busRuleSetting<boolean>(rules["bus.eq.on"]);
export const busGeqLink = busRuleSetting<GeqLink>(rules["bus.geq.link"]);
export const busGeqOn = busSideRuleSetting<boolean>(rules["bus.geq.on"]);
export const busGeqLimit = busSideRuleSetting<GeqLimit>(rules["bus.geq.limit"]);
export const busGeqGain = geqGainSetting(rules["bus.geq.gain"]);
