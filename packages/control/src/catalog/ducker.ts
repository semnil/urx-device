// DUCKER rules (F04-U): fixed stereo channels only (x 0, y the stereo
// position). The key source is an untagged port identifier: channel N is
// N − 1 (a fixed stereo pair's left identifier), STEREO 256, MIX 1 288,
// MIX 2 290, and none the unsigned 32-bit sentinel.

import { MONO_CHANNELS, STEREO_CHANNELS } from "./channels.js";
import { ATTACK_STOPS_RAW, DUCKER_DECAY_STOPS_RAW } from "./dynamics-stops.js";
import { frozen } from "./frozen.js";
import { MODELS } from "./models.js";
import type { ChannelSettingRule, PortChoiceRule } from "./rules.js";

const BUSES = [
  { token: "stereo", id: 256 },
  { token: "mix-1", id: 288 },
  { token: "mix-2", id: 290 },
] as const;

function keySources(model: (typeof MODELS)[number]) {
  const channels = [...MONO_CHANNELS[model], ...STEREO_CHANNELS[model]].sort((a, b) => a - b);
  return [...channels.map((channel) => ({ token: `channel-${channel}`, id: channel - 1 })), ...BUSES];
}

const byModel = Object.fromEntries(MODELS.map((model) => [model, keySources(model)]));

const KEY_SOURCE: PortChoiceRule = {
  kind: "port-choice",
  none: { value: "none", raw: "4294967295" },
  known: [...new Set(Object.values(byModel).flatMap((choices) => choices.map((choice) => choice.token)))],
  byModel,
};

const stereo = (paramId: number) => ({ stereo: paramId }) as const;

export const DUCKER_RULES = frozen({
  "channel.ducker.on": { target: "channel", address: stereo(258), value: { kind: "switch" } },
  "channel.ducker.key-source": { target: "channel", address: stereo(259), value: KEY_SOURCE },
  "channel.ducker.threshold": {
    target: "channel",
    address: stereo(260),
    value: { kind: "grid", unit: "dB", min: -60, max: 0, scale: 100, step: 1 },
  },
  // Finite only: no -inf notch.
  "channel.ducker.range": {
    target: "channel",
    address: stereo(261),
    value: { kind: "grid", unit: "dB", min: -70, max: 0, scale: 100, step: 1 },
  },
  "channel.ducker.attack": {
    target: "channel",
    address: stereo(262),
    value: { kind: "stops", unit: "ms", stops: ATTACK_STOPS_RAW, scale: 1000 },
  },
  "channel.ducker.decay": {
    target: "channel",
    address: stereo(263),
    value: { kind: "stops", unit: "ms", stops: DUCKER_DECAY_STOPS_RAW, scale: 10 },
  },
} as const satisfies Record<string, ChannelSettingRule>);
