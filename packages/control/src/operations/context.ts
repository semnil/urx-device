// The operation context (K2, K3, K34): one verified connection and its model,
// the injected transport, and the owner's cancellation and stopping cause.
// Requests go through it so every record is validated before adoption.

import type { I64Text } from "../catalog/i64.js";
import { OperationFailureError, type OperationCause } from "./failure.js";
import {
  validateNameRead,
  validateNumericRead,
  validatePost,
  validateTextRead,
  type NativeFailure,
  type NativeNameReadResult,
  type NativeNumericReadResult,
  type NativePostResult,
  type NativeTextReadResult,
} from "./native.js";
import type { ParameterAddress, Transport, TransportOperation } from "./transport.js";

/** A validated record and its PC receipt time, absent if the clock failed. */
export interface Received<T> {
  readonly record: T;
  readonly observedAt: string | undefined;
}

/** Runs `call`, turning a throw or a rejection into false. */
async function settle(call: () => Promise<void>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch {
    return false;
  }
}

/** A success whose delivery failed: `internal_error` at delivery, same evidence. */
function atDelivery<T>(record: T): T {
  const result = record as { kind: string; evidence: unknown };
  if (result.kind !== "success") {
    return record;
  }
  return {
    kind: "failure",
    failure: { kind: "cause", code: "internal_error", phase: "delivery" },
    evidence: result.evidence,
  } as T;
}

/** The owner of one logical operation over one connection. */
/** A write guard an operation's setting writes check at the send boundary (F20-L-A). */
export interface WriteGuard {
  /** The latched stop, once there is one; it never clears. */
  readonly stop: OperationCause | undefined;
}

export class OperationContext {
  readonly transport: Transport;
  /** The connected unit's model, as the app verified it. */
  readonly model: string;
  readonly #operation: TransportOperation;
  readonly #clock: () => Date;
  #stopping: OperationCause | undefined;
  readonly #writeGuards = new Set<WriteGuard>();

  /** `clock` gives observation times (O5); the system clock by default. */
  constructor(transport: Transport, model: string, clock: () => Date = () => new Date()) {
    this.transport = transport;
    this.model = model;
    this.#operation = transport.createOperation();
    this.#clock = clock;
  }

  /** The current observation time, UTC ISO 8601. */
  now(): string {
    return this.#clock().toISOString();
  }

  #receiptTime(): string | undefined {
    try {
      return this.now();
    } catch {
      return undefined;
    }
  }

  /**
   * Stops the operation for `cause`, recorded before native cancellation so
   * a cancelled request reports the owner's actual cause (K34). The first
   * cause stays.
   */
  cancel(cause: OperationCause): void {
    this.#stopping ??= cause;
    this.#operation.cancel();
  }

  /**
   * Puts this operation's writes under `guard` (F20-L-A): no setting write
   * is handed to the transport once the guard has latched a stop. The guard
   * also cancels the operation when it latches, so unsent work stops.
   */
  guardWrites(guard: WriteGuard): void {
    this.#writeGuards.add(guard);
  }

  /** The owner's stopping cause, once cancelled. */
  get stopping(): OperationCause | undefined {
    return this.#stopping;
  }

  /** Releases the transport owner; call once the operation has completed. */
  finish(): void {
    this.#operation.finish();
  }

  getNumeric(address: ParameterAddress): Promise<Received<NativeNumericReadResult>> {
    return this.#issue((request) => this.transport.getNumeric(address, request), validateNumericRead);
  }

  getText(address: ParameterAddress): Promise<Received<NativeTextReadResult>> {
    return this.#issue((request) => this.transport.getText(address, request), validateTextRead);
  }

  getName(address: ParameterAddress): Promise<Received<NativeNameReadResult>> {
    return this.#issue((request) => this.transport.getName(address, request), validateNameRead);
  }

  async setNumeric(address: ParameterAddress, value: I64Text): Promise<NativePostResult> {
    this.#checkWriteGuard();
    return (await this.#issue((request) => this.transport.setNumeric(address, value, request), validatePost)).record;
  }

  async setText(address: ParameterAddress, value: string): Promise<NativePostResult> {
    this.#checkWriteGuard();
    return (await this.#issue((request) => this.transport.setText(address, value, request), validatePost)).record;
  }

  /**
   * The operation failure a failed record reports: its own cause, or for a
   * cancellation the owner's stopping cause (`internal_error` without one),
   * marked `cancelled`.
   */
  failureOf<P>(record: NativeFailure<unknown>, progress: P | null): OperationFailureError<P> {
    const { failure } = record;
    if (failure.kind === "cause") {
      return new OperationFailureError({ code: failure.code, phase: failure.phase, progress });
    }
    return new OperationFailureError({ code: this.#stopping ?? "internal_error", phase: failure.phase, progress, cancelled: true });
  }

  /**
   * The send boundary of every setting write: a latched guard stop refuses
   * it before it is handed over (admission), so it is reported not sent,
   * with the operation's first stopping cause where guards latched in turn.
   */
  #checkWriteGuard(): void {
    for (const guard of this.#writeGuards) {
      const stop = guard.stop;
      if (stop !== undefined) {
        throw new OperationFailureError({ code: this.#stopping ?? stop, phase: "admission", progress: null });
      }
    }
  }

  async #issue<T>(
    send: (request: { operation: TransportOperation; requestTicket: string }) => Promise<unknown>,
    validate: (record: unknown) => T | undefined,
  ): Promise<Received<T>> {
    // Issued by the connection, so it releases only this request's slot. A
    // failure here is before the request was handed over: nothing was sent.
    let requestTicket: string;
    try {
      requestTicket = this.transport.newRequestTicket();
    } catch {
      throw new OperationFailureError({ code: "internal_error", phase: "admission", progress: null });
    }
    // Awaited, so the slot is handed over before the caller can finish:
    // when the report itself fails, the connection's end takes the slot.
    const reportUndelivered = async () => {
      if (!(await settle(() => this.transport.failDelivery(requestTicket)))) {
        await settle(() => this.transport.terminate(requestTicket));
      }
    };
    const undelivered = async () => {
      await reportUndelivered();
      return new OperationFailureError({ code: "internal_error", phase: "delivery", progress: null });
    };
    let raw: unknown;
    try {
      raw = await send({ operation: this.#operation, requestTicket });
    } catch {
      // A rejected native promise is not evidence of anything (K33).
      throw await undelivered();
    }
    // The PC receipt time (O5), before any wait for the adoption. A failing
    // clock leaves it absent; it changes nothing about the record or slot.
    const observedAt = this.#receiptTime();
    const record = validate(raw);
    if (record === undefined) {
      // Its claimed evidence is not adopted (K34).
      throw await undelivered();
    }
    if (await settle(() => this.transport.adoptResult(requestTicket))) {
      return { record, observedAt };
    }
    // Established evidence could not be delivered normally: a success fails
    // at delivery keeping its evidence; a failure (a rejection included)
    // stays as received (K34).
    await reportUndelivered();
    return { record: atDelivery(record), observedAt };
  }
}
