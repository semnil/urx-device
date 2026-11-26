// STREAMING delay and output source lanes (F07-D, F07-R). Each operation
// reads or writes its one addressed field; no partner, link or rate read.

import { MONO_CHANNELS, STEREO_CHANNELS } from "./channels.js";
import { BUS_TOKENS } from "./buses.js";
import { frozen } from "./frozen.js";
import { MODELS } from "./models.js";
import type {
  BusSettingRule,
  BusSideSettingRule,
  ChannelSettingRule,
  DeviceSettingRule,
  OutputSettingRule,
  OutputSideSettingRule,
  PortChoiceRule,
} from "./rules.js";

const stream = (paramId: number) => ({ stream: { paramId, y: 0, write: true } });

export const STREAM_DELAY_RULES = frozen({
  "bus.delay.on": { target: "bus", known: BUS_TOKENS, address: stream(707), value: { kind: "switch" } },
  "bus.delay.time": { target: "bus", known: BUS_TOKENS, address: stream(708), value: { kind: "grid", unit: "ms", min: 1, max: 1000, scale: 100 } },
  "bus.delay.frame-rate": {
    target: "bus",
    known: BUS_TOKENS,
    address: stream(830),
    value: { kind: "choice", choices: ["24", "25", "29.97d", "29.97", "30d", "30", "60", "120"] },
  },
} as const satisfies Record<string, BusSettingRule>);

const BUS_LANES = [
  ["stereo", 256],
  ["stream", 258],
  ["mix-1", 288],
  ["mix-2", 290],
  ["monitor-1", 336],
  ["monitor-2", 338],
] as const;

/** Every source lane a model has, with its untagged port. */
function lanes(model: (typeof MODELS)[number]) {
  return [
    ...BUS_LANES.flatMap(([bus, port]) => [
      { token: `${bus}-left`, id: port },
      { token: `${bus}-right`, id: port + 1 },
    ]),
    ...MONO_CHANNELS[model].map((channel) => ({ token: `channel-${channel}`, id: channel - 1 })),
    ...STEREO_CHANNELS[model].flatMap((channel) => [
      { token: `channel-${channel}-left`, id: channel - 1 },
      { token: `channel-${channel}-right`, id: channel },
    ]),
  ];
}

const byModel = Object.fromEntries(MODELS.map((model) => [model, lanes(model)]));
const known = [...new Set(Object.values(byModel).flatMap((each) => each.map((lane) => lane.token))), "none"];
const busLanes = (...buses: string[]) => buses.flatMap((bus) => [`${bus}-left`, `${bus}-right`]);
const channelLanes = [...new Set(MODELS.flatMap((model) => lanes(model).map((lane) => lane.token).filter((token) => token.startsWith("channel-"))))];

/** The F07-R source-lane codec with its own write list (shared by the recorder sources, F16-R). */
export const sourceLaneRule = (writes: readonly string[], tagged = false): PortChoiceRule => ({
  kind: "port-choice",
  none: { value: "none", raw: "4294967295" },
  known,
  byModel,
  writes,
  ...(tagged ? { tagged } : {}),
});

/** MAIN and LINE: none, STEREO, STREAMING, MIX 1/2 and MONITOR 1/2 lanes. */
const ANALOG = sourceLaneRule(["none", ...busLanes("stereo", "stream", "mix-1", "mix-2", "monitor-1", "monitor-2")]);
/** USB outputs: none, STEREO, STREAMING, MIX 1/2 and every channel lane the model has. */
const USB = sourceLaneRule(["none", ...busLanes("stereo", "stream", "mix-1", "mix-2"), ...channelLanes]);
/** MONITOR 1/2: none, STEREO and MIX 1/2 lanes, written plain (F08-M). */
const MONITOR = sourceLaneRule(["none", ...busLanes("stereo", "mix-1", "mix-2")]);
/** STREAMING: STEREO and MIX 1/2 lanes only, written tagged. */
const STREAM = sourceLaneRule(busLanes("stereo", "mix-1", "mix-2"), true);

/** Output destinations: the source-selectable ones and the fixed PHONES outputs. */
export const OUTPUT_TOKENS = frozen(["main", "line", "usb-main-a", "usb-main-b", "usb-main-c", "usb-sub", "phones-1", "phones-2"] as const);

const ALL = MODELS;
const output = (paramId: number, value: PortChoiceRule, models: readonly string[] = ALL) => ({
  paramId,
  y: { left: 0, right: 1 },
  models,
  value,
});

export const OUTPUT_SOURCE_RULES = frozen({
  "output.source": {
    target: "output-side",
    known: OUTPUT_TOKENS,
    address: {
      main: output(730, ANALOG),
      line: output(731, ANALOG, ["URX44", "URX44V"]),
      "usb-main-a": output(732, USB),
      "usb-main-b": output(733, USB),
      "usb-main-c": output(734, USB),
      "usb-sub": output(735, USB),
    },
    value: USB,
  },
  "bus.source": {
    target: "bus-side",
    known: BUS_TOKENS,
    address: {
      stream: { paramId: { left: 705, right: 706 }, y: { left: 0, right: 0 }, write: true },
      "monitor-1": { paramId: { left: 719, right: 720 }, y: { left: 0, right: 0 }, write: true, value: MONITOR },
      "monitor-2": { paramId: { left: 719, right: 720 }, y: { left: 1, right: 1 }, write: true, value: MONITOR },
    },
    value: STREAM,
  },
} as const satisfies { "output.source": OutputSideSettingRule; "bus.source": BusSideSettingRule });

/** MONITOR switches and PHONES level (F08-M); MONITOR on and fader extend bus.on / bus.fader. */
export const MONITOR_RULES = frozen({
  "bus.mono": {
    target: "bus",
    known: BUS_TOKENS,
    address: { "monitor-1": { paramId: 722, y: 0, write: true }, "monitor-2": { paramId: 722, y: 1, write: true } },
    value: { kind: "switch" },
  },
  "bus.cue-interrupt": {
    target: "bus",
    known: BUS_TOKENS,
    address: { "monitor-1": { paramId: 721, y: 0, write: true }, "monitor-2": { paramId: 721, y: 1, write: true } },
    value: { kind: "switch" },
  },
  // PHONES 0.0…10.0 on 0.1, raw × 10; no other output has a level here.
  "output.level": {
    target: "output",
    known: OUTPUT_TOKENS,
    address: { "phones-1": { paramId: 725, y: 0 }, "phones-2": { paramId: 725, y: 1 } },
    value: { kind: "grid", unit: null, min: 0, max: 10, scale: 10 },
  },
} as const satisfies { "bus.mono": BusSettingRule; "bus.cue-interrupt": BusSettingRule; "output.level": OutputSettingRule });

/** CUE flags and the device-wide CUE Mode (F08-C): the representative only, never a native mirror. */
export const CUE_RULES = frozen({
  "channel.cue": { target: "channel", address: { mono: 138, stereo: 265 }, value: { kind: "switch" } },
  "bus.cue": {
    target: "bus",
    known: BUS_TOKENS,
    address: {
      "fx-1": { paramId: 336, y: 0, write: true },
      "fx-2": { paramId: 336, y: 1, write: true },
      stereo: { paramId: 580, y: 0, write: true },
      "mix-1": { paramId: 673, y: 0, write: true },
      "mix-2": { paramId: 673, y: 2, write: true },
      stream: { paramId: 709, y: 0, write: true },
    },
    value: { kind: "switch" },
  },
  "cue.mode": { target: "device", address: { paramId: 897, y: 0 }, value: { kind: "choice", choices: ["mix", "last"] } },
} as const satisfies { "channel.cue": ChannelSettingRule; "bus.cue": BusSettingRule; "cue.mode": DeviceSettingRule });

