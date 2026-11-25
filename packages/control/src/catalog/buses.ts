// Bus rules (F05-B): master on/fader/balance, MIX type and Pan Link, STEREO
// assignments and identity, x 0 at each bus's representative y. MIX on,
// fader, balance, type, name and color have a partner instance (y + 1) and
// the STREAM identity another slot (y 1): their writes await F03-G evidence
// and stay unbound. The channel STEREO assignment is a channel setting.

import { CHANNEL_COLORS, NAME_MAX_CODE_POINTS } from "./channels.js";
import { frozen } from "./frozen.js";
import type { BusSettingRule, ChannelSettingRule, ValueRule } from "./rules.js";

export const BUS_TOKENS = frozen(["stereo", "mix-1", "mix-2", "fx-1", "fx-2", "stream"] as const);

type Bus = (typeof BUS_TOKENS)[number];
type At = { paramId: number; y: number; write: boolean };

/** STEREO and FX master settings are single; MIX ones single only where `mixWrite`. */
function master(stereo: number, mix: number, fx: number, mixWrite: boolean): { [B in Bus]?: At } {
  return {
    stereo: { paramId: stereo, y: 0, write: true },
    "mix-1": { paramId: mix, y: 0, write: mixWrite },
    "mix-2": { paramId: mix, y: 2, write: mixWrite },
    "fx-1": { paramId: fx, y: 0, write: true },
    "fx-2": { paramId: fx, y: 1, write: true },
  };
}

const mixOnly = (paramId: number, write: boolean): { [B in Bus]?: At } => ({
  "mix-1": { paramId, y: 0, write },
  "mix-2": { paramId, y: 2, write },
});

const bus = (address: { [B in Bus]?: At }, value: ValueRule): BusSettingRule => ({
  target: "bus",
  known: BUS_TOKENS,
  address,
  value,
});

const LEVEL: ValueRule = { kind: "grid", unit: "dB", min: -96, max: 10, scale: 100, sentinel: { value: "-inf", raw: "-32768" } };

export const BUS_RULES = frozen({
  "bus.on": bus(master(582, 675, 338, false), { kind: "switch" }),
  "bus.fader": bus(master(581, 674, 337, false), LEVEL),
  "bus.balance": bus(master(583, 676, 339, false), { kind: "grid", unit: null, min: -63, max: 63, scale: 1 }),
  "bus.type": bus(mixOnly(587, false), { kind: "choice", choices: ["vari", "fixed"] }),
  "bus.pan-link": bus(mixOnly(589, true), { kind: "switch" }),
  "bus.stereo-assign": bus(
    {
      "mix-1": { paramId: 677, y: 0, write: true },
      "mix-2": { paramId: 677, y: 2, write: true },
      "fx-1": { paramId: 340, y: 0, write: true },
      "fx-2": { paramId: 340, y: 1, write: true },
    },
    { kind: "switch" },
  ),
  "bus.name": bus(
    {
      stereo: { paramId: 494, y: 0, write: true },
      "mix-1": { paramId: 584, y: 0, write: false },
      "mix-2": { paramId: 584, y: 2, write: false },
      "fx-1": { paramId: 333, y: 0, write: true },
      "fx-2": { paramId: 333, y: 1, write: true },
      stream: { paramId: 702, y: 0, write: false },
    },
    { kind: "name", maxCodePoints: NAME_MAX_CODE_POINTS },
  ),
  "bus.color": bus(
    {
      stereo: { paramId: 496, y: 0, write: true },
      "mix-1": { paramId: 586, y: 0, write: false },
      "mix-2": { paramId: 586, y: 2, write: false },
      "fx-1": { paramId: 335, y: 0, write: true },
      "fx-2": { paramId: 335, y: 1, write: true },
      stream: { paramId: 704, y: 0, write: false },
    },
    { kind: "choice", choices: CHANNEL_COLORS },
  ),
} as const satisfies Record<string, BusSettingRule>);

/** The input channel's STEREO assignment: mono 142 / fixed stereo 269. */
export const CHANNEL_STEREO_ASSIGN_RULE = frozen({
  target: "channel",
  address: { mono: 142, stereo: 269 },
  value: { kind: "switch" },
} as const satisfies ChannelSettingRule);
