import { describe, expect, it } from "vitest";
import { decimalValue, isDecimalValue, type DecimalValue } from "../src/catalog/decimal.js";
import { ATTACK_STOPS_RAW } from "../src/catalog/dynamics-stops.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { dryRunSetting, previewSetting, validateSetting, writeSetting, type DecimalWriteArgs, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const decimal = (text: string) => decimalValue(text) as DecimalValue;
const previewAny = (model: string, id: string, target: unknown, value: unknown) =>
  previewSetting(model, ...([id, target, value] as unknown as DecimalWriteArgs));
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as DecimalWriteArgs));
const validateAny = (model: string, id: string, target: unknown, value: unknown) =>
  validateSetting(model, ...([id, target, value] as unknown as DecimalWriteArgs));
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}
/** The planned decimal text of a preview, or the refusal's code. */
function planned(model: string, id: string, target: unknown, text: string) {
  try {
    return (previewAny(model, id, target, decimal(text)).planned as DecimalValue).decimal;
  } catch (error) {
    return operationFailureOf(error)?.code;
  }
}

describe("decimal write values (C6)", () => {
  it("accept ordinary decimal text only, in canonical form", () => {
    for (const [text, canonical] of [
      ["-6", "-6"],
      ["0.5", "0.5"],
      ["1000", "1000"],
      ["007", "7"],
      ["00.50", "0.5"],
      ["-0", "0"],
      ["-0.000", "0"],
      ["-001.2300", "-1.23"],
      ["10.0000000000000001", "10.0000000000000001"],
    ] as const) {
      expect(decimalValue(text), text).toEqual({ decimal: canonical });
    }
    for (const text of ["1e3", "5e-1", "+1", ".5", "5.", "", " 1", "1 ", "0x10", "1_0", "١", "--1", "1.2.3", "Infinity", "NaN", "-"]) {
      expect(decimalValue(text), JSON.stringify(text)).toBeUndefined();
    }
  });

  it("recognize only an object whose own decimal is C6 text", () => {
    expect(isDecimalValue({ decimal: "1.5" })).toBe(true);
    expect(isDecimalValue({ decimal: "007" })).toBe(true);
    for (const value of [{ decimal: "1e3" }, { decimal: 1.5 }, Object.create({ decimal: "1" }), "1.5", 1.5, null, undefined, []]) {
      expect(isDecimalValue(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("numeric writes given as decimal text (W2)", () => {
  it("check the range on the exact value before rounding", () => {
    const fader = (text: string) => planned("URX44", "channel.fader", { channel: 1 }, text);
    expect(fader("10.0000000000000001")).toBe("invalid_input");
    expect(fader("10")).toBe("10");
    expect(fader("-96")).toBe("-96");
    expect(fader("-96.0000000000000001")).toBe("invalid_input");
    // A request a number would turn into Infinity is out of range, not infinite.
    expect(fader("9".repeat(309))).toBe("invalid_input");
    expect(fader(`-${"9".repeat(309)}`)).toBe("invalid_input");
  });

  it("round on the exact value, a tie going to the lower value", () => {
    const pan = (text: string) => planned("URX44", "channel.pan", { channel: 1 }, text);
    expect(pan("0.50000000000000001")).toBe("1");
    expect(pan("0.5")).toBe("0");
    expect(pan("-0.5")).toBe("-1");
    expect(pan("-0.49999999999999999")).toBe("0");
    expect(pan("63.0000000000000000001")).toBe("invalid_input");
    const fader = (text: string) => planned("URX44", "channel.fader", { channel: 1 }, text);
    expect(fader("-15.005")).toBe("-15.01");
    expect(fader("-15.00499999999999999999")).toBe("-15");
    expect(fader("-15.00500000000000000001")).toBe("-15.01");
    expect(fader("1.005")).toBe("1");
  });

  it("round a stop table at its exact midpoints", () => {
    // Gate attack: stops in 1 / 1000 ms, so the mean of two neighbours is exact in 1 / 10000 ms.
    const [low, high] = (ATTACK_STOPS_RAW as readonly number[]).slice(0, 2).map(BigInt) as [bigint, bigint];
    const ms = (tenThousandths: bigint) => `${tenThousandths / 10000n}.${`${tenThousandths % 10000n}`.padStart(4, "0")}`;
    const mid = ms((low + high) * 5n);
    const attack = (value: string) => planned("URX44", "channel.gate.attack", { channel: 1 }, value);
    expect(attack(mid)).toBe(decimal(ms(low * 10n)).decimal);
    expect(attack(`${mid}000000000000000001`)).toBe(decimal(ms(high * 10n)).decimal);
    const hpf = (value: string) => planned("URX44", "channel.hpf.frequency", { channel: 1 }, value);
    expect(hpf("41.25")).toBe("40");
    expect(hpf("41.25000000000000000001")).toBe("42.5");
    expect(hpf("120")).toBe("118");
    expect(hpf("120.00000000000000000001")).toBe("invalid_input");
    expect(hpf("39.99999999999999999999")).toBe("invalid_input");
  });

  it("take a selector index and a value set only at an exact member", () => {
    const preset = (text: string) => planned("URX44", "channel.ssmcs.preset", { channel: 1 }, text);
    expect(preset("3")).toBe("3");
    expect(preset("3.0")).toBe("3");
    expect(preset("3.00000000000000000001")).toBe("invalid_input");
    expect(preset("35")).toBe("invalid_input");
    // The sample rate's plan reads device state first, so its value check is validation's.
    expect(() => validateAny("URX22", "device.sample-rate", {}, decimal("48000.000"))).not.toThrow();
    expect(() => validateAny("URX22", "device.sample-rate", {}, decimal("48000.00000000000000001"))).toThrow(/invalid_input/);
  });

  it("report the requested value as canonical text and send the planned value's raw once", async () => {
    expect(previewAny("URX44", "channel.fader", { channel: 1 }, { decimal: "-003.500" })).toEqual({
      requested: { decimal: "-3.5" },
      planned: { decimal: "-3.5" },
    });
    const transport = new FakeTransport().script("setNumeric", accepted);
    const result = await writeAny(new OperationContext(transport, "URX44V"), "channel.fader", { channel: 9 }, decimal("-15.005"));
    expect([result.requested, result.planned, result.outcome]).toEqual([{ decimal: "-15.005" }, { decimal: "-15.01" }, "accepted"]);
    expect(transport.calls.map((call) => call.value)).toEqual(["-1501"]);
  });

  it("check a decimal value through validation and a dry run as a write does", async () => {
    expect(() => validateAny("URX44", "channel.fader", { channel: 1 }, decimal("10.0000000000000001"))).toThrow(/invalid_input/);
    expect(() => validateAny("URX44", "channel.fader", { channel: 1 }, decimal("10"))).not.toThrow();
    const plan = await dryRunSetting(new OperationContext(new FakeTransport(), "URX44"), "channel.pan", { channel: 1 }, decimal("0.50000000000000001"));
    expect(plan).toEqual({ requested: { decimal: "0.50000000000000001" }, planned: { decimal: "1" }, unverified: [] });
  });

  it("check and round a Flex12GEQ gain and an FX reverb time on exact values", async () => {
    const target = { bus: "mix-1", side: "left", band: "1000" } as const;
    expect(() => validateAny("URX44", "bus.geq.gain", target, decimal("15"))).not.toThrow();
    expect(() => validateAny("URX44", "bus.geq.gain", target, decimal("15.0000000000000001"))).toThrow(/invalid_input/);
    const gain = async (text: string) => {
      const transport = new FakeTransport().script("getNumeric", read("2"), read("1")).script("setNumeric", accepted);
      const result = await writeAny(new OperationContext(transport, "URX44"), "bus.geq.gain", { bus: "mix-1", side: "left", band: "20" }, decimal(text));
      return [(result.planned as DecimalValue).decimal, transport.calls.at(-1)?.value];
    };
    expect(await gain("0.25")).toEqual(["0", "0"]);
    expect(await gain("0.25000000000000000001")).toEqual(["0.5", "50"]);
    const fx = { bus: "fx-1", effect: "rev-x-hall", parameter: "reverb-time" } as const;
    expect(() => validateAny("URX44", "bus.fx.parameter", fx, decimal("31"))).not.toThrow();
    expect(() => validateAny("URX44", "bus.fx.parameter", fx, decimal("31.0000000000000001"))).toThrow(/invalid_input/);
    expect(() => validateAny("URX44", "bus.fx.parameter", fx, decimal("0.10299999999999999999"))).toThrow(/invalid_input/);
  });

  it("refuse a decimal value where the setting takes no number", async () => {
    for (const [id, target] of [
      ["channel.on", { channel: 1 }],
      ["channel.polarity", { channel: 1 }],
      ["channel.name", { channel: 1 }],
    ] as const) {
      expect(planned("URX44", id, target, "1"), id).toBe("invalid_input");
    }
    expect((await failureOf(writeAny(new OperationContext(new FakeTransport(), "URX44"), "channel.on", { channel: 1 }, decimal("1"))))?.code).toBe("invalid_input");
  });

  // One operation works from the value as it was when the call was made: a caller that changes
  // its object while the prerequisites are read changes nothing the operation checks, sends or
  // reports, and a value read by a getter is read once.
  it("read a decimal value once, at the call", async () => {
    const changing = (...texts: string[]) => {
      let reads = 0;
      return {
        value: {
          get decimal() {
            reads += 1;
            return texts[Math.min(reads, texts.length) - 1] as string;
          },
        },
        reads: () => reads,
      };
    };
    const pan = changing("3", "0.5");
    expect(previewAny("URX44", "channel.pan", { channel: 1 }, pan.value)).toEqual({ requested: { decimal: "3" }, planned: { decimal: "3" } });
    expect(pan.reads()).toBe(1);
    const time = changing("0.927", "10.3");
    const transport = new FakeTransport().script("getNumeric", read("0"), read("0")).script("setNumeric", accepted);
    const fx = { bus: "fx-1", effect: "rev-x-hall", parameter: "reverb-time" };
    const result = await writeAny(new OperationContext(transport, "URX44"), "bus.fx.parameter", fx, time.value);
    expect([result.requested, result.planned, transport.calls.at(-1)?.value, time.reads()]).toEqual([{ decimal: "0.927" }, { decimal: "0.927" }, "24", 1]);
    const owned = { decimal: "0.5" };
    const gain = new FakeTransport().script("getNumeric", read("2"), read("1")).script("setNumeric", accepted);
    const writing = writeAny(new OperationContext(gain, "URX44"), "bus.geq.gain", { bus: "mix-1", side: "left", band: "20" }, owned);
    owned.decimal = "2";
    const written = await writing;
    expect([written.requested, written.planned, gain.calls.at(-1)?.value]).toEqual([{ decimal: "0.5" }, { decimal: "0.5" }, "50"]);
  });

  it("type a decimal write as numeric settings only, its plan in decimal text", () => {
    const check = () => {
      const plan: { planned: DecimalValue } = previewSetting("URX44", "channel.fader", { channel: 1 }, decimal("-3"));
      const number: { planned: number | "-inf" } = previewSetting("URX44", "channel.fader", { channel: 1 }, -3);
      void plan;
      void number;
      // @ts-expect-error a switch takes no decimal text
      void previewSetting("URX44", "channel.on", { channel: 1 }, decimal("1"));
      // @ts-expect-error a name's text is not decimal text
      void previewSetting("URX44", "channel.name", { channel: 1 }, decimal("1"));
      const forwarded = (...[model, ...args]: Parameters<typeof previewSetting>) => previewSetting(model, ...args);
      void forwarded("URX44", "channel.pan", { channel: 1 }, decimal("0.5"));
      void forwarded("URX44", ...(["channel.pan", { channel: 1 }, 0.5] as WriteArgs));
      // A value that may be either form plans as either form.
      const either = (value: number | DecimalValue) => previewSetting("URX44", "channel.pan", { channel: 1 }, value);
      const both: { planned: number | DecimalValue } = either(2);
      void both;
      // @ts-expect-error a value that may be decimal text may plan as decimal text
      const onlyNumber: { planned: number } = either(2);
      void onlyNumber;
    };
    void check;
  });
});

