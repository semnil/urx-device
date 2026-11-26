// The tables written out from urx-router, checked against a fixture taken
// from that pinned revision (test/fixtures/router-ced9c7d2.json, generated
// from DYN_*_STOPS_MS, DUCKER_DECAY_STOPS_MS, COMP_RATIO_STEPS, ssmcsQ,
// preferredNumber(R40, …), SWEET_SPOT_DATA_OPTIONS, HPF_FREQ_STOPS_HZ and the
// FX-return revxTimeSec, revR3TimeSec, initDelayMs, revxFreqHz and fx2FreqHz
// at their display precision), so a
// change to any one entry fails here independently of the implementation.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ATTACK_STOPS_RAW, DUCKER_DECAY_STOPS_RAW, HOLD_STOPS_RAW, RATIO_STOPS_RAW, RELEASE_STOPS_RAW } from "../src/catalog/dynamics-stops.js";
import {
  FX2_FREQUENCY_DECIHZ,
  INITIAL_DELAY_DECIMS,
  REV_R3_TIME_DECISECONDS,
  REVX_FREQUENCY_HZ,
  REVX_TIME_MS,
} from "../src/catalog/fx-return-tables.js";
import { HPF_WRITE_STOPS_HZ } from "../src/catalog/processing.js";
import { SSMCS_FREQUENCY_STEPS_DECIHZ, SSMCS_PRESET_LABELS, SSMCS_Q_STEPS_CENTI } from "../src/catalog/ssmcs.js";
import { OperationContext } from "../src/operations/context.js";
import { previewSetting, readSetting, writeSetting, type ReadArgs, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const router = JSON.parse(readFileSync(new URL("./fixtures/router-ced9c7d2.json", import.meta.url), "utf8")) as Record<string, unknown>;
const ms = (key: string) => router[key] as number[];
const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };

/** The table in its public unit, each raw entry divided by `scale`. */
const scaled = (raw: readonly number[], scale: number) => raw.map((value) => value / scale);

describe("router tables (ced9c7d2)", () => {
  it("match the pinned router entry by entry", () => {
    expect(scaled(ATTACK_STOPS_RAW, 1000)).toEqual(ms("attackMs"));
    expect(scaled(HOLD_STOPS_RAW, 100)).toEqual(ms("holdMs"));
    expect(scaled(RELEASE_STOPS_RAW, 10)).toEqual(ms("releaseMs"));
    expect(scaled(DUCKER_DECAY_STOPS_RAW, 10)).toEqual(ms("duckerDecayMs"));
    expect(scaled(RATIO_STOPS_RAW, 100)).toEqual(ms("compRatioFinite"));
    expect(scaled(SSMCS_Q_STEPS_CENTI, 100)).toEqual(ms("ssmcsQ"));
    expect(scaled(SSMCS_FREQUENCY_STEPS_DECIHZ, 10)).toEqual(ms("ssmcsFrequencyHz"));
    expect([...SSMCS_PRESET_LABELS]).toEqual(router["sweetSpotLabels"]);
    expect([...HPF_WRITE_STOPS_HZ]).toEqual(ms("hpfStopsHz"));
    expect(REVX_TIME_MS.map((type) => type.map((stops) => scaled(stops, 1000)))).toEqual(router["revxTimeSeconds"]);
    expect(scaled(REV_R3_TIME_DECISECONDS, 10)).toEqual(ms("revR3TimeSeconds"));
    expect(scaled(INITIAL_DELAY_DECIMS, 10)).toEqual(ms("initialDelayMs"));
    expect([...REVX_FREQUENCY_HZ]).toEqual(ms("revxFrequencyHz"));
    expect(scaled(FX2_FREQUENCY_DECIHZ, 10)).toEqual(ms("fx2FrequencyHz"));
  });

  it("plan, send and read every attack and decay stop through each setting that uses it", async () => {
    const users = [
      ["channel.gate.attack", { channel: 1 }, "attackMs", 1000, undefined],
      ["channel.comp.attack", { channel: 1 }, "attackMs", 1000, undefined],
      ["channel.ducker.attack", { channel: 5 }, "attackMs", 1000, undefined],
      ["channel.ssmcs.comp.attack", { channel: 1 }, "attackMs", 1000, 57],
      ["channel.gate.decay", { channel: 1 }, "releaseMs", 10, undefined],
      ["channel.comp.release", { channel: 1 }, "releaseMs", 10, undefined],
      ["channel.ssmcs.comp.release", { channel: 1 }, "releaseMs", 10, 24],
      ["channel.ducker.decay", { channel: 5 }, "duckerDecayMs", 10, undefined],
    ] as const;
    for (const [id, target, key, scale, ordinal] of users) {
      const stops = ms(key);
      const writes = new FakeTransport();
      writes.timers = false;
      const reads = new FakeTransport();
      reads.timers = false;
      const w = new OperationContext(writes, "URX44");
      const r = new OperationContext(reads, "URX44");
      for (const [index, stop] of stops.entries()) {
        const raw = `${ordinal === undefined ? Math.round(stop * scale) : index + ordinal}`;
        writes.script("setNumeric", accepted);
        expect((await writeSetting(w, ...([id, target, stop] as unknown as WriteArgs))).planned, `${id} ${stop}`).toBe(stop);
        reads.script("getNumeric", read(raw));
        expect((await readSetting(r, ...([id, target] as unknown as ReadArgs))).value, `${id} raw ${raw}`).toBe(stop);
        const next = stops[index + 1];
        if (next !== undefined) {
          // The midpoint goes to the lower stop, just above it to the upper.
          const midpoint = (Math.round(stop * scale) + Math.round(next * scale)) / 2 / scale;
          const plan = (value: number) => previewSetting("URX44", ...([id, target, value] as unknown as WriteArgs)).planned;
          expect(plan(midpoint), `${id} midpoint ${midpoint}`).toBe(stop);
          expect(plan(midpoint + 1 / scale / 4), `${id} above ${midpoint}`).toBe(next);
        }
      }
      expect(writes.calls.map((call) => call.value), id).toEqual(
        stops.map((stop, index) => `${ordinal === undefined ? Math.round(stop * scale) : index + ordinal}`),
      );
    }
  });
});
