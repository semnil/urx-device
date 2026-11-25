// GATE and ordinary-COMP settings (F04-D): mono only, one addressed read or
// write each; no 1-knob, Auto Makeup or processing-mode read, no automatic
// disabling.

import { decodeInteger, decodeSwitch, planOnGrid } from "../catalog/codecs.js";
import {
  ATTACK_STOPS_RAW,
  HOLD_STOPS_RAW,
  RELEASE_STOPS_RAW,
  RATIO_STOPS_RAW,
} from "../catalog/dynamics-stops.js";
import type { I64Text } from "../catalog/i64.js";
import type { CompKnee, CompRatio, GateRange } from "../catalog/settings.js";
import { channelSetting, planSwitch } from "./channels.js";

/** A dB setting on a 0.01 dB grid within [min, max] (F18-P), raw dB × 100. */
function centiDbGrid(paramId: number, min: number, max: number) {
  return channelSetting<number>(
    { mono: paramId },
    (raw) => {
      const value = decodeInteger(raw, min * 100, max * 100);
      return value === undefined ? undefined : value / 100;
    },
    (value) => {
      const planned = typeof value === "number" ? planOnGrid(value, min, max, 100) : undefined;
      return planned === undefined ? undefined : { planned, raw: `${Math.round(planned * 100)}` };
    },
  );
}

/**
 * The nearest stop to `requested` (in the stops' unit / `scale`), a tie
 * going to the lower stop; compared with each midpoint in the request's unit.
 */
function nearestRawStop(stops: readonly number[], scale: number, requested: number): number {
  let index = 0;
  while (index + 1 < stops.length && requested > ((stops[index] as number) + (stops[index + 1] as number)) / 2 / scale) {
    index += 1;
  }
  return stops[index] as number;
}

/** A time setting on a nonuniform stop table, raw ms × `scale`. */
function stopTable(paramId: number, stops: readonly number[], scale: number) {
  const min = (stops[0] as number) / scale;
  const max = (stops[stops.length - 1] as number) / scale;
  return channelSetting<number>(
    { mono: paramId },
    (raw) => {
      // Decoded without snapping to a stop.
      const value = decodeInteger(raw, stops[0] as number, stops[stops.length - 1] as number);
      return value === undefined ? undefined : value / scale;
    },
    (value) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        return undefined;
      }
      const raw = nearestRawStop(stops, scale, value);
      return { planned: raw / scale, raw: `${raw}` };
    },
  );
}

export const gateThreshold = centiDbGrid(29, -72, 0);

const GATE_RANGE_NEGATIVE_INFINITY = "-32768";
export const gateRange = channelSetting<GateRange>(
  { mono: 30 },
  (raw) => {
    if (raw === GATE_RANGE_NEGATIVE_INFINITY) {
      return "-inf";
    }
    const value = decodeInteger(raw, -7200, 0);
    return value === undefined ? undefined : value / 100;
  },
  (value) => {
    if (value === "-inf") {
      return { planned: "-inf", raw: GATE_RANGE_NEGATIVE_INFINITY };
    }
    const planned = typeof value === "number" ? planOnGrid(value, -72, 0, 100) : undefined;
    return planned === undefined ? undefined : { planned, raw: `${Math.round(planned * 100)}` };
  },
);

export const gateAttack = stopTable(31, ATTACK_STOPS_RAW, 1000);
export const gateHold = stopTable(32, HOLD_STOPS_RAW, 100);
export const gateDecay = stopTable(33, RELEASE_STOPS_RAW, 10);

export const compThreshold = centiDbGrid(35, -54, 0);

const RATIO_INFINITY = "65535";
export const compRatio = channelSetting<CompRatio>(
  { mono: 36 },
  (raw) => {
    if (raw === RATIO_INFINITY) {
      return "inf";
    }
    // A finite read wider than the write stops is an observation, kept as is.
    const value = decodeInteger(raw, 100, 65534);
    return value === undefined ? undefined : value / 100;
  },
  (value) => {
    if (value === "inf") {
      return { planned: "inf", raw: RATIO_INFINITY };
    }
    const last = RATIO_STOPS_RAW[RATIO_STOPS_RAW.length - 1] as number;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > last / 100) {
      return undefined;
    }
    const raw = nearestRawStop(RATIO_STOPS_RAW, 100, value);
    return { planned: raw / 100, raw: `${raw}` };
  },
);

const KNEES = ["soft", "medium", "hard"] as const;
export const compKnee = channelSetting<CompKnee>(
  { mono: 37 },
  (raw) => {
    const index = decodeInteger(raw, 0, KNEES.length - 1);
    return index === undefined ? undefined : KNEES[index];
  },
  (value) => {
    const index = (KNEES as readonly unknown[]).indexOf(value);
    return index < 0 ? undefined : { planned: value as CompKnee, raw: `${index}` };
  },
);

export const compGain = centiDbGrid(38, 0, 18);
export const compAttack = stopTable(39, ATTACK_STOPS_RAW, 1000);
export const compRelease = stopTable(40, RELEASE_STOPS_RAW, 10);
export const compAutoMakeup = channelSetting<boolean>({ mono: 41 }, decodeSwitch, planSwitch);
export const compOneKnobOn = channelSetting<boolean>({ mono: 42 }, decodeSwitch, planSwitch);
export const compOneKnobLevel = channelSetting<number>(
  { mono: 43 },
  (raw: I64Text) => decodeInteger(raw, 0, 100),
  (value) => {
    const planned = typeof value === "number" ? planOnGrid(value, 0, 100, 1) : undefined;
    return planned === undefined ? undefined : { planned, raw: `${planned}` };
  },
);
