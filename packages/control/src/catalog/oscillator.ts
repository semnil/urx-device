// Oscillator rules (F09-O): six device-wide settings and the per-destination
// assignment switches (STEREO and MIX per side, FX mono). One addressed read
// or write each; no mode, On or other-value read.

import { BUS_TOKENS } from "./buses.js";
import { frozen } from "./frozen.js";
import type { BusSideSettingRule, DeviceSettingRule } from "./rules.js";

const device = (paramId: number, value: DeviceSettingRule["value"]): DeviceSettingRule => ({
  target: "device",
  address: { paramId, y: 0 },
  value,
});

export const OSCILLATOR_RULES = frozen({
  "oscillator.on": device(710, { kind: "switch" }),
  "oscillator.mode": device(712, { kind: "choice", choices: ["sine", "pink-noise", "burst-noise"] }),
  "oscillator.frequency": device(713, { kind: "grid", unit: "Hz", min: 20, max: 20000, scale: 10 }),
  // Finite centi-dB: no -inf, and 0 dB is the top of the range, not Off.
  "oscillator.level": device(711, { kind: "grid", unit: "dB", min: -96, max: 0, scale: 100 }),
  "oscillator.burst-width": device(714, { kind: "grid", unit: "s", min: 0.1, max: 10, scale: 1000 }),
  "oscillator.burst-interval": device(715, { kind: "grid", unit: "s", min: 1, max: 30, scale: 1 }),
  "oscillator.assign": {
    target: "bus-side",
    known: BUS_TOKENS,
    address: {
      stereo: { paramId: 716, y: { left: 0, right: 1 }, write: true },
      "mix-1": { paramId: 717, y: { left: 0, right: 1 }, write: true },
      "mix-2": { paramId: 717, y: { left: 2, right: 3 }, write: true },
      "fx-1": { paramId: 718, y: { left: 0, right: 0 }, write: true, sideless: true },
      "fx-2": { paramId: 718, y: { left: 1, right: 1 }, write: true, sideless: true },
    },
    value: { kind: "switch" },
  },
} as const satisfies Record<string, DeviceSettingRule | BusSideSettingRule>);
