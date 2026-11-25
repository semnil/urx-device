// Insert-FX selector and on rules (F06-I): mono input channels (135 / 134,
// y N − 1), STEREO (578 / 577, y 0) and MIX 1/2 (671 / 670, y 0 or 2). The
// MIX selector and on have a partner instance: their writes await F03-G
// evidence and stay unbound. Effect parameters (F06-P) await hardware
// evidence of the shared-engine layout and have no rule.

import { frozen } from "./frozen.js";
import { BUS_TOKENS } from "./buses.js";
import type { BusSettingRule, ChannelSettingRule, SelectorRule } from "./rules.js";

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
};

const OUTPUT: SelectorRule = {
  kind: "selector",
  none: NONE,
  known: INSERT_FX_EFFECTS,
  choices: [
    { token: "compander-h", raw: "1793" },
    { token: "compander-s", raw: "1794" },
    { token: "multi-band-comp", raw: "1792" },
  ],
};

const outputs = (stereo: number, mix: number) => ({
  stereo: { paramId: stereo, y: 0, write: true },
  "mix-1": { paramId: mix, y: 0, write: false },
  "mix-2": { paramId: mix, y: 2, write: false },
});

export const INSERT_FX_RULES = frozen({
  "channel.insert-fx.type": { target: "channel", address: { mono: 135 }, value: INPUT },
  "channel.insert-fx.on": { target: "channel", address: { mono: 134 }, value: { kind: "switch" } },
  "bus.insert-fx.type": { target: "bus", known: BUS_TOKENS, address: outputs(578, 671), value: OUTPUT },
  "bus.insert-fx.on": { target: "bus", known: BUS_TOKENS, address: outputs(577, 670), value: { kind: "switch" } },
} as const satisfies Record<string, ChannelSettingRule | BusSettingRule>);
