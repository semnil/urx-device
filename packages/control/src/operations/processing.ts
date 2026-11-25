// Channel processing switches and mode (F04-S): each operation reads or
// writes its fixed address once; no mode read selects an address, and a mode
// write changes nothing else.

import { decodeInteger } from "../catalog/codecs.js";
import type { I64Text } from "../catalog/i64.js";
import {
  HPF_FREQUENCY_ID,
  HPF_READ_RAW,
  HPF_WRITE_HZ,
  HPF_WRITE_STOPS_HZ,
  PROCESSING_MODES,
  PROCESSING_MODE_ID,
  PROCESSING_SWITCHES,
} from "../catalog/processing.js";
import type { ProcessingMode } from "../catalog/settings.js";
import { channelSetting } from "./channels.js";

/** A switch whose raw `on` value means on; the other of 0/1 means off. */
function processingSwitch(name: keyof typeof PROCESSING_SWITCHES) {
  const { ids, on } = PROCESSING_SWITCHES[name];
  const decode = (raw: I64Text): boolean | undefined =>
    raw === `${on}` ? true : raw === `${1 - on}` ? false : undefined;
  const plan = (value: unknown) =>
    typeof value === "boolean" ? { planned: value, raw: `${value ? on : 1 - on}` } : undefined;
  return channelSetting<boolean>(ids, decode, plan);
}

export const hpfOn = processingSwitch("hpf.on");
export const gateOn = processingSwitch("gate.on");
export const compOn = processingSwitch("comp.on");
export const eqOn = processingSwitch("eq.on");
export const ssmcsOn = processingSwitch("ssmcs.on");
export const ssmcsCompOn = processingSwitch("ssmcs.comp.on");
export const ssmcsEqOn = processingSwitch("ssmcs.eq.on");

export const processingMode = channelSetting<ProcessingMode>(
  { mono: PROCESSING_MODE_ID },
  (raw) => {
    const index = decodeInteger(raw, 0, PROCESSING_MODES.length - 1);
    return index === undefined ? undefined : PROCESSING_MODES[index];
  },
  (value) => {
    const index = (PROCESSING_MODES as readonly unknown[]).indexOf(value);
    return index < 0 ? undefined : { planned: value as ProcessingMode, raw: `${index}` };
  },
);

/** The nearest writable stop, a tie going to the lower stop (W2). */
function nearestStop(hz: number): number {
  let best: number = HPF_WRITE_STOPS_HZ[0];
  for (const stop of HPF_WRITE_STOPS_HZ) {
    if (Math.abs(stop - hz) < Math.abs(best - hz)) {
      best = stop;
    }
  }
  return best;
}

export const hpfFrequency = channelSetting<number>(
  { mono: HPF_FREQUENCY_ID },
  (raw) => {
    const tenths = decodeInteger(raw, HPF_READ_RAW.min, HPF_READ_RAW.max);
    // Decoded without snapping: a read may report a value the link cannot write.
    return tenths === undefined ? undefined : tenths / 10;
  },
  (value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < HPF_WRITE_HZ.min || value > HPF_WRITE_HZ.max) {
      return undefined;
    }
    const planned = nearestStop(value);
    return { planned, raw: `${Math.round(planned * 10)}` };
  },
);
