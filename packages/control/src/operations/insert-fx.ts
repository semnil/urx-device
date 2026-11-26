// Insert-FX selector and on (F06-I): one addressed read or write each. No
// rate, link, slot-occupancy or other-holder read; native defaults and
// auto-enabling on a type change are accepted. Built from the catalog rules.

import { INSERT_FX_RULES } from "../catalog/insert-fx.js";
import type { InsertFxType } from "../catalog/settings.js";
import { busRuleSetting, ruleSetting } from "./rules.js";

const rules = INSERT_FX_RULES;

export const channelInsertFxType = ruleSetting<InsertFxType>(rules["channel.insert-fx.type"]);
export const channelInsertFxOn = ruleSetting<boolean>(rules["channel.insert-fx.on"]);
export const busInsertFxType = busRuleSetting<InsertFxType>(rules["bus.insert-fx.type"]);
export const busInsertFxOn = busRuleSetting<boolean>(rules["bus.insert-fx.on"]);
