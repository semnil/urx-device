// Knob bank, integration state, Post Fader Send source and the SEND display
// target (F12-K, F12-I, F13-S): one addressed read or write each; the knob
// bank and the integration state are read only and expose no write path.
// Built from the catalog rules.

import { INTEGRATION_RULES, KNOB_RULES } from "../catalog/integration-panel.js";
import type { SendsTarget } from "../catalog/settings.js";
import { busRuleSetting, deviceRuleSetting, readOnly } from "./rules.js";

export const knobBank = readOnly(deviceRuleSetting<number>(KNOB_RULES["knob.bank"]));
export const integrationActive = readOnly(deviceRuleSetting<boolean>(INTEGRATION_RULES["integration.active"]));
export const integrationPostFaderSource = busRuleSetting<"mix-1" | "mix-2">(INTEGRATION_RULES["integration.post-fader-source"]);
export const panelSendsTarget = deviceRuleSetting<SendsTarget>(INTEGRATION_RULES["panel.sends-target"]);
