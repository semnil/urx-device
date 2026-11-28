import { describe, expect, it } from "vitest";
import { firmwareStatus, validatedFirmware } from "../src/catalog/firmware.js";
import { MODELS, isModel } from "../src/catalog/models.js";
import { validateDeviceList, validateDiscovery, validateLifecycle } from "../src/operations/lifecycle.js";

describe("models", () => {
  it("are exactly the three target models, compared exactly", () => {
    expect(MODELS).toEqual(["URX22", "URX44", "URX44V"]);
    for (const model of MODELS) {
      expect(isModel(model)).toBe(true);
    }
    for (const model of ["urx44", "URX44 ", "URX44C", "URX", ""]) {
      expect(isModel(model), model).toBe(false);
    }
  });
});

describe("firmware facts (D15)", () => {
  it("have an entry per model and validate no version until evidence exists", () => {
    expect(Object.keys(validatedFirmware).sort()).toEqual([...MODELS].sort());
    for (const model of MODELS) {
      expect(firmwareStatus(model, "1.0.0")).toBe("unverified");
      expect(firmwareStatus(model, null)).toBe("unverified");
    }
  });
});

const device = (id: string, model = "URX44V", firmware: string | null = "1.2.3") => ({ id, model, firmware });
const plain = (id: string, model = "URX44V") => ({ id, model });
const failure = (f: unknown, cleanup: unknown) => ({ kind: "failure", failure: f, cleanup });
const complete = { state: "complete", failure: null };
const cause = (code: string, phase: string, request: string | null = null) => ({ kind: "cause", code, phase, request });

describe("discovery outcome (D14, K37)", () => {
  it("keeps a complete list as reported, for either metadata mode", () => {
    for (const metadata of [false, true]) {
      expect(validateDiscovery({ kind: "success", value: [] }, metadata)).toEqual({ kind: "success", value: [] });
    }
    const listed = [device("b"), device("a", "URX22", null), device("c", "UNKNOWN")];
    expect(validateDiscovery({ kind: "success", value: listed }, true)).toEqual({ kind: "success", value: listed });
    const selected = [plain("b"), plain("a", "UNKNOWN")];
    expect(validateDiscovery({ kind: "success", value: selected }, false)).toEqual({ kind: "success", value: selected });
  });

  it("rejects entries that do not fit the metadata mode", () => {
    expect(validateDeviceList([plain("a")], true)).toBeUndefined();
    expect(validateDeviceList([device("a")], false)).toBeUndefined();
    expect(validateDeviceList([device("a", "URX44", null)], false)).toBeUndefined();
    expect(validateDeviceList([device("a"), plain("b")], true)).toBeUndefined();
    expect(validateDeviceList([plain("a"), device("b")], false)).toBeUndefined();
  });

  it("rejects a list with an invalid entry or a repeated identity, as a whole", () => {
    for (const value of [
      [device("a"), device("a", "URX22")],
      [device("")],
      [device("a", "")],
      [device("a", "URX44", "")],
      [{ ...device("a"), port: 1 }],
      [{ id: 1, model: "URX44", firmware: null }],
      [{ id: "a", model: "URX44", firmware: 1 }],
      "a",
      { a: device("a") },
    ]) {
      expect(validateDeviceList(value, true), JSON.stringify(value)).toBeUndefined();
      expect(validateDiscovery({ kind: "success", value }, true)).toBeUndefined();
    }
    expect(validateDeviceList([plain("a"), plain("a")], false)).toBeUndefined();
  });

  it("accepts only failures a discovery has", () => {
    for (const code of [
      "connection_failed",
      "connection_lost",
      "send_timeout",
      "response_timeout",
      "invalid_response",
      "identity_error",
      "discovery_timeout",
      "internal_error",
    ]) {
      const record = failure(cause(code, "discovery"), complete);
      expect(validateDiscovery(record, true), code).toEqual(record);
    }
    expect(validateDiscovery(failure({ kind: "cancelled", phase: "discovery" }, complete), false)?.kind).toBe(
      "failure",
    );
    for (const record of [
      failure(cause("device_rejected", "subscription"), complete),
      failure(cause("connection_lost", "connect"), complete),
      failure(cause("connect_timeout", "connect"), complete),
      failure(cause("not_connected", "discovery"), complete),
      failure({ kind: "cancelled", phase: "teardown" }, complete),
      failure(cause("connection_lost", "discovery"), {
        state: "connection_closed",
        failure: cause("teardown_timeout", "teardown"),
      }),
      failure(cause("connection_lost", "discovery"), { state: "incomplete", failure: null }),
    ]) {
      expect(validateDiscovery(record, true), JSON.stringify(record)).toBeUndefined();
    }
  });
});

describe("lifecycle outcomes (K37)", () => {
  it("accept failures with their cause and cleanup", () => {
    const closed = { state: "connection_closed", failure: cause("device_rejected", "subscription") };
    expect(validateLifecycle(failure(cause("device_rejected", "subscription"), closed), () => null)?.kind).toBe("failure");
    for (const phase of ["connect", "identity"]) {
      expect(validateLifecycle(failure(cause("connect_timeout", phase), complete), () => null)?.kind).toBe("failure");
    }
    expect(validateLifecycle(failure(cause("teardown_timeout", "teardown"), complete), () => null)?.kind).toBe(
      "failure",
    );
    // A subscription call's failure names the phase of the request that failed, its cleanup's too.
    for (const request of ["validation", "admission", "send", "response", "delivery"]) {
      const lost = cause("connection_lost", "subscription", request);
      const record = failure(lost, { state: "connection_closed", failure: lost });
      expect(validateLifecycle(record, () => null), request).toEqual(record);
    }
  });

  it("reject inconsistent records, stage deadlines outside their phases included", () => {
    for (const record of [
      failure(cause("interrupted", "discovery"), complete),
      failure(cause("discovery_timeout", "response"), complete),
      failure(cause("discovery_timeout", "identity"), complete),
      failure(cause("connect_timeout", "discovery"), complete),
      failure(cause("connection_lost", "connect"), {
        state: "connection_closed",
        failure: cause("discovery_timeout", "identity"),
      }),
      failure(cause("discovery_timeout", "discovery"), { state: "done", failure: null }),
      failure(cause("device_rejected", "subscription"), {
        state: "complete",
        failure: cause("device_rejected", "subscription"),
      }),
      failure(cause("discovery_timeout", "discovery"), { state: "complete", failure: [] }),
      // A request phase outside a subscription call, one that is no phase, or none recorded at all.
      failure(cause("connection_lost", "teardown", "response"), complete),
      failure(cause("connection_lost", "connect", "send"), complete),
      failure(cause("connection_lost", "subscription", "reply"), complete),
      failure(cause("connection_lost", "subscription"), {
        state: "connection_closed",
        failure: cause("connection_lost", "teardown", "send"),
      }),
      failure({ kind: "cause", code: "connection_lost", phase: "subscription" }, complete),
      failure(cause("connection_lost", "subscription"), {
        state: "connection_closed",
        failure: { kind: "cause", code: "connection_lost", phase: "subscription" },
      }),
      { kind: "failure", failure: { kind: "cancelled", phase: "discovery" } },
      { kind: "success", value: [], cleanup: complete },
      { kind: "success" },
    ]) {
      expect(validateLifecycle(record, () => null), JSON.stringify(record)).toBeUndefined();
    }
  });
});
