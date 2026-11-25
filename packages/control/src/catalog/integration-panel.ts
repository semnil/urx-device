// Knob assignments and bank (F12-K), software-integration state and Post
// Fader Send source (F12-I) and the panel SEND display target (F13-S). The
// LCD stereo selection (F13-L) awaits panel channel/side hardware evidence
// and has no rule.

import { BUS_TOKENS } from "./buses.js";
import { frozen } from "./frozen.js";
import type { BusSettingRule, DeviceSettingRule, KnobAssignmentRule, SelectorRule } from "./rules.js";

export const KNOB_RULES = frozen({
  "knob.assignment": {
    target: "knob",
    banks: 4,
    knobs: ["a", "b", "c", "d"],
    components: [
      { name: "function", paramId: 770 },
      { name: "parameter1", paramId: 771 },
      { name: "parameter2", paramId: 772 },
    ],
    // The exact case-sensitive device strings; empty strings are values.
    triples: [
      ["No Assign", "", ""],
      ["Brightness", "Screen", ""],
      ["Monitor", "Monitor 1", "Level"],
      ["Monitor", "Monitor 2", "Level"],
      ["Phones", "Phones 1", "Level"],
      ["Phones", "Phones 2", "Level"],
      ["Oscillator", "Level", ""],
    ],
  },
  // Raw 0…3 is bank 1…4; read only.
  "knob.bank": { target: "device", address: { paramId: 769, y: 0 }, value: { kind: "grid", unit: null, min: 1, max: 4, scale: 1, offset: -1 } },
} as const satisfies { "knob.assignment": KnobAssignmentRule; "knob.bank": DeviceSettingRule });

const MIX_SOURCE: SelectorRule = {
  kind: "selector",
  known: ["mix-1", "mix-2"],
  choices: [
    { token: "mix-1", raw: "288" },
    { token: "mix-2", raw: "290" },
  ],
};

export const INTEGRATION_RULES = frozen({
  // Zero is inactive, any other integer active; read only.
  "integration.active": { target: "device", address: { paramId: 816, y: 0 }, value: { kind: "flag" } },
  "integration.post-fader-source": {
    target: "bus",
    known: BUS_TOKENS,
    address: { "fx-1": { paramId: 879, y: 0, write: true }, "fx-2": { paramId: 880, y: 0, write: true } },
    value: MIX_SOURCE,
  },
  "panel.sends-target": {
    target: "device",
    address: { paramId: 763, y: 0 },
    value: {
      kind: "selector",
      known: ["stereo", "fx-1", "fx-2", "mix-1", "mix-2"],
      choices: [
        { token: "stereo", raw: "0" },
        { token: "fx-1", raw: "16" },
        { token: "fx-2", raw: "17" },
        { token: "mix-1", raw: "32" },
        { token: "mix-2", raw: "34" },
      ],
    },
  },
} as const satisfies { "integration.active": DeviceSettingRule; "integration.post-fader-source": BusSettingRule; "panel.sends-target": DeviceSettingRule });
