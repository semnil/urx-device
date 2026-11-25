import { describe, expect, it } from "vitest";
import {
  busLevelPoint,
  channelLevelPoint,
  channelReductionPoint,
  decodeMeterLevel,
  decodeMeterReduction,
  engineReductionPoint,
  pointLevel,
} from "../src/catalog/meters.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting, type ReadArgs, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const readAny = (c: OperationContext, id: string, target: unknown) => readSetting(c, ...([id, target] as unknown as ReadArgs));
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as WriteArgs));
const plan = (id: string, target: object, value: unknown) => previewSetting("URX44", ...([id, target, value] as unknown as WriteArgs)).planned;
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}
const at = (paramId: number, y: number) => ({ paramId, x: "0", y: `${y}` });
const m = (meterId: number, x: number) => ({ meterId, x: `${x}` });

describe("oscillator (F09-O)", () => {
  it("read and write each global field once with an empty target", async () => {
    for (const [id, paramId, raw, value] of [
      ["oscillator.on", 710, "1", true],
      ["oscillator.mode", 712, "2", "burst-noise"],
      ["oscillator.frequency", 713, "10004", 1000.4],
      ["oscillator.level", 711, "-1426", -14.26],
      ["oscillator.burst-width", 714, "125", 0.125],
      ["oscillator.burst-interval", 715, "30", 30],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
      const c = new OperationContext(transport, "URX22");
      expect((await readAny(c, id, {})).value, id).toBe(value);
      await writeAny(c, id, {}, value);
      expect(transport.calls.map(({ address, value: sent }) => ({ address, sent }))).toEqual([
        { address: at(paramId, 0), sent: undefined },
        { address: at(paramId, 0), sent: raw },
      ]);
    }
    expect([plan("oscillator.level", {}, -14.255), plan("oscillator.burst-width", {}, 0.1255), plan("oscillator.burst-width", {}, 0.12551)]).toEqual([
      -14.26, 0.125, 0.126,
    ]);
    for (const [id, bad] of [
      ["oscillator.level", "-inf"],
      ["oscillator.level", -96.01],
      ["oscillator.level", 0.01],
      ["oscillator.frequency", 19.9],
      ["oscillator.burst-width", 0.099],
      ["oscillator.burst-interval", 31],
      ["oscillator.mode", "pink"],
    ] as const) {
      expect(() => plan(id, {}, bad), `${id} ${bad}`).toThrow(/invalid_input/);
    }
    for (const [id, raw] of [
      ["oscillator.level", "-32768"],
      ["oscillator.level", "1"],
      ["oscillator.frequency", "199"],
      ["oscillator.mode", "3"],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), id, {})))?.code, `${id} ${raw}`).toBe("invalid_response");
    }
  });

  it("assign STEREO and MIX per side and FX without a side", async () => {
    for (const [target, paramId, y] of [
      [{ bus: "stereo", side: "left" }, 716, 0],
      [{ bus: "stereo", side: "right" }, 716, 1],
      [{ bus: "mix-1", side: "right" }, 717, 1],
      [{ bus: "mix-2", side: "left" }, 717, 2],
      [{ bus: "mix-2", side: "right" }, 717, 3],
      [{ bus: "fx-1" }, 718, 0],
      [{ bus: "fx-2" }, 718, 1],
    ] as const) {
      const transport = new FakeTransport().script("getNumeric", read("0")).script("setNumeric", accepted);
      const c = new OperationContext(transport, "URX44");
      expect((await readAny(c, "oscillator.assign", target)).value).toBe(false);
      await writeAny(c, "oscillator.assign", target, true);
      expect(transport.calls.map(({ address, value }) => ({ address, value })), JSON.stringify(target)).toEqual([
        { address: at(paramId, y), value: undefined },
        { address: at(paramId, y), value: "1" },
      ]);
    }
    for (const [target, code] of [
      [{ bus: "fx-1", side: "left" }, "invalid_input"],
      [{ bus: "stereo" }, "invalid_input"],
      [{ bus: "stream", side: "left" }, "unsupported_operation"],
      [{ bus: "monitor-1", side: "left" }, "unsupported_operation"],
      [{ bus: "osc" }, "invalid_input"],
    ] as const) {
      expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "oscillator.assign", target)))?.code, JSON.stringify(target)).toBe(code);
    }
  });
});

describe("meter points (F10-M)", () => {
  it("map every channel tap per model, mono at i and stereo at 2p / 2p + 1", () => {
    const mono = { input: 100, "pre-gate": 106, "pre-comp": 108, sidechain: 109, "pre-eq": 111, "pre-insert-fx": 112, "pre-fader": 113, post: 115 };
    const stereo = { input: 101, "pre-fader": 114, "pre-ducker": 116, post: 120 };
    for (const [model, monos, stereos] of [
      ["URX22", [1, 2], [3, 5, 7, 9]],
      ["URX44", [1, 2, 3, 4], [5, 7, 9, 11]],
      ["URX44V", [1, 2, 3, 4], [5, 7, 9, 11]],
    ] as const) {
      for (const channel of monos) {
        for (const [tap, meterId] of Object.entries(mono)) {
          expect(channelLevelPoint(model, channel, tap), `${model} ${channel} ${tap}`).toEqual({ shape: "mono", address: m(meterId, channel - 1) });
        }
        expect(channelLevelPoint(model, channel, "pre-ducker")).toBe("unsupported_operation");
      }
      for (const [p, channel] of stereos.entries()) {
        for (const [tap, meterId] of Object.entries(stereo)) {
          expect(channelLevelPoint(model, channel, tap), `${model} ${channel} ${tap}`).toEqual({ shape: "stereo", left: m(meterId, 2 * p), right: m(meterId, 2 * p + 1) });
        }
        expect(channelLevelPoint(model, channel, "pre-eq")).toBe("unsupported_operation");
        expect(channelReductionPoint(model, channel, "ducker")).toEqual({ shape: "mono", address: m(119, p) });
        expect(channelReductionPoint(model, channel, "gate")).toBe("unsupported_operation");
      }
    }
    expect(channelLevelPoint("URX22", 11, "post")).toBe("unsupported_operation");
    expect(channelLevelPoint("URX44", 6, "post")).toBe("invalid_input");
    expect(channelLevelPoint("URX44", 1, "pre")).toBe("invalid_input");
    expect(channelReductionPoint("URX44", 2, "gate")).toEqual({ shape: "mono", address: m(107, 1) });
    expect(channelReductionPoint("URX44", 2, "comp")).toEqual({ shape: "mono", address: m(110, 1) });
    expect(channelReductionPoint("URX44", 2, "ducker")).toBe("unsupported_operation");
    expect(channelReductionPoint("URX44", 2, "eq")).toBe("invalid_input");
  });

  it("map the bus taps, the singleton points and the shared engines", () => {
    const cases = [
      ["stereo", "pre-eq", { shape: "stereo", left: m(104, 0), right: m(104, 1) }],
      ["stereo", "post", { shape: "stereo", left: m(125, 0), right: m(125, 1) }],
      ["mix-2", "pre-insert-fx", { shape: "stereo", left: m(124, 2), right: m(124, 3) }],
      ["fx-2", "input", { shape: "mono", address: m(131, 1) }],
      ["fx-2", "post", { shape: "stereo", left: m(118, 2), right: m(118, 3) }],
      ["stream", "post", { shape: "stereo", left: m(127, 0), right: m(127, 1) }],
      ["monitor-2", "post", { shape: "stereo", left: m(129, 2), right: m(129, 3) }],
    ] as const;
    for (const [bus, tap, point] of cases) {
      expect(busLevelPoint("URX44", bus, tap), `${bus} ${tap}`).toEqual(point);
    }
    expect(busLevelPoint("URX44", "stream", "pre-fader")).toBe("unsupported_operation");
    expect(busLevelPoint("URX44", "monitor-1", "pre-eq")).toBe("unsupported_operation");
    expect(busLevelPoint("URX44", "main", "post")).toBe("invalid_input");
    expect(pointLevel("cue")).toEqual({ shape: "stereo", left: m(128, 0), right: m(128, 1) });
    expect(pointLevel("oscillator")).toEqual({ shape: "mono", address: m(135, 0) });
    expect(pointLevel("monitor")).toBe("invalid_input");
    expect(engineReductionPoint("input-insert", undefined)).toEqual({ shape: "mono", address: m(132, 0) });
    expect([1, 2, 3].map((band) => engineReductionPoint("output-insert", band))).toEqual([0, 1, 2].map((x) => ({ shape: "mono", address: m(133, x) })));
    for (const [engine, band] of [
      ["input-insert", 1],
      ["output-insert", undefined],
      ["output-insert", 4],
      ["output-insert", "1"],
      ["stereo", undefined],
    ] as const) {
      expect(engineReductionPoint(engine, band), `${engine} ${band}`).toBe("invalid_input");
    }
  });

  it("decode level and reduction values strictly", () => {
    expect(["-1280", "0", "-15", "32767"].map(decodeMeterLevel)).toEqual([
      { state: "finite", value: -128 },
      { state: "finite", value: 0 },
      { state: "finite", value: -1.5 },
      { state: "over" },
    ]);
    expect(["-1280", "0", "-15", "32767"].map(decodeMeterReduction)).toEqual([-128, 0, -1.5, 0]);
    for (const bad of ["-1281", "1", "32766", "32768", "-0", "1.5", "", "-01"]) {
      expect(decodeMeterLevel(bad), bad).toBeUndefined();
      expect(decodeMeterReduction(bad), bad).toBeUndefined();
    }
  });
});
