// Send rules (F05-S): one existing send named by source and destination,
// x 0. CH → MIX: a = 146 + 12b mono, 273 + 12b stereo; level/pan/on/tap at
// a/a+1/a+2/a+5. CH → FX: a = 193 + 4b mono, 320 + 4b stereo; level/on at
// a+1/a+3, tap a (read-only), no pan. FX → MIX: a = 342 + 10b; level/pan/on/
// tap at a+1/a+2/a+3/a. Level, pan and on writes with a linked-address
// candidate (CH → MIX, FX → MIX) write the representative once on the models
// in PARTNER_FOLLOWS, where the partner follows natively (F03-G), except the
// unmeasured stereo CH → MIX pan; elsewhere they stay unbound.

import { FADER_LEVEL_RULE, MONO_CHANNELS, PAN_RULE, STEREO_CHANNELS } from "./channels.js";
import { frozen } from "./frozen.js";
import { MODELS, PARTNER_FOLLOWS } from "./models.js";
import type { SendRoute, SendSettingRule, ValueRule, WriteGate } from "./rules.js";

const channels = [...new Set(MODELS.flatMap((model) => [...MONO_CHANNELS[model], ...STEREO_CHANNELS[model]]))].sort((a, b) => a - b);

/** Every token the send selectors know; a bus token that is no send end is unsupported, not invalid. */
const KNOWN_SOURCES = [...channels.map((channel) => `channel-${channel}`), "fx-1", "fx-2", "mix-1", "mix-2", "stereo"];
const KNOWN_DESTINATIONS = ["mix-1", "mix-2", "fx-1", "fx-2", "stereo"];

type Field = "level" | "pan" | "on" | "tap";

/** Field offsets from each family's base a, and whether its write is bound. */
const FAMILIES: readonly { from: SendRoute["from"]; to: SendRoute["to"]; a: number; stride: number; fields: { [F in Field]?: [number, WriteGate] } }[] = [
  { from: "mono", to: "mix", a: 146, stride: 12, fields: { level: [0, PARTNER_FOLLOWS], pan: [1, PARTNER_FOLLOWS], on: [2, PARTNER_FOLLOWS], tap: [5, true] } },
  { from: "stereo", to: "mix", a: 273, stride: 12, fields: { level: [0, PARTNER_FOLLOWS], pan: [1, false], on: [2, PARTNER_FOLLOWS], tap: [5, true] } },
  { from: "mono", to: "fx", a: 193, stride: 4, fields: { level: [1, true], on: [3, true], tap: [0, false] } },
  { from: "stereo", to: "fx", a: 320, stride: 4, fields: { level: [1, true], on: [3, true], tap: [0, false] } },
  { from: "fx", to: "mix", a: 342, stride: 10, fields: { level: [1, PARTNER_FOLLOWS], pan: [2, PARTNER_FOLLOWS], on: [3, PARTNER_FOLLOWS], tap: [0, true] } },
];

function send(field: Field, value: ValueRule): SendSettingRule {
  const routes = FAMILIES.flatMap((family) => {
    const entry = family.fields[field];
    return entry === undefined
      ? []
      : [{ from: family.from, to: family.to, base: family.a + entry[0], stride: family.stride, write: entry[1] }];
  });
  return { target: "send", knownSources: KNOWN_SOURCES, knownDestinations: KNOWN_DESTINATIONS, routes, value };
}

export const SEND_RULES = frozen({
  "send.on": send("on", { kind: "switch" }),
  "send.level": send("level", FADER_LEVEL_RULE),
  "send.pan": send("pan", PAN_RULE),
  // pre 1, post 0.
  "send.tap": send("tap", { kind: "choice", choices: ["post", "pre"] }),
} as const satisfies Record<string, SendSettingRule>);
