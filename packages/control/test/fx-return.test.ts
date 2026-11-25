import { describe, expect, it } from "vitest";
import { FX_RETURN_RULES } from "../src/catalog/fx-return.js";
import { FX2_FREQUENCY_DECIHZ, INITIAL_DELAY_DECIMS, REVX_FREQUENCY_HZ, REVX_TIME_MS, REV_R3_TIME_DECISECONDS } from "../src/catalog/fx-return-tables.js";
import type { StopsRule, ValueRule } from "../src/catalog/rules.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { dryRunSetting, previewSetting, readSetting, writeSetting, type ReadArgs, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const readAny = (c: OperationContext, id: string, target: unknown) => readSetting(c, ...([id, target] as unknown as ReadArgs));
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as WriteArgs));
const dryAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  dryRunSetting(c, ...([id, target, value] as unknown as WriteArgs));
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}
const at = (paramId: number, y = 0) => ({ paramId, x: "0", y: `${y}` });
const ADDRESS = { "fx-1": { selector: 679, array: 681 }, "fx-2": { selector: 683, array: 685 } } as const;

/** A parameter read through a transport answering the selector, then each later read in turn. */
async function parameter(bus: "fx-1" | "fx-2", effect: string, name: string, selector: string, ...raws: string[]) {
  const transport = new FakeTransport().script("getNumeric", read(selector), ...raws.map(read));
  transport.timers = false;
  const result = await readAny(new OperationContext(transport, "URX44"), "bus.fx.parameter", { bus, effect, parameter: name }).then(
    (reading) => ({ value: reading.value }),
    (error: unknown) => ({ code: operationFailureOf(error)?.code }),
  );
  return { result, addresses: transport.calls.map((call) => call.address) };
}

describe("FX returns (F06-F, F06-V)", () => {
  it("read and write each bus's own menu at its selector, refusing the other bus's types", async () => {
    const menus = {
      "fx-1": { "rev-x-hall": "0", "rev-x-room": "1", "rev-x-plate": "2", "mono-delay": "1024", "ping-pong": "1025" },
      "fx-2": { "rev-r3-hall": "768", "rev-r3-room": "769", "rev-r3-plate": "770", "mono-delay": "1024", "ping-pong": "1025" },
    } as const;
    for (const [bus, menu] of Object.entries(menus) as [keyof typeof menus, Record<string, string>][]) {
      for (const [token, raw] of Object.entries(menu)) {
        const transport = new FakeTransport().script("getNumeric", read(raw)).script("setNumeric", accepted);
        const c = new OperationContext(transport, "URX44");
        expect((await readAny(c, "bus.fx.type", { bus })).value, `${bus} ${token}`).toBe(token);
        await writeAny(c, "bus.fx.type", { bus }, token);
        expect(transport.calls.map(({ address, value }) => ({ address, value }))).toEqual([
          { address: at(ADDRESS[bus].selector), value: undefined },
          { address: at(ADDRESS[bus].selector), value: raw },
        ]);
      }
      const other = bus === "fx-1" ? menus["fx-2"] : menus["fx-1"];
      for (const [token, raw] of Object.entries(other)) {
        if (token in menu) continue;
        expect(() => previewSetting("URX44", "bus.fx.type", { bus }, token as never), `${bus} ${token}`).toThrow(/unsupported_operation/);
        const transport = new FakeTransport().script("getNumeric", read(raw));
        expect((await failureOf(readAny(new OperationContext(transport, "URX44"), "bus.fx.type", { bus })))?.code, `${bus} reads ${raw}`).toBe(
          "invalid_response",
        );
      }
    }
    for (const bad of ["none", "rev-x", "delay", "0"]) {
      expect(() => previewSetting("URX44", "bus.fx.type", { bus: "fx-1" }, bad as never), bad).toThrow(/invalid_input/);
    }
    expect((await failureOf(readAny(new OperationContext(new FakeTransport(), "URX44"), "bus.fx.type", { bus: "stereo" })))?.code).toBe(
      "unsupported_operation",
    );
  });

  it("read a parameter after one selector read of its own bus, and stop on a mismatch or a bad selector", async () => {
    expect(await parameter("fx-1", "rev-x-hall", "decay", "0", "40")).toEqual({ result: { value: 40 }, addresses: [at(679), at(681, 15)] });
    expect(await parameter("fx-2", "mono-delay", "bpm", "1024", "120")).toEqual({ result: { value: 120 }, addresses: [at(683), at(685, 3)] });
    // Same family, other type: not an alias.
    expect(await parameter("fx-1", "rev-x-hall", "decay", "1")).toEqual({ result: { code: "precondition_failed" }, addresses: [at(679)] });
    expect(await parameter("fx-1", "mono-delay", "bpm", "1025")).toEqual({ result: { code: "precondition_failed" }, addresses: [at(679)] });
    for (const bad of ["3", "768", "-1", "4294967295"]) {
      expect((await parameter("fx-1", "mono-delay", "bpm", bad)).result, bad).toEqual({ code: "invalid_response" });
    }
    const none = new FakeTransport();
    const c = new OperationContext(none, "URX44");
    for (const [target, code] of [
      [{ bus: "fx-2", effect: "rev-x-hall", parameter: "decay" }, "unsupported_operation"],
      [{ bus: "fx-1", effect: "mono-delay", parameter: "room-size" }, "unsupported_operation"],
      [{ bus: "stereo", effect: "mono-delay", parameter: "bpm" }, "unsupported_operation"],
      [{ bus: "fx-1", effect: "rev-x-hall", parameter: "reverb-time-step" }, "invalid_input"],
      [{ bus: "fx-1", effect: "rev-x", parameter: "decay" }, "invalid_input"],
      [{ bus: "fx-3", effect: "mono-delay", parameter: "bpm" }, "invalid_input"],
      [{ bus: "fx-1", effect: "mono-delay" }, "invalid_input"],
      [{ bus: "fx-1", effect: "mono-delay", parameter: "bpm", channel: 1 }, "invalid_input"],
    ] as const) {
      expect((await failureOf(readAny(c, "bus.fx.parameter", target)))?.code, JSON.stringify(target)).toBe(code);
    }
    expect(none.calls).toEqual([]);
  });

  it("round-trip every raw of every tabled or ranged parameter at its slot", async () => {
    const effects = FX_RETURN_RULES["bus.fx.parameter"].effects;
    for (const [effect, rule] of Object.entries(effects)) {
      if (rule === undefined) continue;
      for (const bus of ["fx-1", "fx-2"] as const) {
        const selector = rule.selector[bus];
        if (selector === undefined) continue;
        for (const [name, field] of Object.entries(rule.parameters)) {
          if (field === undefined || field.value.kind === "context-stops") continue;
          for (const [raw, value] of rawsOf(field.value)) {
            const { result, addresses } = await parameter(bus, effect, name, selector, raw);
            expect(result, `${bus} ${effect} ${name} ${raw}`).toEqual({ value });
            expect(addresses[1], `${effect} ${name}`).toEqual(at(ADDRESS[bus].array, field.slot));
          }
        }
      }
    }
  });

  it("check the F06-V tables, filters with THRU and the delay write grids", async () => {
    expect(INITIAL_DELAY_DECIMS.length).toBe(128);
    expect([INITIAL_DELAY_DECIMS[0], INITIAL_DELAY_DECIMS[127]]).toEqual([1, 2000]);
    expect([REV_R3_TIME_DECISECONDS[0], REV_R3_TIME_DECISECONDS[47], REV_R3_TIME_DECISECONDS[48], REV_R3_TIME_DECISECONDS[69]]).toEqual([3, 50, 55, 300]);
    expect([REVX_FREQUENCY_HZ.slice(0, 53).length, REVX_FREQUENCY_HZ.slice(34, 61).length, REVX_FREQUENCY_HZ.slice(1, 60).length]).toEqual([53, 27, 59]);
    expect([REVX_FREQUENCY_HZ[1], REVX_FREQUENCY_HZ[52], REVX_FREQUENCY_HZ[34], REVX_FREQUENCY_HZ[60]]).toEqual([22, 8000, 1000, 20000]);
    expect([FX2_FREQUENCY_DECIHZ[0], FX2_FREQUENCY_DECIHZ[103], FX2_FREQUENCY_DECIHZ[15], FX2_FREQUENCY_DECIHZ[115]]).toEqual([212, 80000, 500, 160000]);
    for (const raw of ["0", "1", "5"]) {
      expect((await parameter("fx-2", "rev-r3-hall", "hpf", "768", raw)).result, raw).toEqual({ value: "thru" });
    }
    expect((await parameter("fx-2", "rev-r3-hall", "hpf", "768", "6")).result).toEqual({ value: 21.2 });
    expect((await parameter("fx-2", "rev-r3-hall", "hpf", "768", "110")).result).toEqual({ code: "invalid_response" });
    expect((await parameter("fx-2", "rev-r3-hall", "lpf", "768", "122")).result).toEqual({ value: "thru" });
    expect((await parameter("fx-2", "rev-r3-hall", "lpf", "768", "20")).result).toEqual({ code: "invalid_response" });
    expect((await parameter("fx-2", "rev-r3-hall", "lpf", "768", "123")).result).toEqual({ code: "invalid_response" });
    expect((await parameter("fx-1", "ping-pong", "delay-time", "1025", "15")).result).toEqual({ value: 1.5 });
    expect((await parameter("fx-1", "ping-pong", "delay-time", "1025", "9")).result).toEqual({ code: "invalid_response" });
    const writes = [
      ["fx-2", "rev-r3-hall", "768", "hpf", "thru", "0", "thru"],
      ["fx-2", "rev-r3-hall", "768", "lpf", "thru", "122", "thru"],
      ["fx-1", "ping-pong", "1025", "delay-time", 1.5, "10", 1],
      ["fx-1", "mono-delay", "1024", "delay-time", 0.15, "1", 0.1],
      ["fx-1", "mono-delay", "1024", "feedback", -99, "-99", -99],
      ["fx-2", "rev-r3-room", "769", "er-reverb-balance", -63, "0", -63],
      ["fx-1", "rev-x-room", "1", "hpf", 21, "0", 20],
      ["fx-1", "rev-x-room", "1", "low-frequency", 22, "1", 22],
      ["fx-1", "mono-delay", "1024", "note", "double-whole", "14", "double-whole"],
      ["fx-1", "mono-delay", "1024", "sync", true, "1", true],
    ] as const;
    for (const [bus, effect, selector, name, value, raw, planned] of writes) {
      const transport = new FakeTransport().script("getNumeric", read(selector)).script("setNumeric", accepted);
      const result = await writeAny(new OperationContext(transport, "URX44"), "bus.fx.parameter", { bus, effect, parameter: name }, value);
      expect(result.planned, `${effect} ${name} ${String(value)}`).toBe(planned);
      expect(transport.calls.map((call) => call.method)).toEqual(["getNumeric", "setNumeric"]);
      expect(transport.calls[1]?.value, `${effect} ${name}`).toBe(raw);
    }
    for (const [effect, name, bad] of [
      ["rev-x-hall", "low-frequency", 21],
      ["rev-x-hall", "lpf", 999],
      ["rev-x-hall", "hpf", "thru"],
      ["ping-pong", "delay-time", 0.5],
      ["mono-delay", "delay-time", 2700.1],
      ["mono-delay", "note", "1/4T"],
      ["mono-delay", "hpf", "off"],
      ["mono-delay", "feedback", Infinity],
    ] as const) {
      const transport = new FakeTransport();
      expect((await failureOf(writeAny(new OperationContext(transport, "URX44"), "bus.fx.parameter", { bus: "fx-1", effect, parameter: name }, bad)))?.code, `${effect} ${name} ${String(bad)}`).toBe(
        "invalid_input",
      );
      expect(transport.calls).toEqual([]);
    }
  });

  it("decode and plan REV-X Reverb Time with a freshly read Room Size", async () => {
    expect(await parameter("fx-1", "rev-x-hall", "reverb-time", "0", "0", "69")).toEqual({
      result: { value: 10.3 },
      addresses: [at(679), at(681, 12), at(681, 7)],
    });
    expect((await parameter("fx-1", "rev-x-hall", "reverb-time", "0", "31", "69")).result).toEqual({ value: 31 });
    expect((await parameter("fx-1", "rev-x-hall", "reverb-time", "0", "0", "24")).result).toEqual({ value: 0.927 });
    expect(await parameter("fx-1", "rev-x-hall", "reverb-time", "0", "32")).toEqual({
      result: { code: "invalid_response" },
      addresses: [at(679), at(681, 12)],
    });
    expect((await parameter("fx-1", "rev-x-hall", "reverb-time", "0", "0", "70")).result).toEqual({ code: "invalid_response" });
    // Every context's table is distinct and increasing.
    for (const type of REVX_TIME_MS) {
      for (const stops of type) {
        expect(stops.length).toBe(70);
        expect(stops.every((v, i) => i === 0 || v > (stops[i - 1] as number))).toBe(true);
      }
    }
    const write = async (value: number, room: string) => {
      const transport = new FakeTransport().script("getNumeric", read("0"), read(room)).script("setNumeric", accepted);
      const outcome = await writeAny(new OperationContext(transport, "URX44"), "bus.fx.parameter", { bus: "fx-1", effect: "rev-x-hall", parameter: "reverb-time" }, value).then(
        (result) => ({ planned: result.planned }),
        (error: unknown) => ({ code: operationFailureOf(error)?.code }),
      );
      return { outcome, calls: transport.calls.map(({ method, address, value: sent }) => ({ method, address, sent })) };
    };
    expect(await write(0.927, "0")).toEqual({
      outcome: { planned: 0.927 },
      calls: [
        { method: "getNumeric", address: at(679), sent: undefined },
        { method: "getNumeric", address: at(681, 12), sent: undefined },
        { method: "setNumeric", address: at(681, 7), sent: "24" },
      ],
    });
    // Within the Hall envelope, but beyond Room Size 0's 10.3 s: refused after the reads, nothing sent.
    expect((await write(20, "0")).outcome).toEqual({ code: "invalid_input" });
    expect((await write(20, "0")).calls.map((call) => call.method)).toEqual(["getNumeric", "getNumeric"]);
    // Outside the Hall envelope: refused before any read.
    expect(await write(31.1, "0")).toEqual({ outcome: { code: "invalid_input" }, calls: [] });
  });

  it("dry-run reads the prerequisites and sends no write; a static preview refuses an FX parameter", async () => {
    const transport = new FakeTransport().script("getNumeric", read("0"), read("0"));
    const target = { bus: "fx-1", effect: "rev-x-hall", parameter: "reverb-time" };
    expect((await dryAny(new OperationContext(transport, "URX44"), "bus.fx.parameter", target, 0.93)).planned).toBe(0.927);
    expect(transport.calls.map((call) => call.method)).toEqual(["getNumeric", "getNumeric"]);
    expect(() => previewSetting("URX44", "bus.fx.parameter", target as never, 0.93)).toThrow(/invalid_input/);
    const plain = new FakeTransport();
    expect((await dryAny(new OperationContext(plain, "URX44"), "channel.fader", { channel: 1 }, -3)).planned).toBe(-3);
    expect(plain.calls).toEqual([]);
  });
});

/** Every valid raw of a value rule with the value it reads as. */
function rawsOf(rule: ValueRule): [string, unknown][] {
  switch (rule.kind) {
    case "switch":
      return [
        ["0", false],
        ["1", true],
      ];
    case "choice":
      return rule.choices.map((choice, index) => [`${index}`, choice]);
    case "grid": {
      const offset = rule.offset ?? 0;
      const out: [string, unknown][] = [];
      for (let raw = Math.round(rule.min * rule.scale); raw <= Math.round(rule.max * rule.scale); raw += 1) {
        out.push([`${raw + offset}`, raw / rule.scale]);
      }
      return out;
    }
    case "stops": {
      const ordinal = (rule as StopsRule).ordinal ?? 0;
      const finite: [string, unknown][] = rule.stops.map((stop, index) => [`${index + ordinal}`, stop / rule.scale]);
      return rule.sentinel === undefined ? finite : [...finite, [rule.sentinel.raw, rule.sentinel.value]];
    }
    default:
      return [];
  }
}
