import { describe, expect, it } from "vitest";
import { MONO_CHANNELS, STEREO_CHANNELS, channelIndex } from "../src/catalog/channels.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { previewSetting, readSetting, writeSetting } from "../src/operations/registry.js";
import { FakeTransport, type Method } from "./fake-transport.js";

const at = new Date("2026-11-20T00:00:00.000Z");
const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };

function context(model: string, method?: Method, ...records: unknown[]) {
  const transport = new FakeTransport();
  if (method !== undefined) {
    transport.script(method, ...records);
  }
  return { transport, context: new OperationContext(transport, model, () => at) };
}

async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}

describe("channel identity (C12)", () => {
  it("names every mono and fixed stereo channel once, with no aliases", () => {
    expect(MONO_CHANNELS).toEqual({ URX22: [1, 2], URX44: [1, 2, 3, 4], URX44V: [1, 2, 3, 4] });
    expect(STEREO_CHANNELS).toEqual({ URX22: [3, 5, 7, 9], URX44: [5, 7, 9, 11], URX44V: [5, 7, 9, 11] });
    expect(channelIndex("URX22", 3)).toEqual({ kind: "stereo", index: 0 });
    expect(channelIndex("URX44", 5)).toEqual({ kind: "stereo", index: 0 });
    expect(channelIndex("URX44", 11)).toEqual({ kind: "stereo", index: 3 });
    expect(channelIndex("URX44", 4)).toEqual({ kind: "mono", index: 3 });
    for (const channel of [0, 6, 12, 5.5, "5", "5-6"]) {
      expect(channelIndex("URX44", channel), String(channel)).toBeUndefined();
    }
    expect(channelIndex("URX22", 4)).toBeUndefined();
  });
});

describe("basic channel controls (F03-H)", () => {
  it("address each control's own parameter for mono and fixed stereo", async () => {
    const cases = [
      ["channel.on", 1, 140, "0"],
      ["channel.on", 5, 267, "0"],
      ["channel.fader", 2, 139, "1"],
      ["channel.fader", 7, 266, "1"],
      ["channel.pan", 4, 141, "3"],
      ["channel.pan", 11, 268, "3"],
    ] as const;
    for (const [id, channel, paramId, y] of cases) {
      const { transport, context: c } = context("URX44", "getNumeric", read("0"));
      await readSetting(c, id, { channel });
      expect(transport.calls).toEqual([{ method: "getNumeric", address: { paramId, x: "0", y }, ticket: "t0" }]);
    }
  });

  it("plan fader levels in 0.01 dB with lower ties and only -inf as silence", () => {
    const plan = (value: number | "-inf") => previewSetting("URX44", "channel.fader", { channel: 1 }, value).planned;
    expect(plan(-15)).toBe(-15);
    expect(plan(-15.005)).toBe(-15.01);
    expect(plan(-15.0049)).toBe(-15);
    expect(plan(10)).toBe(10);
    expect(plan(-96)).toBe(-96);
    expect(plan("-inf")).toBe("-inf");
    for (const value of [-96.5, 10.01, Number.NaN, Infinity, -Infinity, "off" as never, "-infinity" as never]) {
      expect(() => plan(value), String(value)).toThrow();
    }
  });

  it("write a fader level and -inf at their raw values once", async () => {
    const { transport, context: c } = context("URX44V", "setNumeric", accepted, accepted);
    expect((await writeSetting(c, "channel.fader", { channel: 9 }, -15.005)).planned).toBe(-15.01);
    await writeSetting(c, "channel.fader", { channel: 1 }, "-inf");
    expect(transport.calls.map((call) => [call.address, call.value])).toEqual([
      [{ paramId: 266, x: "0", y: "2" }, "-1501"],
      [{ paramId: 139, x: "0", y: "0" }, "-32768"],
    ]);
  });

  it("decode fader reads without snapping, and refuse other raw values", async () => {
    const { context: c } = context("URX44", "getNumeric", read("-1500"), read("-32768"), read("-9601"), read("1001"));
    expect((await readSetting(c, "channel.fader", { channel: 1 })).value).toBe(-15);
    expect((await readSetting(c, "channel.fader", { channel: 1 })).value).toBe("-inf");
    for (let i = 0; i < 2; i += 1) {
      expect((await failureOf(readSetting(c, "channel.fader", { channel: 1 })))?.code).toBe("invalid_response");
    }
  });

  it("plan pan on integer stops with lower ties and decode -63..63", async () => {
    const plan = (value: number) => previewSetting("URX44", "channel.pan", { channel: 1 }, value).planned;
    expect(plan(-0.5)).toBe(-1);
    expect(plan(0.5)).toBe(0);
    expect(plan(63)).toBe(63);
    expect(() => plan(63.5)).toThrow();
    const { context: c } = context("URX44", "getNumeric", read("-63"), read("64"));
    expect((await readSetting(c, "channel.pan", { channel: 1 })).value).toBe(-63);
    expect((await failureOf(readSetting(c, "channel.pan", { channel: 1 })))?.code).toBe("invalid_response");
  });

  it("require a side for fixed stereo polarity and refuse it elsewhere", async () => {
    const { transport, context: c } = context("URX22", "setNumeric", accepted, accepted, accepted);
    await writeSetting(c, "channel.polarity", { channel: 3, side: "left" }, "inverted");
    await writeSetting(c, "channel.polarity", { channel: 9, side: "right" }, "normal");
    await writeSetting(c, "channel.polarity", { channel: 2 }, "inverted");
    expect(transport.calls.map((call) => [call.address, call.value])).toEqual([
      [{ paramId: 211, x: "0", y: "0" }, "1"],
      [{ paramId: 212, x: "0", y: "3" }, "0"],
      [{ paramId: 24, x: "0", y: "1" }, "1"],
    ]);
    const { transport: none, context: n } = context("URX22");
    for (const [id, target] of [
      ["channel.polarity", { channel: 3 }],
      ["channel.polarity", { channel: 1, side: "left" }],
      ["channel.on", { channel: 3, side: "left" }],
      ["channel.fader", { channel: 1, side: "right" }],
    ] as const) {
      expect((await failureOf(readSetting(n, id, target as never)))?.code, JSON.stringify(target)).toBe("invalid_input");
    }
    expect(none.calls).toEqual([]);
    const { context: p } = context("URX44", "getNumeric", read("0"), read("1"), read("2"));
    expect((await readSetting(p, "channel.polarity", { channel: 1 })).value).toBe("normal");
    expect((await readSetting(p, "channel.polarity", { channel: 5, side: "left" })).value).toBe("inverted");
    expect((await failureOf(readSetting(p, "channel.polarity", { channel: 1 })))?.code).toBe("invalid_response");
  });

  it("refuse channels a model lacks before traffic", async () => {
    const { transport, context: c } = context("URX22");
    for (const channel of [4, 11, 0]) {
      expect((await failureOf(readSetting(c, "channel.on", { channel })))?.code).toBe("invalid_input");
      expect((await failureOf(writeSetting(c, "channel.on", { channel }, true)))?.code).toBe("invalid_input");
    }
    expect(transport.calls).toEqual([]);
  });

  it("round values just above a midpoint up and the midpoint itself down", () => {
    const fader = (value: number) => previewSetting("URX44", "channel.fader", { channel: 1 }, value).planned;
    const pan = (value: number) => previewSetting("URX44", "channel.pan", { channel: 1 }, value).planned;
    expect(fader(-15.004999999999)).toBe(-15);
    expect(fader(-15.005)).toBe(-15.01);
    expect(fader(0.005)).toBe(0);
    expect(fader(0.0050000001)).toBe(0.01);
    expect(pan(0.5000000001)).toBe(1);
    expect(pan(0.5)).toBe(0);
    expect(pan(-0.4999999999)).toBe(0);
  });

  it("type a whole-channel target without a side", () => {
    const context = new OperationContext(new FakeTransport(), "URX44");
    const polarityTarget = { channel: 5, side: "left" } as const;
    const checks = () => {
      // @ts-expect-error a side for a whole-channel setting
      void readSetting(context, "channel.fader", polarityTarget);
      // @ts-expect-error a side for a whole-channel write
      void writeSetting(context, "channel.on", { channel: 5, side: "left" }, true);
      void readSetting(context, "channel.polarity", polarityTarget);
    };
    expect(typeof checks).toBe("function");
  });
});
