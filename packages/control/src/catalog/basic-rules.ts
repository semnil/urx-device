// Rules for the settings bound before D9b (D15r): physical inputs and source
// gain (F02-B, F03-G), channel identity and basic controls (C12, F03-H/I/J/
// K/R) and the processing switches and mode (F04-S), built from the existing
// catalog constants so each address and range stays in one place.

import {
  CHANNEL_COLORS,
  CHANNEL_PARAMS,
  FADER_LEVEL_RULE,
  IDENTITY_PARAMS,
  MONO_PAIRS,
  NAME_MAX_CODE_POINTS,
  PAIR_PARAMS,
  PAN_RULE,
  REC_POINTS,
  REC_POINT_PARAMS,
  STEREO_REC_POINTS,
} from "./channels.js";
import { frozen } from "./frozen.js";
import { HI_Z_JACKS, INPUT_GAIN_DB, INPUT_JACKS, INPUT_PARAMS, SOURCE_GAIN, SOURCE_GAIN_DB } from "./inputs.js";
import { INPUT_PORTS, SOURCE_PARAMS } from "./ports.js";
import {
  HPF_FREQUENCY_ID,
  HPF_READ_RAW,
  HPF_WRITE_HZ,
  HPF_WRITE_STOPS_HZ,
  PROCESSING_MODES,
  PROCESSING_MODE_ID,
  PROCESSING_SWITCHES,
} from "./processing.js";
import type {
  ChannelSettingRule,
  ChannelSideSettingRule,
  InputSettingRule,
  PairSettingRule,
  SelectorRule,
  SourceSettingRule,
  ValueRule,
} from "./rules.js";

const input = (paramId: number, value: ValueRule, only?: InputSettingRule["only"]): InputSettingRule => ({
  target: "input",
  jacks: INPUT_JACKS,
  paramId,
  value,
  ...(only === undefined ? {} : { only }),
});

/** Whole dB within a range over centi-dB raw (F02-B, F03-G). */
const wholeDb = (range: { min: number; max: number }): ValueRule => ({ kind: "grid", unit: "dB", min: range.min, max: range.max, scale: 100, step: 1 });

const SWITCH: ValueRule = { kind: "switch" };

const channel = (address: ChannelSettingRule["address"], value: ChannelSettingRule["value"]): ChannelSettingRule => ({
  target: "channel",
  address,
  value,
});

/** The input-port tokens with their raw values and models (F03-I). */
const PORTS: SelectorRule = {
  kind: "selector",
  known: [],
  choices: Object.entries(INPUT_PORTS).map(([token, port]) => ({ token, raw: port.raw, models: port.models })),
};

/** Rec Point stages in raw order; fixed stereo has only its two (F03-R). */
const recPoints = (stages: readonly string[]): SelectorRule => ({
  kind: "selector",
  known: [],
  choices: stages.map((stage) => ({ token: stage, raw: `${(REC_POINTS as readonly string[]).indexOf(stage)}` })),
});

const pair = (paramId: number, value: ValueRule): PairSettingRule => ({ target: "pair", primaries: MONO_PAIRS, paramId, value });

const processingSwitch = (name: keyof typeof PROCESSING_SWITCHES): ChannelSettingRule => {
  const { ids, on } = PROCESSING_SWITCHES[name];
  return channel(ids, on === 0 ? { kind: "switch", on: "0" } : SWITCH);
};

export const BASIC_RULES = frozen({
  "input.gain": input(INPUT_PARAMS.gain, wholeDb(INPUT_GAIN_DB)),
  "input.phantom": input(INPUT_PARAMS.phantom, SWITCH),
  "input.hi-z": input(INPUT_PARAMS.hiZ, SWITCH, HI_Z_JACKS),
  "input.clip-safe": input(INPUT_PARAMS.clipSafe, SWITCH),
  "input.clip-safe-active": input(INPUT_PARAMS.clipSafeActive, SWITCH),
  "source.gain": {
    target: "source",
    sources: Object.fromEntries(
      Object.entries(SOURCE_GAIN).map(([token, entry]) => [
        token,
        {
          models: entry.models,
          paramId: entry.paramId,
          read: entry.instances[0] as number,
          // A single evidenced write instance; none while the sequence awaits evidence (F03-G).
          write: entry.writes?.length === 1 ? (entry.writes[0] as number) : null,
        },
      ]),
    ),
    value: wholeDb(SOURCE_GAIN_DB),
  },
  "channel.on": channel(CHANNEL_PARAMS.on, SWITCH),
  "channel.fader": channel(CHANNEL_PARAMS.fader, FADER_LEVEL_RULE),
  "channel.pan": channel(CHANNEL_PARAMS.pan, PAN_RULE),
  "channel.polarity": {
    target: "channel-side",
    address: CHANNEL_PARAMS.polarity,
    value: { kind: "choice", choices: ["normal", "inverted"] },
  },
  "channel.source": { target: "channel-side", address: SOURCE_PARAMS, value: PORTS },
  "channel.stereo-link": pair(PAIR_PARAMS.stereoLink, SWITCH),
  "channel.pan-mode": pair(PAIR_PARAMS.panMode, { kind: "choice", choices: ["pan", "balance"] }),
  "channel.name": channel(IDENTITY_PARAMS.name, { kind: "name", maxCodePoints: NAME_MAX_CODE_POINTS }),
  "channel.color": channel(IDENTITY_PARAMS.color, { kind: "choice", choices: CHANNEL_COLORS }),
  "channel.rec-point": channel(REC_POINT_PARAMS, {
    kind: "by-kind",
    rules: { mono: recPoints(REC_POINTS), stereo: recPoints(STEREO_REC_POINTS) },
  }),
  "channel.processing-mode": channel({ mono: PROCESSING_MODE_ID }, { kind: "choice", choices: PROCESSING_MODES }),
  "channel.hpf.on": processingSwitch("hpf.on"),
  "channel.hpf.frequency": channel(
    { mono: HPF_FREQUENCY_ID },
    {
      kind: "stops",
      unit: "Hz",
      stops: HPF_WRITE_STOPS_HZ.map((hz) => Math.round(hz * 10)),
      scale: 10,
      read: HPF_READ_RAW,
      write: HPF_WRITE_HZ,
    },
  ),
  "channel.gate.on": processingSwitch("gate.on"),
  "channel.comp.on": processingSwitch("comp.on"),
  "channel.eq.on": processingSwitch("eq.on"),
  "channel.ssmcs.on": processingSwitch("ssmcs.on"),
  "channel.ssmcs.comp.on": processingSwitch("ssmcs.comp.on"),
  "channel.ssmcs.eq.on": processingSwitch("ssmcs.eq.on"),
} as const satisfies Record<
  string,
  ChannelSettingRule | ChannelSideSettingRule | InputSettingRule | PairSettingRule | SourceSettingRule
>);
