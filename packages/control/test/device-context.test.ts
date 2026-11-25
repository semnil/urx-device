import { describe, expect, it } from "vitest";
import { firmwareStatus, validatedFirmware } from "../src/catalog/firmware.js";
import { MODELS, isModel } from "../src/catalog/models.js";
import { validateDeviceList, validateDiscovery } from "../src/operations/lifecycle.js";

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

describe("discovery outcome (D14, K37)", () => {
  it("keeps a complete list as reported, the empty one included", () => {
    expect(validateDiscovery({ kind: "success", value: [] })).toEqual({ kind: "success", value: [] });
    const value = [device("b"), device("a", "URX22", null), device("c", "UNKNOWN")];
    expect(validateDiscovery({ kind: "success", value })).toEqual({ kind: "success", value });
  });

  it("rejects a list with an invalid entry or a repeated identity, as a whole", () => {
    for (const value of [
      [device("a"), device("a", "URX22")],
      [device("")],
      [device("a", "")],
      [{ id: "a", model: "URX44" }],
      [{ ...device("a"), port: 1 }],
      [{ id: 1, model: "URX44", firmware: null }],
      [{ id: "a", model: "URX44", firmware: 1 }],
      "a",
      { a: device("a") },
    ]) {
      expect(validateDeviceList(value), JSON.stringify(value)).toBeUndefined();
      expect(validateDiscovery({ kind: "success", value })).toBeUndefined();
    }
  });

  it("accepts a failure with its cause and cleanup, and rejects inconsistent ones", () => {
    const failure = (f: unknown, cleanup: unknown) => ({ kind: "failure", failure: f, cleanup });
    const complete = { state: "complete", failure: null };
    expect(
      validateDiscovery(failure({ kind: "cause", code: "discovery_timeout", phase: "discovery" }, complete)),
    ).toEqual(failure({ kind: "cause", code: "discovery_timeout", phase: "discovery" }, complete));
    expect(validateDiscovery(failure({ kind: "cancelled", phase: "discovery" }, complete))?.kind).toBe("failure");
    const closed = {
      state: "connection_closed",
      failure: { kind: "cause", code: "device_rejected", phase: "subscription" },
    };
    expect(validateDiscovery(failure({ kind: "cause", code: "device_rejected", phase: "subscription" }, closed))?.kind).toBe(
      "failure",
    );
    for (const record of [
      failure({ kind: "cause", code: "interrupted", phase: "discovery" }, complete),
      failure({ kind: "cause", code: "discovery_timeout", phase: "response" }, complete),
      failure({ kind: "cause", code: "discovery_timeout", phase: "discovery" }, { state: "done", failure: null }),
      failure(
        { kind: "cause", code: "device_rejected", phase: "subscription" },
        { state: "complete", failure: { kind: "cause", code: "device_rejected", phase: "subscription" } },
      ),
      failure({ kind: "cause", code: "discovery_timeout", phase: "discovery" }, { state: "complete", failure: [] }),
      { kind: "failure", failure: { kind: "cancelled", phase: "discovery" } },
      { kind: "success", value: [], cleanup: complete },
      { kind: "success" },
    ]) {
      expect(validateDiscovery(record), JSON.stringify(record)).toBeUndefined();
    }
  });
});
