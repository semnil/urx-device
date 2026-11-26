// Output EQ switches and Flex12GEQ (F07-G). Type, EQ On and Link reads use the
// representative instance; GEQ On, Limit and gain address the named side.
// Every GEQ write (On, Link, Limit, gain) reads the bus's EQ Type first, and
// a gain write the side's Limit; no capacity, Link or other-side read. Built
// from the catalog rules.

import { OUTPUT_EQ_RULES } from "../catalog/output-eq.js";
import type { GeqLimit, GeqLink, OutputEqType } from "../catalog/settings.js";
import { busRuleSetting, busSideRuleSetting, eqTypeGated, geqGainSetting } from "./rules.js";

const rules = OUTPUT_EQ_RULES;

export const busEqType = busRuleSetting<OutputEqType>(rules["bus.eq.type"]);
export const busEqOn = busRuleSetting<boolean>(rules["bus.eq.on"]);
const gain = rules["bus.geq.gain"];
export const busGeqLink = eqTypeGated(busRuleSetting<GeqLink>(rules["bus.geq.link"]), gain);
export const busGeqOn = eqTypeGated(busSideRuleSetting<boolean>(rules["bus.geq.on"]), gain);
export const busGeqLimit = eqTypeGated(busSideRuleSetting<GeqLimit>(rules["bus.geq.limit"]), gain);
export const busGeqGain = geqGainSetting(rules["bus.geq.gain"]);
