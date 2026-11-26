// Insert-FX selector and on rules (F06-I): mono input channels (135 / 134,
// y N − 1), STEREO (578 / 577, y 0) and MIX 1/2 (671 / 670, y 0 or 2). The
// MIX selector and on have a partner instance: the on switch writes the
// representative once on the models in PARTNER_FOLLOWS (F03-G); the selector,
// and the on switch elsewhere, stay unbound. Each selector carries F06-I's
// definition limits (rate ceiling, mono only, shared slot) for help; no
// operation reads the state they depend on. Effect parameters (F06-P) await hardware evidence of
// the shared-engine layout and have no rule.

import { byToken, frozen } from "./frozen.js";
import { BUS_TOKENS } from "./buses.js";
import { PARTNER_FOLLOWS } from "./models.js";
import type { BusSettingRule, ChannelSettingRule, SelectorLimits, SelectorRule, WriteGate } from "./rules.js";

const NONE = { value: "none", raw: "4294967295" } as const;

export const INSERT_FX_EFFECTS = frozen([
  "clean",
  "crunch",
  "lead",
  "drive",
  "pitch-fix",
  "compander-h",
  "compander-s",
  "multi-band-comp",
] as const);

/** F06-I's definition limits: the user guide's effect list, not a measurement. */
const limit = (maxRateHz: number | null, slot: string | null, monoOnly = false): SelectorLimits => ({ maxRateHz, monoOnly, slot });
const NO_LIMIT = limit(null, null);
const AMP = limit(96000, "input-amp", true);

const INPUT: SelectorRule = {
  kind: "selector",
  none: NONE,
  known: INSERT_FX_EFFECTS,
  choices: [
    { token: "clean", raw: "256" },
    { token: "crunch", raw: "257" },
    { token: "lead", raw: "258" },
    { token: "drive", raw: "259" },
    { token: "pitch-fix", raw: "512" },
    { token: "compander-h", raw: "1793" },
    { token: "compander-s", raw: "1794" },
  ],
  limits: byToken({
    none: NO_LIMIT,
    clean: AMP,
    crunch: AMP,
    lead: AMP,
    drive: AMP,
    "pitch-fix": limit(48000, "input-pitch", true),
    "compander-h": limit(96000, "input-compander"),
    "compander-s": limit(96000, "input-compander"),
  }),
};

const OUTPUT_DYNAMICS = limit(96000, "output-dynamics");

const OUTPUT: SelectorRule = {
  kind: "selector",
  none: NONE,
  known: INSERT_FX_EFFECTS,
  choices: [
    { token: "compander-h", raw: "1793" },
    { token: "compander-s", raw: "1794" },
    { token: "multi-band-comp", raw: "1792" },
  ],
  limits: byToken({
    none: NO_LIMIT,
    "compander-h": OUTPUT_DYNAMICS,
    "compander-s": OUTPUT_DYNAMICS,
    "multi-band-comp": OUTPUT_DYNAMICS,
  }),
};

const outputs = (stereo: number, mix: number, mixWrite: WriteGate): BusSettingRule["address"] => ({
  stereo: { paramId: stereo, y: 0, write: true },
  "mix-1": { paramId: mix, y: 0, write: mixWrite },
  "mix-2": { paramId: mix, y: 2, write: mixWrite },
});

export const INSERT_FX_RULES = frozen({
  "channel.insert-fx.type": { target: "channel", address: { mono: 135 }, value: INPUT },
  "channel.insert-fx.on": { target: "channel", address: { mono: 134 }, value: { kind: "switch" } },
  "bus.insert-fx.type": { target: "bus", known: BUS_TOKENS, address: outputs(578, 671, false), value: OUTPUT },
  "bus.insert-fx.on": { target: "bus", known: BUS_TOKENS, address: outputs(577, 670, PARTNER_FOLLOWS), value: { kind: "switch" } },
} as const satisfies Record<string, ChannelSettingRule | BusSettingRule>);
