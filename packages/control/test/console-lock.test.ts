import { describe, expect, it } from "vitest";
import { CONSOLE_LOCK_ADDRESS, ConsoleLockGuard } from "../src/operations/console-lock.js";
import { OperationContext } from "../src/operations/context.js";
import { OperationFailureError, operationFailureOf } from "../src/operations/failure.js";
import { readSetting, writeSetting } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };
const lock = { paramId: 895, x: "0", y: "0" };
async function failureOf(promise: Promise<unknown>) {
  return operationFailureOf(await promise.then(() => undefined, (error: unknown) => error));
}
const trace = (t: FakeTransport) => t.calls.map(({ method, address, value }) => [method, address.paramId, value]);

describe("Console Lock write guard (F20-L-A)", () => {
  it("register the lock subscription first, then one strict read per write operation, then the write", async () => {
    const t = new FakeTransport().script("getNumeric", read("0")).script("setNumeric", accepted);
    const c = new OperationContext(t, "URX44");
    const guard = await ConsoleLockGuard.open(c);
    expect(t.subscriptions.map((s) => [s.addresses, s.state])).toEqual([[[lock], "active"]]);
    expect(t.calls).toEqual([]);
    const done = await guard.begin(c);
    await writeSetting(c, "channel.on", { channel: 1 }, false);
    done();
    expect(trace(t)).toEqual([
      ["getNumeric", 895, undefined],
      ["setNumeric", 140, "0"],
    ]);
    expect(CONSOLE_LOCK_ADDRESS).toEqual(lock);
    await guard.release();
    await guard.release();
    expect(t.subscriptions[0]?.state).toBe("released");
  });

  it("stop on an initial locked read, and keep the stop after a later unlock", async () => {
    const t = new FakeTransport().script("getNumeric", read("1"), read("0"));
    const guard = await ConsoleLockGuard.open(new OperationContext(t, "URX44"));
    const first = new OperationContext(t, "URX44");
    expect((await failureOf(guard.begin(first)))?.code).toBe("precondition_failed");
    t.notify({ kind: "numeric", address: lock, value: "0" });
    // The latch holds: the next write operation is refused before it reads or sends anything.
    const second = new OperationContext(t, "URX44");
    expect((await failureOf(guard.begin(second)))?.code).toBe("precondition_failed");
    expect(trace(t)).toEqual([["getNumeric", 895, undefined]]);
  });

  it("latch a lock notification: later writes are refused unsent and the operation cancelled", async () => {
    const t = new FakeTransport().script("getNumeric", read("0")).script("setNumeric", accepted);
    const c = new OperationContext(t, "URX44");
    const guard = await ConsoleLockGuard.open(c);
    await guard.begin(c);
    await writeSetting(c, "channel.on", { channel: 1 }, true);
    t.notify({ kind: "numeric", address: lock, value: "1" });
    expect(guard.stop).toBe("precondition_failed");
    expect(c.stopping).toBe("precondition_failed");
    expect(t.cancelled).toBe(1);
    const refused = await failureOf(writeSetting(c, "channel.on", { channel: 2 }, true));
    expect([refused?.code, (refused?.progress as { outcome?: string } | null)?.outcome]).toEqual(["precondition_failed", "not_sent"]);
    // The accepted write stays the only one sent; an unlock afterwards clears nothing.
    t.notify({ kind: "numeric", address: lock, value: "0" });
    expect(guard.stop).toBe("precondition_failed");
    expect(trace(t)).toEqual([
      ["getNumeric", 895, undefined],
      ["setNumeric", 140, "1"],
    ]);
  });

  it("latch invalid_response for an invalid lock value or kind; ignore other addresses and bulk changes", async () => {
    for (const [notification, stop] of [
      [{ kind: "numeric", address: lock, value: "2" }, "invalid_response"],
      [{ kind: "numeric", address: lock, value: "-1" }, "invalid_response"],
      [{ kind: "text", address: lock, value: "1" }, "invalid_response"],
      [{ kind: "numeric", address: { paramId: 895, x: "0", y: "1" }, value: "1" }, undefined],
      [{ kind: "numeric", address: { paramId: 896, x: "0", y: "0" }, value: "1" }, undefined],
      [{ kind: "bulk-change" }, undefined],
      [{ kind: "meter", meterId: 1, x: "0", value: "0" }, undefined],
    ] as const) {
      const t = new FakeTransport().script("getNumeric", read("0"));
      const c = new OperationContext(t, "URX44");
      const guard = await ConsoleLockGuard.open(c);
      await guard.begin(c);
      t.notify(notification);
      expect(guard.stop, JSON.stringify(notification)).toBe(stop);
    }
  });

  it("refuse an invalid initial read, and register nothing to read when the subscription fails", async () => {
    const t = new FakeTransport().script("getNumeric", read("3"));
    const c = new OperationContext(t, "URX44");
    const guard = await ConsoleLockGuard.open(c);
    expect((await failureOf(guard.begin(c)))?.code).toBe("invalid_response");

    const refused = new FakeTransport();
    refused.activation = new Error("registration rejected");
    expect((await failureOf(ConsoleLockGuard.open(new OperationContext(refused, "URX44"))))?.code).toBe("internal_error");
    expect(refused.subscriptions[0]?.state).toBe("released");
    expect(refused.calls).toEqual([]);
    expect(refused.finished).toBe(1);
  });

  it("refuse an operation on another connection than the guard's before any request", async () => {
    const a = new FakeTransport().script("getNumeric", read("0"));
    const guard = await ConsoleLockGuard.open(new OperationContext(a, "URX44"));
    const b = new FakeTransport().script("getNumeric", read("0")).script("setNumeric", accepted).script("setText", accepted);
    const other = new OperationContext(b, "URX44");
    expect((await failureOf(guard.begin(other)))?.code).toBe("internal_error");
    expect([a.calls, b.calls]).toEqual([[], []]);
    // The other connection's operation is not attached: a lock on the guard's connection leaves it alone.
    a.notify({ kind: "numeric", address: lock, value: "1" });
    expect(other.stopping).toBeUndefined();
    await guard.release();
  });

  it("keep a failed registration's cause when its release also fails", async () => {
    const t = new FakeTransport();
    t.activation = new OperationFailureError({ code: "device_rejected", phase: "response", progress: null });
    t.releaseFailure = new OperationFailureError({ code: "teardown_timeout", phase: "response", progress: null });
    const failure = await failureOf(ConsoleLockGuard.open(new OperationContext(t, "URX44")));
    expect([failure?.code, failure?.progress]).toEqual(["device_rejected", { cleanup: "teardown_timeout" }]);
    expect(t.finished).toBe(1);
    // A released registration failure carries no cleanup code.
    const clean = new FakeTransport();
    clean.activation = new OperationFailureError({ code: "device_rejected", phase: "response", progress: null });
    expect((await failureOf(ConsoleLockGuard.open(new OperationContext(clean, "URX44"))))?.progress).toBeNull();
    // The owner's failing finish is the release's failure where the subscription released.
    const owner = new FakeTransport();
    const guard = await ConsoleLockGuard.open(new OperationContext(owner, "URX44"));
    owner.finishFailure = new Error("adapter failure");
    expect((await failureOf(guard.release()))?.code).toBe("internal_error");
  });

  // E3: the registration's failure is the cause, and a failure its own cleanup settled — the
  // transport's automatic unregistration of a registration the owner's cancellation stopped — goes
  // beside it once, as the failure's `later`, whatever the guard's own release then answers.
  it("report the failure a registration's own cleanup settled beside the registration's", async () => {
    const cleanup = (code: string) => ({ cleanup: { state: "incomplete", failure: { kind: "cause", code, phase: "subscription" } } });
    for (const [code, phase] of [
      ["device_rejected", "response"],
      ["response_timeout", "response"],
      ["connection_lost", "send"],
      ["send_timeout", "send"],
      ["not_connected", "admission"],
      ["notification_overflow", "delivery"],
      ["identity_error", "delivery"],
    ] as const) {
      const t = new FakeTransport();
      t.activation = new OperationFailureError({ code: "interrupted", phase: "send", progress: cleanup(code), cancelled: true });
      t.releaseFailure = new OperationFailureError({ code: "not_connected", phase: "admission", progress: null });
      const failure = await failureOf(ConsoleLockGuard.open(new OperationContext(t, "URX44")));
      expect(failure, code).toEqual({
        code: "interrupted",
        phase: "send",
        progress: { cleanup: "not_connected" },
        cancelled: true,
        later: { code: code === "identity_error" ? "internal_error" : code, phase },
      });
    }
    // A registration's own failure keeps its cause, its cleanup's failure beside it.
    const own = new FakeTransport();
    own.activation = new OperationFailureError({ code: "device_rejected", phase: "response", progress: cleanup("response_timeout") });
    expect(await failureOf(ConsoleLockGuard.open(new OperationContext(own, "URX44")))).toEqual({
      code: "device_rejected",
      phase: "response",
      progress: null,
      later: { code: "response_timeout", phase: "response" },
    });
    // A cleanup that failed nothing, or a progress that is no cleanup, adds nothing; a later the
    // registration's failure already carries stays the one.
    for (const progress of [
      { cleanup: { state: "complete", failure: null } },
      { cleanup: { state: "incomplete", failure: { kind: "cause", code: "connect_timeout", phase: "subscription" } } },
      { cleanup: "teardown_timeout" },
      { other: 1 },
      null,
    ]) {
      const t = new FakeTransport();
      t.activation = new OperationFailureError({ code: "interrupted", phase: "send", progress, cancelled: true });
      expect((await failureOf(ConsoleLockGuard.open(new OperationContext(t, "URX44"))))?.later, JSON.stringify(progress)).toBeUndefined();
    }
    const carried = new FakeTransport();
    carried.activation = new OperationFailureError({
      code: "interrupted",
      phase: "send",
      progress: cleanup("device_rejected"),
      cancelled: true,
      later: { code: "invalid_response", phase: "response" },
    });
    expect((await failureOf(ConsoleLockGuard.open(new OperationContext(carried, "URX44"))))?.later).toEqual({
      code: "invalid_response",
      phase: "response",
    });
  });

  it("keep a stop latched during the lock read as the cause, whatever the read returns, its own failure beside it", async () => {
    for (const [note, reply, code, later] of [
      ["1", read("3"), "precondition_failed", { code: "invalid_response", phase: "response" }],
      [
        "2",
        { kind: "failure", failure: { kind: "cause", code: "response_timeout", phase: "response" }, evidence: { state: "unconfirmed" } },
        "invalid_response",
        { code: "response_timeout", phase: "response" },
      ],
      // The read's own invalid value, the same code as the stop's from another source.
      ["2", read("9"), "invalid_response", { code: "invalid_response", phase: "response" }],
      // A read the stop cancelled adds nothing.
      ["2", { kind: "failure", failure: { kind: "cancelled", phase: "response" }, evidence: { state: "unconfirmed" } }, "invalid_response", undefined],
    ] as const) {
      const t = new FakeTransport();
      t.script("getNumeric", {
        then(resolve: (record: unknown) => void) {
          t.notify({ kind: "numeric", address: lock, value: note });
          resolve(reply);
        },
      });
      const c = new OperationContext(t, "URX44");
      const guard = await ConsoleLockGuard.open(c);
      const failure = await failureOf(guard.begin(c));
      expect([failure?.code, failure?.later], note).toEqual([code, later]);
      expect(t.calls.filter((call) => call.method.startsWith("set"))).toEqual([]);
    }
  });

  // The owner's stop (a Ctrl+C) stays the cause; the lock read it had already sent reports its own failure beside
  // it, with one read and nothing more: a read the stop cancelled has nothing to add, and a lock the read found is
  // the guard's own stop.
  it("report the sent lock read's own failure beside an owner's stop, and nothing for its cancellation", async () => {
    const failed = (code: string) => ({ kind: "failure", failure: { kind: "cause", code, phase: "response" }, evidence: { state: "unconfirmed" } });
    const rejected = { kind: "failure", failure: { kind: "cause", code: "device_rejected", phase: "response" }, evidence: { state: "rejected", responseCode: "9" } };
    const cancelled = { kind: "failure", failure: { kind: "cancelled", phase: "response" }, evidence: { state: "unconfirmed" } };
    for (const [reply, phase, later, stop] of [
      [failed("connection_lost"), "response", { code: "connection_lost", phase: "response" }, undefined],
      [rejected, "response", { code: "device_rejected", phase: "response" }, undefined],
      [failed("response_timeout"), "response", { code: "response_timeout", phase: "response" }, undefined],
      [read("7"), "response", { code: "invalid_response", phase: "response" }, undefined],
      [cancelled, "response", undefined, undefined],
      // Locked: refused at the guard's own check, with its stop.
      [read("1"), "preparation", undefined, "precondition_failed"],
    ] as const) {
      const t = new FakeTransport();
      let c: OperationContext | undefined;
      t.script("getNumeric", {
        then(resolve: (record: unknown) => void) {
          c?.cancel("interrupted");
          resolve(reply);
        },
      });
      c = new OperationContext(t, "URX44");
      const guard = await ConsoleLockGuard.open(c);
      const failure = await failureOf(guard.begin(c));
      expect([failure?.code, failure?.phase, failure?.later], JSON.stringify(reply)).toEqual(["interrupted", phase, later]);
      expect(t.calls.filter((call) => call.method === "getNumeric")).toHaveLength(1);
      expect(guard.stop, JSON.stringify(reply)).toBe(stop);
    }
  });

  // The stop as it stood when the lock read's failure arrived decides it: an owner's stop that lands after that, before
  // the guard has reported, does not take the failure's place.
  it("decide by the stop as it stood when the lock read's failure arrived", async () => {
    /** A context whose owner stops it right after the stop is first asked for once armed. */
    class StoppedWhenAsked extends OperationContext {
      armed = false;
      override get stopping() {
        const stopping = super.stopping;
        if (this.armed) {
          this.armed = false;
          this.cancel("interrupted");
        }
        return stopping;
      }
    }
    const late = { kind: "failure", failure: { kind: "cause", code: "response_timeout", phase: "response" }, evidence: { state: "unconfirmed" } };
    const t = new FakeTransport();
    let c: StoppedWhenAsked | undefined;
    t.script("getNumeric", {
      then(resolve: (record: unknown) => void) {
        if (c) c.armed = true;
        resolve(late);
      },
    });
    c = new StoppedWhenAsked(t, "URX44");
    const guard = await ConsoleLockGuard.open(c);
    const failure = await failureOf(guard.begin(c));
    expect([failure?.code, failure?.later, c.stopping]).toEqual(["response_timeout", undefined, "interrupted"]);
  });

  // The registration's cancellation mark survives the guard's own report of it, its release failing or not.
  it("keep a cancelled registration's mark in the opening's failure", async () => {
    for (const release of [undefined, new Error("adapter failure")]) {
      for (const [rejection, mark] of [
        [new OperationFailureError({ code: "interrupted", phase: "send", progress: null, cancelled: true }), true],
        [new OperationFailureError({ code: "connection_lost", phase: "send", progress: null }), undefined],
      ] as const) {
        const t = new FakeTransport();
        t.activation = rejection;
        t.releaseFailure = release;
        const failure = await failureOf(ConsoleLockGuard.open(new OperationContext(t, "URX44")));
        expect([failure?.code, failure?.cancelled], `${rejection.failure.code} release ${release === undefined ? "ok" : "fails"}`).toEqual([
          rejection.failure.code,
          mark,
        ]);
      }
    }
  });

  it("leave an operation that is not attached alone: a read-only line still reads after a lock", async () => {
    const t = new FakeTransport().script("getNumeric", read("0"), read("1"));
    const writer = new OperationContext(t, "URX44");
    const guard = await ConsoleLockGuard.open(writer);
    const done = await guard.begin(writer);
    done();
    t.notify({ kind: "numeric", address: lock, value: "1" });
    expect(writer.stopping).toBeUndefined();
    const reader = new OperationContext(t, "URX44");
    expect((await readSetting(reader, "channel.on", { channel: 1 })).value).toBe(true);
  });
});
