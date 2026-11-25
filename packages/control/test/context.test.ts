import { describe, expect, it } from "vitest";
import { OperationContext } from "../src/operations/context.js";
import { OperationFailureError, operationFailureOf } from "../src/operations/failure.js";
import { FakeTransport } from "./fake-transport.js";

const address = { paramId: 7, x: "0", y: "-1" };

describe("operation context", () => {
  it("issues a unique ticket per request and adopts each validated result", async () => {
    const transport = new FakeTransport()
      .script("getNumeric", { kind: "success", value: "42", evidence: { state: "read" } })
      .script("setText", { kind: "success", value: null, evidence: { state: "accepted" } });
    const context = new OperationContext(transport, "URX44");
    expect(await context.getNumeric(address)).toEqual({ kind: "success", value: "42", evidence: { state: "read" } });
    expect(await context.setText(address, "Lead ")).toEqual({
      kind: "success",
      value: null,
      evidence: { state: "accepted" },
    });
    expect(transport.calls.map((call) => call.ticket)).toEqual(["t0", "t1"]);
    expect(transport.adopted).toEqual(["t0", "t1"]);
    expect(transport.calls[1]).toMatchObject({ method: "setText", value: "Lead " });
  });

  it("waits for the adoption before returning, and keeps evidence when it fails", async () => {
    const success = { kind: "success", value: null, evidence: { state: "accepted" } };
    const rejected = {
      kind: "failure",
      failure: { kind: "cause", code: "device_rejected", phase: "response" },
      evidence: { state: "rejected", responseCode: "409" },
    };
    const transport = new FakeTransport().script("setNumeric", success);
    const context = new OperationContext(transport, "URX44");
    await context.setNumeric(address, "1");
    expect(transport.adopted).toEqual(["t0"]);
    for (const completion of ["throw", "reject"] as const) {
      const failing = new FakeTransport().script("setNumeric", success, rejected);
      failing.completion = completion;
      const failingContext = new OperationContext(failing, "URX44");
      expect(await failingContext.setNumeric(address, "1")).toEqual({
        kind: "failure",
        failure: { kind: "cause", code: "internal_error", phase: "delivery" },
        evidence: { state: "accepted" },
      });
      expect(await failingContext.setNumeric(address, "1")).toEqual(rejected);
    }
  });

  it("turns a failed delivery report into the same internal_error", async () => {
    for (const completion of ["throw", "reject"] as const) {
      const transport = new FakeTransport().script("getText", { kind: "success", value: 1, evidence: { state: "read" } });
      transport.completion = completion;
      const error = await new OperationContext(transport, "URX44").getText(address).catch((caught: unknown) => caught);
      expect(operationFailureOf(error)).toEqual({ code: "internal_error", phase: "delivery", progress: null });
    }
  });

  it("takes tickets from the connection, so two operations never share one", async () => {
    const success = { kind: "success", value: "1", evidence: { state: "read" } };
    const transport = new FakeTransport().script("getNumeric", success, success);
    const first = new OperationContext(transport, "URX44");
    const second = new OperationContext(transport, "URX44");
    await first.getNumeric(address);
    await second.getNumeric(address);
    expect(transport.calls.map((call) => call.ticket)).toEqual(["t0", "t1"]);
  });

  it("turns an invalid record into internal_error without adopting its evidence", async () => {
    const transport = new FakeTransport().script("setNumeric", {
      kind: "failure",
      failure: { kind: "cancelled", phase: "response" },
      evidence: { state: "accepted" },
    });
    const context = new OperationContext(transport, "URX44");
    const error = await context.setNumeric(address, "1").catch((caught: unknown) => caught);
    expect(operationFailureOf(error)).toEqual({ code: "internal_error", phase: "delivery", progress: null });
    expect(transport.adopted).toEqual([]);
    expect(transport.undelivered).toEqual(["t0"]);
  });

  it("turns a rejected native promise into internal_error", async () => {
    const transport = new FakeTransport().script("getText", new Error("bridge failure"));
    const error = await new OperationContext(transport, "URX44").getText(address).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperationFailureError);
    expect(operationFailureOf(error)?.code).toBe("internal_error");
    expect((error as Error).message).not.toContain("bridge failure");
    expect(transport.adopted).toEqual([]);
    expect(transport.undelivered).toEqual(["t0"]);
  });

  it("reports a cancellation with the owner's stopping cause, or internal_error without one", async () => {
    const record = {
      kind: "failure",
      failure: { kind: "cancelled", phase: "admission" },
      evidence: { state: "not_sent" },
    } as const;
    const transport = new FakeTransport();
    const context = new OperationContext(transport, "URX44");
    expect(context.failureOf(record, null).failure.code).toBe("internal_error");
    context.cancel("input_closed");
    context.cancel("interrupted");
    expect(context.stopping).toBe("input_closed");
    expect(transport.cancelled).toBe(2);
    expect(context.failureOf(record, { steps: 1 }).failure).toEqual({
      code: "input_closed",
      phase: "admission",
      progress: { steps: 1 },
    });
    const rejected = {
      kind: "failure",
      failure: { kind: "cause", code: "device_rejected", phase: "response" },
      evidence: { state: "rejected", responseCode: "409" },
    } as const;
    expect(context.failureOf(rejected, null).failure.code).toBe("device_rejected");
    context.finish();
    expect(transport.finished).toBe(1);
  });
});
