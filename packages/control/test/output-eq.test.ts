import { describe, expect, it } from "vitest";
import { GEQ_BANDS, OUTPUT_EQ_RULES } from "../src/catalog/output-eq.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { dryRunSetting, dryRunSettingAfter, readSetting, validateSetting, writeSetting, type ReadArgs, type WriteArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const readAny = (c: OperationContext, id: string, target: unknown) => readSetting(c, ...([id, target] as unknown as ReadArgs));
const writeAny = (c: OperationContext, id: string, target: unknown, value: unknown) =>
  writeSetting(c, ...([id, target, value] as unknown as WriteArgs));
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}
const at = (paramId: number, y: number, x = 0) => ({ paramId, x: `${x}`, y: `${y}` });
const BUS = {
  stereo: { type: 497, on: 498, geqOn: 543, link: 544, limit: 893, rep: 0, left: 0, right: 1 },
  "mix-1": { type: 590, on: 591, geqOn: 636, link: 637, limit: 894, rep: 0, left: 0, right: 1 },
  "mix-2": { type: 590, on: 591, geqOn: 636, link: 637, limit: 894, rep: 2, left: 2, right: 3 },
} as const;

/** A gain write through replies to the type and limit reads; its result and requests. */
async function gainWrite(bus: keyof typeof BUS, side: "left" | "right", band: string, value: unknown, type: string, limit?: string) {
  const transport = new FakeTransport().script("getNumeric", read(type), ...(limit === undefined ? [] : [read(limit)])).script("setNumeric", accepted);
  const outcome = await writeAny(new OperationContext(transport, "URX44"), "bus.geq.gain", { bus, side, band }, value).then(
    (result) => ({ planned: result.planned }),
    (error: unknown) => ({ code: operationFailureOf(error)?.code }),
  );
  return { outcome, calls: transport.calls.map(({ method, address, value: sent }) => ({ method, address, sent })) };
}

describe("output EQ switches and Flex12GEQ (F07-G)", () => {
  it("read type, EQ on and Link at the representative instance; GEQ on and Limit at each side", async () => {
    for (const [bus, ids] of Object.entries(BUS)) {
      for (const [id, paramId, raw, value] of [
        ["bus.eq.type", ids.type, "2", "flex12-geq"],
        ["bus.eq.on", ids.on, "1", true],
        ["bus.geq.link", ids.link, "2", "right-to-left"],
      ] as const) {
        const transport = new FakeTransport().script("getNumeric", read(raw));
        expect((await readAny(new OperationContext(transport, "URX44"), id, { bus })).value, `${bus} ${id}`).toBe(value);
        expect(transport.calls[0]?.address).toEqual(at(paramId, ids.rep));
      }
      for (const side of ["left", "right"] as const) {
        for (const [id, paramId, raw, value, write, wire] of [
          ["bus.geq.on", ids.geqOn, "0", false, true, "1"],
          ["bus.geq.limit", ids.limit, "3", "minus-24-to-0", "plus-minus-6", "2"],
        ] as const) {
          const transport = new FakeTransport().script("getNumeric", read(raw), read("2")).script("setNumeric", accepted);
          const c = new OperationContext(transport, "URX44");
          expect((await readAny(c, id, { bus, side })).value, `${bus} ${side} ${id}`).toBe(value);
          await writeAny(c, id, { bus, side }, write);
          // The write reads the representative EQ Type first (F07-G), then sends once.
          expect(transport.calls.map(({ address, value: sent }) => ({ address, sent }))).toEqual([
            { address: at(paramId, ids[side]), sent: undefined },
            { address: at(ids.type, ids.rep), sent: undefined },
            { address: at(paramId, ids[side]), sent: wire },
          ]);
        }
      }
      const link = new FakeTransport().script("getNumeric", read("2")).script("setNumeric", accepted);
      await writeAny(new OperationContext(link, "URX44"), "bus.geq.link", { bus }, "left-to-right");
      expect(link.calls.map(({ address, value }) => ({ address, value }))).toEqual([
        { address: at(ids.type, ids.rep), value: undefined },
        { address: at(ids.link, ids.rep), value: "1" },
      ]);
    }
    // EQ Type and EQ On writes await F03-G evidence: known read-only settings.
    for (const id of ["bus.eq.type", "bus.eq.on"]) {
      expect((await failureOf(writeAny(new OperationContext(new FakeTransport(), "URX44"), id, { bus: "stereo" }, id.endsWith("type") ? "peq" : true)))?.code).toBe(
        "unsupported_operation",
      );
    }
    for (const raw of ["1", "3"]) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), "bus.eq.type", { bus: "stereo" })))?.code, raw).toBe("invalid_response");
    }
  });

  it("write or dry-run GEQ On, Link and Limit only while the bus's EQ Type is Flex12GEQ", async () => {
    for (const model of ["URX22", "URX44", "URX44V"] as const) {
      for (const [bus, ids] of Object.entries(BUS)) {
        for (const [id, target, value] of [
          ["bus.geq.on", { bus, side: "right" }, true],
          ["bus.geq.link", { bus }, "off"],
          ["bus.geq.limit", { bus, side: "left" }, "plus-minus-12"],
        ] as const) {
          const label = `${model} ${bus} ${id}`;
          for (const [type, code] of [
            ["0", "precondition_failed"],
            ["1", "invalid_response"],
          ] as const) {
            const transport = new FakeTransport().script("getNumeric", read(type));
            expect((await failureOf(writeAny(new OperationContext(transport, model), id, target, value)))?.code, `${label} ${type}`).toBe(code);
            expect(transport.calls.map(({ method, address }) => [method, address]), label).toEqual([["getNumeric", at(ids.type, ids.rep)]]);
          }
          const dry = new FakeTransport().script("getNumeric", read("2"));
          expect((await dryRunSetting(new OperationContext(dry, model), ...([id, target, value] as unknown as WriteArgs))).planned, label).toBe(value);
          expect(dry.calls.map(({ method }) => method), label).toEqual(["getNumeric"]);
          // No connection-free plan (the type is live); the static checks still run.
          expect(() => validateSetting(model, ...([id, target, value] as unknown as WriteArgs)), label).not.toThrow();
          expect(() => validateSetting(model, ...([id, target, "bogus"] as unknown as WriteArgs)), label).toThrow(/invalid_input/);
          // A refused target or value sends nothing, the type read included.
          const none = new FakeTransport();
          expect((await failureOf(writeAny(new OperationContext(none, model), id, target, "bogus")))?.code, label).toBe("invalid_input");
          expect(none.calls, label).toEqual([]);
        }
      }
    }
  });

  it("write the bus and side whose EQ Type was read, even when the caller's target changes meanwhile", async () => {
    for (const [id, value] of [
      ["bus.geq.on", true],
      ["bus.geq.link", "off"],
      ["bus.geq.limit", "plus-minus-12"],
    ] as const) {
      for (const run of ["write", "dry-run"] as const) {
        const target: { bus: string; side?: string } = id === "bus.geq.link" ? { bus: "mix-1" } : { bus: "mix-1", side: "left" };
        // The EQ Type answer arrives only after the caller has moved its object to MIX 2, right.
        const moved = {
          then(resolve: (record: unknown) => void) {
            target.bus = "mix-2";
            if (target.side !== undefined) target.side = "right";
            resolve(read("2"));
          },
        };
        const transport = new FakeTransport().script("getNumeric", moved).script("setNumeric", accepted);
        const c = new OperationContext(transport, "URX44");
        const args = [id, target, value] as unknown as WriteArgs;
        if (run === "write") {
          await writeSetting(c, ...args);
        } else {
          await dryRunSetting(c, ...args);
        }
        const field = id === "bus.geq.on" ? 636 : id === "bus.geq.link" ? 637 : 894;
        // MIX 1's type (590, y 0), then for a write MIX 1's left field (y 0): never MIX 2's (y 2 / 3).
        const expected = [at(590, 0), ...(run === "write" ? [at(field, 0)] : [])];
        expect(transport.calls.map(({ address }) => address), `${id} ${run}`).toEqual(expected);
      }
    }
  });

  it("refuse a GEQ write's extra target key before any request, __proto__ included", async () => {
    for (const [id, base, value] of [
      ["bus.geq.on", '{"bus":"mix-1","side":"left"', true],
      ["bus.geq.link", '{"bus":"mix-1"', "off"],
      ["bus.geq.limit", '{"bus":"mix-1","side":"left"', "plus-minus-12"],
    ] as const) {
      for (const extra of ['"__proto__":"x"', '"__proto__":1', '"__proto__":true', '"band":"20"']) {
        const target: unknown = JSON.parse(`${base},${extra}}`);
        for (const run of ["write", "dry-run"] as const) {
          const none = new FakeTransport();
          const c = new OperationContext(none, "URX44");
          const args = [id, target, value] as unknown as WriteArgs;
          const result = run === "write" ? writeSetting(c, ...args) : dryRunSetting(c, ...args);
          expect((await failureOf(result))?.code, `${id} ${extra} ${run}`).toBe("invalid_input");
          expect(none.calls, `${id} ${extra} ${run}`).toEqual([]);
        }
      }
    }
  });

  it("read every band's gain at its address, keeping off-grid values", async () => {
    for (const [bus, ids] of Object.entries(BUS)) {
      for (const side of ["left", "right"] as const) {
        for (const [index, band] of GEQ_BANDS.entries()) {
          const transport = new FakeTransport().script("getNumeric", read("-1234"));
          transport.timers = false;
          expect((await readAny(new OperationContext(transport, "URX44"), "bus.geq.gain", { bus, side, band })).value).toBe(-12.34);
          const expected = bus === "stereo" ? at(545, ids[side], index) : at(638 + index, ids[side]);
          expect(transport.calls.map((call) => call.address), `${bus} ${side} ${band}`).toEqual([expected]);
        }
      }
    }
    for (const raw of ["-2401", "1501"]) {
      const transport = new FakeTransport().script("getNumeric", read(raw));
      expect((await failureOf(readAny(new OperationContext(transport, "URX44"), "bus.geq.gain", { bus: "mix-1", side: "left", band: "1000" })))?.code).toBe(
        "invalid_response",
      );
    }
  });

  it("write a gain after the EQ Type and side Limit reads, within the current range", async () => {
    expect(await gainWrite("mix-2", "right", "1000", -6.25, "2", "0")).toEqual({
      outcome: { planned: -6.5 },
      calls: [
        { method: "getNumeric", address: at(590, 2), sent: undefined },
        { method: "getNumeric", address: at(894, 3), sent: undefined },
        { method: "setNumeric", address: at(638 + 17, 3), sent: "-650" },
      ],
    });
    expect((await gainWrite("mix-1", "left", "20", 0.25, "2", "1")).outcome).toEqual({ planned: 0 });
    expect((await gainWrite("mix-1", "left", "20", 0.26, "2", "1")).outcome).toEqual({ planned: 0.5 });
    expect((await gainWrite("stereo", "right", "20", 3, "2", "2")).calls[2]).toEqual({ method: "setNumeric", address: at(545, 1, 0), sent: "300" });
    // Outside the current Limit: refused after the reads, nothing sent.
    const narrow = await gainWrite("mix-1", "left", "20", 7, "2", "2");
    expect(narrow.outcome).toEqual({ code: "invalid_input" });
    expect(narrow.calls.map((call) => call.method)).toEqual(["getNumeric", "getNumeric"]);
    expect((await gainWrite("mix-1", "left", "20", 1, "2", "3")).outcome).toEqual({ code: "invalid_input" });
    // PEQ selected: a failed precondition before the Limit read.
    const peq = await gainWrite("mix-1", "left", "20", 1, "0");
    expect(peq.outcome).toEqual({ code: "precondition_failed" });
    expect(peq.calls.length).toBe(1);
    for (const type of ["1", "3", "-1"]) {
      expect((await gainWrite("mix-1", "left", "20", 1, type)).outcome, type).toEqual({ code: "invalid_response" });
    }
    expect((await gainWrite("mix-1", "left", "20", 1, "2", "4")).outcome).toEqual({ code: "invalid_response" });
    // Static: outside −24…15, STEREO bands above 20 Hz, unknown bands and sides.
    for (const [bus, side, band, value, code] of [
      ["mix-1", "left", "20", 15.5, "invalid_input"],
      ["mix-1", "left", "20", -24.5, "invalid_input"],
      ["stereo", "left", "25", 0, "unsupported_operation"],
      ["mix-1", "left", "1k", 0, "invalid_input"],
      ["mix-1", "left", "1000.0", 0, "invalid_input"],
      ["mix-1", "both", "20", 0, "invalid_input"],
      ["fx-1", "left", "20", 0, "unsupported_operation"],
    ] as const) {
      const result = await gainWrite(bus as keyof typeof BUS, side as "left", band, value, "2", "0");
      expect(result.outcome, `${bus} ${side} ${band} ${value}`).toEqual({ code });
      expect(result.calls).toEqual([]);
    }
  });

  it("carry F07-G's rate limit for help: Flex12GEQ to 48 kHz, PEQ without a ceiling", () => {
    const value = OUTPUT_EQ_RULES["bus.eq.type"].value;
    expect(value.kind).toBe("selector");
    if (value.kind !== "selector") return;
    expect(value.limits).toEqual({
      peq: { maxRateHz: null, monoOnly: false, slot: null },
      "flex12-geq": { maxRateHz: 48000, monoOnly: false, slot: null },
    });
    for (const token of [...Object.getOwnPropertyNames(Object.prototype), "geq", "none"]) {
      expect(value.limits?.[token], token).toBeUndefined();
    }
  });

  it("validate a gain write without a device against every Limit's range together", () => {
    const target = { bus: "mix-1", side: "left", band: "1000" } as const;
    for (const value of [-24, -0.5, 0, 15]) {
      expect(() => validateSetting("URX44", "bus.geq.gain", target, value), `${value}`).not.toThrow();
    }
    for (const value of [-24.5, 15.5, Number.NaN, "3"]) {
      expect(() => validateSetting("URX44", "bus.geq.gain", target, value as never), `${value}`).toThrow(/invalid_input/);
    }
    // STEREO writes the 20 Hz band only; an unknown band is invalid.
    expect(() => validateSetting("URX44", "bus.geq.gain", { bus: "stereo", side: "left", band: "20" }, 3)).not.toThrow();
    expect(() => validateSetting("URX44", "bus.geq.gain", { bus: "stereo", side: "left", band: "25" }, 3)).toThrow(/unsupported_operation/);
    expect(() => validateSetting("URX44", "bus.geq.gain", { bus: "mix-1", side: "left", band: "21" } as never, 3)).toThrow(/invalid_input/);
  });

  it("dry-run a gain with the two reads and no write", async () => {
    const transport = new FakeTransport().script("getNumeric", read("2"), read("0"));
    const plan = await dryRunSetting(new OperationContext(transport, "URX44"), "bus.geq.gain", { bus: "mix-1", side: "left", band: "20" }, 2.75);
    expect(plan).toEqual({ requested: 2.75, planned: 2.5, unverified: [] });
    expect(transport.calls.map((call) => call.method)).toEqual(["getNumeric", "getNumeric"]);
  });

  it("leave the GEQ conditions an unsent write can change unverified, still reading and checking them (O13)", async () => {
    const target = { bus: "mix-1", side: "left", band: "20" } as const;
    // The type is PEQ now, but an earlier unsent write can change it: unverified, and the Limit still plans the gain.
    const typed = new FakeTransport().script("getNumeric", read("0"), read("0"));
    expect(await dryRunSettingAfter(new OperationContext(typed, "URX44"), new Set(["geq_type_selected"]), "bus.geq.gain", target, 2.75)).toEqual({
      requested: 2.75,
      planned: 2.5,
      unverified: ["geq_type_selected"],
    });
    // An affected Limit leaves the gain unplanned; the Limit is still read and checked.
    const limited = new FakeTransport().script("getNumeric", read("2"), read("3"));
    expect(await dryRunSettingAfter(new OperationContext(limited, "URX44"), new Set(["geq_limit_allows_gain"]), "bus.geq.gain", target, 9)).toEqual({
      requested: 9,
      planned: null,
      unverified: ["geq_limit_allows_gain"],
    });
    const badLimit = new FakeTransport().script("getNumeric", read("2"), read("7"));
    expect((await failureOf(dryRunSettingAfter(new OperationContext(badLimit, "URX44"), new Set(["geq_limit_allows_gain"]), "bus.geq.gain", target, 9)))?.code).toBe(
      "invalid_response",
    );
    // On, Link and Limit: an affected type is unverified; an invalid one is still an error; unaffected PEQ refuses.
    for (const [id, t, value] of [
      ["bus.geq.on", { bus: "mix-1", side: "left" }, true],
      ["bus.geq.link", { bus: "mix-1" }, "off"],
      ["bus.geq.limit", { bus: "mix-1", side: "left" }, "plus-minus-6"],
    ] as const) {
      const args = [id, t, value] as unknown as WriteArgs;
      const peq = new FakeTransport().script("getNumeric", read("0"));
      expect(await dryRunSettingAfter(new OperationContext(peq, "URX44"), new Set(["geq_type_selected"]), ...args), id).toEqual({
        requested: value,
        planned: value,
        unverified: ["geq_type_selected"],
      });
      const invalid = new FakeTransport().script("getNumeric", read("1"));
      expect((await failureOf(dryRunSettingAfter(new OperationContext(invalid, "URX44"), new Set(["geq_type_selected"]), ...args)))?.code, id).toBe("invalid_response");
      const refused = new FakeTransport().script("getNumeric", read("0"));
      expect((await failureOf(dryRunSetting(new OperationContext(refused, "URX44"), ...args)))?.code, id).toBe("precondition_failed");
      expect([...peq.calls, ...invalid.calls, ...refused.calls].filter((c) => c.method.startsWith("set"))).toEqual([]);
    }
  });
});
