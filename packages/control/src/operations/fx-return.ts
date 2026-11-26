// FX-return type and parameters (F06-F, F06-V). A type write sends only the
// selector; a parameter access reads the bus's selector once, requires the
// expected effect, reads Room Size only for REV-X Reverb Time, then makes its
// one parameter request. Built from the catalog rules.

import { FX_RETURN_RULES } from "../catalog/fx-return.js";
import type { FxParameterValue, FxReturnType } from "../catalog/settings.js";
import { busRuleSetting, fxParameterSetting } from "./rules.js";

export const busFxType = busRuleSetting<FxReturnType>(FX_RETURN_RULES["bus.fx.type"]);
export const busFxParameter = fxParameterSetting<FxParameterValue>(FX_RETURN_RULES["bus.fx.parameter"]);
