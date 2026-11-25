import { describe, expect, it } from "vitest";
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

describe("physical inputs (F02-B)", () => {
  it("address jack n at x 0, y n − 1 for every jack of every model", async () => {
    const jacks = { URX22: [1, 2], URX44: [1, 2, 3, 4], URX44V: [1, 2, 3, 4] };
    for (const [model, inputs] of Object.entries(jacks)) {
      for (const input of inputs) {
        const { transport, context: c } = context(model, "getNumeric", read("0"));
        await readSetting(c, "input.phantom", { input });
        expect(transport.calls).toEqual([
          { method: "getNumeric", address: { paramId: 0, x: "0", y: `${input - 1}` }, ticket: "t0" },
        ]);
      }
    }
  });

  it("reject jacks a model lacks and HI-Z on a jack without it, before any traffic", async () => {
    for (const [model, input] of [
      ["URX22", 3],
      ["URX44", 5],
      ["URX44", 0],
      ["URX44", 1.5],
    ] as const) {
      const { transport, context: c } = context(model);
      expect((await failureOf(readSetting(c, "input.gain", { input })))?.code).toBe("invalid_input");
      expect(transport.calls).toEqual([]);
    }
    for (const [model, input] of [
      ["URX22", 1],
      ["URX44", 1],
      ["URX44V", 2],
    ] as const) {
      const { transport, context: c } = context(model);
      expect((await failureOf(readSetting(c, "input.hi-z", { input })))?.code).toBe("unsupported_operation");
      expect((await failureOf(writeSetting(c, "input.hi-z", { input }, true)))?.code).toBe("unsupported_operation");
      expect(transport.calls).toEqual([]);
    }
    const { context: hiZ } = context("URX22", "getNumeric", read("1"));
    expect((await readSetting(hiZ, "input.hi-z", { input: 2 })).value).toBe(true);
    const { context: other } = context("URX44C");
    expect((await failureOf(readSetting(other, "input.gain", { input: 1 })))?.code).toBe("unsupported_operation");
  });

  it("plan gain in whole dB with lower ties, and refuse values outside −8…+70 before rounding", () => {
    const plan = (value: number) => previewSetting("URX44", "input.gain", { input: 1 }, value).planned;
    expect(plan(-8)).toBe(-8);
    expect(plan(70)).toBe(70);
    expect(plan(10.5)).toBe(10);
    expect(plan(-7.5)).toBe(-8);
    expect(plan(10.6)).toBe(11);
    expect(plan(-0.4)).toBe(0);
    expect(Object.is(plan(-0.4), -0)).toBe(false);
    for (const value of [-8.1, 70.1, Number.NaN, Infinity, -Infinity]) {
      expect(() => plan(value)).toThrow();
    }
    expect(previewSetting("URX44", "input.gain", { input: 1 }, 10.5)).toEqual({ requested: 10.5, planned: 10 });
  });

  it("write the planned centi-dB once, with no read", async () => {
    const { transport, context: c } = context("URX44V", "setNumeric", accepted);
    expect(await writeSetting(c, "input.gain", { input: 3 }, -0.5)).toEqual({
      requested: -0.5,
      planned: -1,
      outcome: "accepted",
    });
    expect(transport.calls).toEqual([
      { method: "setNumeric", address: { paramId: 1, x: "0", y: "2" }, value: "-100", ticket: "t0" },
    ]);
  });

  it("decode reads exactly, and refuse raw values outside the definition", async () => {
    const { context: c } = context("URX44", "getNumeric", read("1050"), read("-801"), read("7001"));
    expect(await readSetting(c, "input.gain", { input: 1 })).toEqual({
      value: 10.5,
      observedAt: "2026-11-20T00:00:00.000Z",
    });
    for (let i = 0; i < 2; i += 1) {
      expect(await failureOf(readSetting(c, "input.gain", { input: 1 }))).toEqual({
        code: "invalid_response",
        phase: "response",
        progress: null,
      });
    }
    const { context: s } = context("URX44", "getNumeric", read("0"), read("1"), read("2"), read("-1"));
    expect((await readSetting(s, "input.clip-safe", { input: 1 })).value).toBe(false);
    expect((await readSetting(s, "input.clip-safe-active", { input: 1 })).value).toBe(true);
    expect((await failureOf(readSetting(s, "input.phantom", { input: 1 })))?.code).toBe("invalid_response");
    expect((await failureOf(readSetting(s, "input.phantom", { input: 1 })))?.code).toBe("invalid_response");
  });

  it("report a failed write with its outcome", async () => {
    const failure = (code: string, phase: string, evidence: unknown) => ({
      kind: "failure",
      failure: { kind: "cause", code, phase },
      evidence,
    });
    const { context: c } = context(
      "URX44",
      "setNumeric",
      failure("device_rejected", "response", { state: "rejected", responseCode: "409" }),
      failure("response_timeout", "response", { state: "unconfirmed" }),
      failure("send_timeout", "admission", { state: "not_sent" }),
      failure("notification_overflow", "delivery", { state: "accepted" }),
    );
    const plan = { requested: true, planned: true };
    expect(await failureOf(writeSetting(c, "input.phantom", { input: 1 }, true))).toEqual({
      code: "device_rejected",
      phase: "response",
      progress: { ...plan, outcome: "rejected", responseCode: "409" },
    });
    expect((await failureOf(writeSetting(c, "input.phantom", { input: 1 }, true)))?.progress).toEqual({
      ...plan,
      outcome: "uncertain",
    });
    expect((await failureOf(writeSetting(c, "input.phantom", { input: 1 }, true)))?.progress).toEqual({
      ...plan,
      outcome: "not_sent",
    });
    expect(await failureOf(writeSetting(c, "input.phantom", { input: 1 }, true))).toEqual({
      code: "notification_overflow",
      phase: "delivery",
      progress: { ...plan, outcome: "accepted" },
    });
  });

  it("keep the Clip Safe activity read-only", async () => {
    const { transport, context: c } = context("URX44");
    const error = await failureOf(writeSetting(c, "input.clip-safe-active" as never, { input: 1 } as never, true as never));
    expect(error?.code).toBe("invalid_input");
    expect(transport.calls).toEqual([]);
  });

  it("refuse a non-boolean switch value before traffic", async () => {
    const { transport, context: c } = context("URX44");
    expect((await failureOf(writeSetting(c, "input.phantom", { input: 1 }, 1 as never)))?.code).toBe("invalid_input");
    expect(transport.calls).toEqual([]);
  });
});

describe("source gain (F03-G)", () => {
  it("reads the first catalog instance of a source", async () => {
    const { transport, context: c } = context("URX22", "getNumeric", read("-2400"), read("600"));
    expect((await readSetting(c, "source.gain", { source: "aux" })).value).toBe(-24);
    expect((await readSetting(c, "source.gain", { source: "usb-main-b" })).value).toBe(6);
    expect(transport.calls.map((call) => call.address)).toEqual([
      { paramId: 9, x: "0", y: "0" },
      { paramId: 14, x: "0", y: "0" },
    ]);
  });

  it("refuses unknown tokens and sources the model lacks, before traffic", async () => {
    for (const [model, source, code] of [
      ["URX44", "AUX", "invalid_input"],
      ["URX44", "usb-daw-1", "invalid_input"],
      ["URX44", "hdmi", "unsupported_operation"],
      ["URX22", "usb-daw-11-12", "unsupported_operation"],
      ["URX22", "sd-playback", "unsupported_operation"],
    ] as const) {
      const { transport, context: c } = context(model);
      expect((await failureOf(readSetting(c, "source.gain", { source } as never)))?.code, source).toBe(code);
      expect(transport.calls).toEqual([]);
    }
  });

  it("writes a USB DAW pair once at its representative instance", async () => {
    const { transport, context: c } = context("URX44V", "setNumeric", accepted);
    expect(await writeSetting(c, "source.gain", { source: "usb-daw-11-12" }, 24)).toEqual({
      requested: 24,
      planned: 24,
      outcome: "accepted",
    });
    expect(transport.calls).toEqual([
      { method: "setNumeric", address: { paramId: 12, x: "0", y: "10" }, value: "2400", ticket: "t0" },
    ]);
  });

  it("does not write a source whose write sequence needs evidence", async () => {
    for (const source of ["aux", "sd-playback", "usb-main-a", "usb-main-b", "usb-main-c", "usb-sub", "hdmi"] as const) {
      const { transport, context: c } = context("URX44V");
      expect((await failureOf(writeSetting(c, "source.gain", { source }, 0)))?.code, source).toBe(
        "unsupported_operation",
      );
      expect(transport.calls).toEqual([]);
    }
  });

  it("refuses values outside −24…+24 before rounding", () => {
    const plan = (value: number) => previewSetting("URX44", "source.gain", { source: "usb-daw-1-2" }, value).planned;
    expect(plan(-24)).toBe(-24);
    expect(plan(23.5)).toBe(23);
    expect(() => plan(24.1)).toThrow();
    expect(() => plan(-24.5)).toThrow();
  });
});

describe("review round 1 fixes", () => {
  it("rounds a value just above −0.5 dB to 0 and keeps the midpoint rule", () => {
    const plan = (value: number) => previewSetting("URX44", "input.gain", { input: 1 }, value).planned;
    expect(plan(-0.49999999999999994)).toBe(0);
    expect(plan(-0.5)).toBe(-1);
    expect(plan(0.5)).toBe(0);
    expect(plan(0.5000000000000001)).toBe(1);
    expect(plan(69.5)).toBe(69);
  });

  it("keeps the plan when a write has no trusted record", async () => {
    const plan = { requested: 3, planned: 3 };
    const rejected = new FakeTransport().script("setNumeric", new Error("bridge"));
    const c = new OperationContext(rejected, "URX44", () => at);
    expect(await failureOf(writeSetting(c, "input.gain", { input: 1 }, 3))).toEqual({
      code: "internal_error",
      phase: "delivery",
      progress: { ...plan, outcome: "uncertain" },
    });
    const malformed = new FakeTransport().script("setNumeric", { kind: "success", value: 1, evidence: { state: "accepted" } });
    const m = new OperationContext(malformed, "URX44", () => at);
    expect((await failureOf(writeSetting(m, "input.gain", { input: 1 }, 3)))?.progress).toEqual({
      ...plan,
      outcome: "uncertain",
    });
    const noTicket = new FakeTransport();
    noTicket.newRequestTicket = () => {
      throw new Error("no ticket");
    };
    const n = new OperationContext(noTicket, "URX44", () => at);
    expect(await failureOf(writeSetting(n, "input.gain", { input: 1 }, 3))).toEqual({
      code: "internal_error",
      phase: "admission",
      progress: { ...plan, outcome: "not_sent" },
    });
    expect(noTicket.calls).toEqual([]);
  });

  it("stamps a read with its receipt time, not the end of a slow adoption", async () => {
    let now = Date.parse("2026-11-20T00:00:00.000Z");
    const transport = new FakeTransport().script("getNumeric", read("100"));
    const adopt = transport.adoptResult.bind(transport);
    transport.adoptResult = async (ticket: string) => {
      now += 2500;
      await adopt(ticket);
    };
    const c = new OperationContext(transport, "URX44", () => new Date(now));
    expect((await readSetting(c, "input.gain", { input: 1 })).observedAt).toBe("2026-11-20T00:00:00.000Z");
  });

  it("does not let a failing clock change a write result, a read's slot or later requests", async () => {
    for (const clock of [() => new Date(Number.NaN), (): Date => { throw new Error("clock"); }]) {
      const rejected = {
        kind: "failure",
        failure: { kind: "cause", code: "device_rejected", phase: "response" },
        evidence: { state: "rejected", responseCode: "409" },
      };
      const transport = new FakeTransport()
        .script("setNumeric", accepted, rejected)
        .script("getNumeric", read("100"), read("200"));
      const c = new OperationContext(transport, "URX44", clock);
      expect((await writeSetting(c, "input.gain", { input: 1 }, 1)).outcome).toBe("accepted");
      expect((await failureOf(writeSetting(c, "input.gain", { input: 1 }, 1)))?.progress).toMatchObject({
        outcome: "rejected",
        responseCode: "409",
      });
      expect(await failureOf(readSetting(c, "input.gain", { input: 1 }))).toEqual({
        code: "internal_error",
        phase: "delivery",
        progress: null,
      });
      expect(transport.adopted).toEqual(["t0", "t1", "t2"]);
      expect((await failureOf(readSetting(c, "input.gain", { input: 1 })))?.code).toBe("internal_error");
      expect(transport.calls).toHaveLength(4);
    }
  });
});
