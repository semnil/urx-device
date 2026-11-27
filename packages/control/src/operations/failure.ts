// The one structured operation failure (K3): semantic operations reject with
// it, preserving the actual cause, where it occurred and the evidence the
// operation had established.

import type { NativeRequestPhase } from "./native.js";

/** E2 cause identifiers a shared operation can report. */
export type OperationCause =
  | "invalid_input"
  | "unsupported_operation"
  | "precondition_failed"
  | "not_connected"
  | "connection_lost"
  | "send_timeout"
  | "response_timeout"
  | "teardown_timeout"
  | "device_rejected"
  | "invalid_response"
  | "notification_overflow"
  | "input_closed"
  | "input_error"
  | "output_error"
  | "output_timeout"
  | "interrupted"
  | "internal_error";

/** Where an operation failed: a request phase, or before any request. */
export type OperationPhase = NativeRequestPhase | "preparation";

/**
 * A cause an operation found after it had already stopped for another (E3): the
 * failure of a request it had sent, or a condition it found. The first
 * stopping cause stays the failure's code; this is what the caller reports
 * beside it.
 */
export interface LaterCause {
  readonly code: OperationCause;
  readonly phase: OperationPhase;
}

/** The serializable failure payload; it never relies on class identity. */
export interface OperationFailure<P = unknown> {
  readonly code: OperationCause;
  readonly phase: OperationPhase;
  /** Typed execution evidence, or null when none exists. */
  readonly progress: P | null;
  /** A cause found after `code` had stopped the operation; absent when there is none. */
  readonly later?: LaterCause;
  /**
   * Set where the failure is the owner's cancellation, reported with its
   * stopping cause as `code`: nothing failed of its own. `failureOf` sets it
   * for a cancelled request, and a transport adapter for a subscription
   * lifecycle its cancellation stopped (`TransportSubscription`).
   */
  readonly cancelled?: true;
}

/** The single failure type of shared operations (K3-B). */
export class OperationFailureError<P = unknown> extends Error {
  readonly failure: OperationFailure<P>;

  constructor(failure: OperationFailure<P>) {
    // The message names the identifier only; no device data or raw text.
    super(`operation failed: ${failure.code} (${failure.phase})`);
    this.name = "OperationFailureError";
    this.failure = failure;
  }
}

/** The structured failure of `error`, if it carries one, else undefined. */
export function operationFailureOf(error: unknown): OperationFailure | undefined {
  return error instanceof OperationFailureError ? error.failure : undefined;
}
