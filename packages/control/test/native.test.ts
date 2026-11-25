import { describe, expect, it } from "vitest";
import {
  validateNameRead,
  validateNumericRead,
  validatePost,
  validateTextRead,
} from "../src/operations/native.js";

const read = { state: "read" };
const accepted = { state: "accepted" };
const notSent = { state: "not_sent" };
const unconfirmed = { state: "unconfirmed" };
const rejected = (responseCode: string) => ({ state: "rejected", responseCode });
const cause = (code: string, phase: string) => ({ kind: "cause", code, phase });
const cancelled = (phase: string) => ({ kind: "cancelled", phase });
const failure = (f: unknown, evidence: unknown) => ({ kind: "failure", failure: f, evidence });

describe("read records (K34)", () => {
  it("keep exact i64 text beyond the JS safe-integer range", () => {
    const record = { kind: "success", value: "9223372036854775807", evidence: read };
    expect(validateNumericRead(record)).toEqual(record);
  });

  it("keep text and name variants as received", () => {
    expect(validateTextRead({ kind: "success", value: "123", evidence: read })).toEqual({
      kind: "success",
      value: "123",
      evidence: read,
    });
    expect(validateTextRead({ kind: "success", value: "", evidence: read })?.kind).toBe("success");
    expect(validateNameRead({ kind: "success", value: { kind: "integer", value: "123" }, evidence: read })).toEqual({
      kind: "success",
      value: { kind: "integer", value: "123" },
      evidence: read,
    });
    expect(validateNameRead({ kind: "success", value: { kind: "text", value: "Lead " }, evidence: read })?.kind).toBe(
      "success",
    );
  });

  it("reject a value of the wrong type", () => {
    expect(validateNumericRead({ kind: "success", value: 5, evidence: read })).toBeUndefined();
    expect(validateNumericRead({ kind: "success", value: "05", evidence: read })).toBeUndefined();
    expect(validateTextRead({ kind: "success", value: 5, evidence: read })).toBeUndefined();
    expect(validateNameRead({ kind: "success", value: "x", evidence: read })).toBeUndefined();
    expect(validateNameRead({ kind: "success", value: { kind: "integer", value: 3 }, evidence: read })).toBeUndefined();
  });

  it("reject read success without read evidence, and accepted evidence on a read", () => {
    expect(validateNumericRead({ kind: "success", value: "1", evidence: notSent })).toBeUndefined();
    expect(validateNumericRead({ kind: "success", value: "1", evidence: accepted })).toBeUndefined();
    expect(validateNumericRead(failure(cause("connection_lost", "delivery"), accepted))).toBeUndefined();
  });
});

describe("failure records (K34)", () => {
  it("accept the listed cases", () => {
    const cases: [unknown, unknown][] = [
      [cause("invalid_input", "validation"), notSent],
      [cause("precondition_failed", "admission"), notSent],
      [cancelled("admission"), notSent],
      [cause("send_timeout", "send"), unconfirmed],
      [cause("invalid_response", "response"), unconfirmed],
      [cause("device_rejected", "response"), rejected("500")],
      [cause("notification_overflow", "delivery"), accepted],
      [cause("teardown_timeout", "delivery"), accepted],
    ];
    for (const [f, evidence] of cases) {
      expect(validatePost(failure(f, evidence)), JSON.stringify([f, evidence])).toEqual(failure(f, evidence));
    }
    expect(validateNumericRead(failure(cause("connection_lost", "delivery"), read))?.kind).toBe("failure");
  });

  it("reject contradictory combinations", () => {
    const cases: [unknown, unknown][] = [
      [cancelled("response"), accepted],
      [cancelled("response"), rejected("409")],
      [cause("device_rejected", "response"), unconfirmed],
      [cause("device_rejected", "delivery"), rejected("409")],
      [cause("response_timeout", "response"), rejected("409")],
      [cause("device_rejected", "response"), rejected("200")],
      [cause("device_rejected", "response"), rejected("0409")],
      [cause("not_connected", "delivery"), accepted],
      [cause("device_rejected", "delivery"), accepted],
      [cause("notification_overflow", "response"), accepted],
    ];
    for (const [f, evidence] of cases) {
      expect(validatePost(failure(f, evidence)), JSON.stringify([f, evidence])).toBeUndefined();
    }
  });

  it("reject unknown tags, missing fields and extra fields", () => {
    const records: unknown[] = [
      null,
      "success",
      [],
      { kind: "success", value: null },
      { kind: "success", value: null, evidence: accepted, extra: 1 },
      { kind: "done", value: null, evidence: accepted },
      failure(cause("unknown_cause", "response"), unconfirmed),
      failure(cause("internal_error", "later"), unconfirmed),
      failure({ kind: "cause", code: "internal_error" }, unconfirmed),
      failure({ kind: "cancelled", phase: "admission", code: "interrupted" }, notSent),
      failure(cause("internal_error", "response"), { state: "unconfirmed", responseCode: "500" }),
      failure(cause("internal_error", "response"), { state: "sent" }),
      { kind: "success", value: 1, evidence: accepted },
      Object.assign(Object.create({ inherited: true }), { kind: "success", value: null, evidence: accepted }),
    ];
    for (const record of records) {
      expect(validatePost(record), JSON.stringify(record)).toBeUndefined();
    }
  });
});
