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
export class OperationContext {
  readonly transport: Transport;
  /** The connected unit's model, as the app verified it. */
  readonly model: string;
  readonly #operation: TransportOperation;
  #stopping: OperationCause | undefined;

  constructor(transport: Transport, model: string) {
    this.transport = transport;
    this.model = model;
    this.#operation = transport.createOperation();
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

  /** The owner's stopping cause, once cancelled. */
  get stopping(): OperationCause | undefined {
    return this.#stopping;
  }

  /** Releases the transport owner; call once the operation has completed. */
  finish(): void {
    this.#operation.finish();
  }

  getNumeric(address: ParameterAddress): Promise<NativeNumericReadResult> {
    return this.#issue((request) => this.transport.getNumeric(address, request), validateNumericRead);
  }

  getText(address: ParameterAddress): Promise<NativeTextReadResult> {
    return this.#issue((request) => this.transport.getText(address, request), validateTextRead);
  }

  getName(address: ParameterAddress): Promise<NativeNameReadResult> {
    return this.#issue((request) => this.transport.getName(address, request), validateNameRead);
  }

  setNumeric(address: ParameterAddress, value: I64Text): Promise<NativePostResult> {
    return this.#issue((request) => this.transport.setNumeric(address, value, request), validatePost);
  }

  setText(address: ParameterAddress, value: string): Promise<NativePostResult> {
    return this.#issue((request) => this.transport.setText(address, value, request), validatePost);
  }

  /**
   * The operation failure a failed record reports: its own cause, or for a
   * cancellation the owner's stopping cause (`internal_error` without one).
   */
  failureOf<P>(record: NativeFailure<unknown>, progress: P | null): OperationFailureError<P> {
    const { failure } = record;
    const code = failure.kind === "cause" ? failure.code : (this.#stopping ?? "internal_error");
    return new OperationFailureError({ code, phase: failure.phase, progress });
  }

  async #issue<T>(
    send: (request: { operation: TransportOperation; requestTicket: string }) => Promise<unknown>,
    validate: (record: unknown) => T | undefined,
  ): Promise<T> {
    // Issued by the connection, so it releases only this request's slot.
    const requestTicket = this.transport.newRequestTicket();
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
    const record = validate(raw);
    if (record === undefined) {
      // Its claimed evidence is not adopted (K34).
      throw await undelivered();
    }
    if (await settle(() => this.transport.adoptResult(requestTicket))) {
      return record;
    }
    // Established evidence could not be delivered normally: a success fails
    // at delivery keeping its evidence; a failure (a rejection included)
    // stays as received (K34).
    await reportUndelivered();
    return atDelivery(record);
  }
}
