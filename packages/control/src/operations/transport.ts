// The connection-bound transport interface common operations use (K2, K37).
// The CLI addon and the router adapter implement it; common code never
// handles sockets, discovery or native handles.

import type { I64Text } from "../catalog/i64.js";
import type {
  NativeNameReadResult,
  NativeNumericReadResult,
  NativePostResult,
  NativeTextReadResult,
} from "./native.js";

/** A parameter address (K7): u32 identifier, i64 coordinates. */
export interface ParameterAddress {
  readonly paramId: number;
  readonly x: I64Text;
  readonly y: I64Text;
}

/** A local owner of one logical operation's requests (K37). */
export interface TransportOperation {
  /** Idempotent: stops unsent work; sent evidence settles under its deadlines. */
  cancel(): void;
  /** Releases the owner once its requests are consumed; no remote I/O. */
  finish(): void;
}

/**
 * The adapter's identity for one submitted request, unique for the
 * connection's life: it releases only that request's completion slot.
 */
export type RequestTicket = string;

export interface TransportRequest {
  readonly operation: TransportOperation;
  readonly requestTicket: RequestTicket;
}

/**
 * One notification delivered to a subscription's route (K12), as the native
 * side received it: a numeric or text parameter change, a meter reading, or
 * a namespace-wide change with no address. Callers validate it before use.
 */
export type TransportNotification =
  | { readonly kind: "numeric"; readonly address: ParameterAddress; readonly value: I64Text }
  | { readonly kind: "text"; readonly address: ParameterAddress; readonly value: string }
  | { readonly kind: "meter"; readonly meterId: number; readonly x: I64Text; readonly value: I64Text }
  | { readonly kind: "bulk-change" };

/** One admitted subscription (K8, K11), registered by `activate` (K9). */
export interface TransportSubscription {
  /**
   * Registers every address in order; settles once all are accepted. A
   * rejection or failure rejects after the owned cleanup (K10), with an
   * `OperationFailureError`; one the owner's cancellation caused carries
   * the stopping cause as its code and `cancelled: true`.
   */
  activate(): Promise<void>;
  /** Releases the subscription (K10); repeated calls join one completion. */
  release(): Promise<void>;
}

/**
 * One verified connection. Each method resolves with the raw K34 record the
 * native side returned; callers validate it before adopting anything.
 */
export interface Transport {
  createOperation(): TransportOperation;
  /** A ticket never issued before on this connection (K37). */
  newRequestTicket(): RequestTicket;
  getNumeric(address: ParameterAddress, request: TransportRequest): Promise<unknown>;
  getText(address: ParameterAddress, request: TransportRequest): Promise<unknown>;
  getName(address: ParameterAddress, request: TransportRequest): Promise<unknown>;
  setNumeric(address: ParameterAddress, value: I64Text, request: TransportRequest): Promise<unknown>;
  setText(address: ParameterAddress, value: string, request: TransportRequest): Promise<unknown>;
  /**
   * Admits a subscription to `addresses` for `operation` (K11), with no
   * traffic yet. From activation until release the adapter calls `deliver`
   * with each notification it routes to this subscription's token, in
   * receive order, before acknowledging the batch that carried it. A refused
   * admission throws.
   */
  prepareSubscription(
    addresses: readonly ParameterAddress[],
    operation: TransportOperation,
    deliver: (notification: TransportNotification) => void,
  ): TransportSubscription;
  /**
   * Acknowledges the validated result of `requestTicket`, releasing its
   * completion slot; no device I/O. At most once per ticket. It settles
   * once the slot is released; a rejection means it could not be.
   */
  adoptResult(requestTicket: RequestTicket): Promise<void>;
  /**
   * Reports that the result of `requestTicket` could not be adopted: its
   * record was invalid or its promise rejected. The adapter applies its
   * fatal rules to the slot instead of releasing it as adopted, and settles
   * once it has.
   */
  failDelivery(requestTicket: RequestTicket): Promise<void>;
  /**
   * Ends the connection under the adapter's fatal rules if, and only if,
   * `requestTicket` still owns a slot not yet released: its failed delivery
   * could not be handed over otherwise. The ownership check and the move to
   * the end are one step. It settles once the end has taken the slot (or
   * there was none); it never needs another fallback.
   */
  terminate(requestTicket: RequestTicket): Promise<void>;
}

/** The records the methods resolve with, once validated. */
export interface TransportRecords {
  getNumeric: NativeNumericReadResult;
  getText: NativeTextReadResult;
  getName: NativeNameReadResult;
  setNumeric: NativePostResult;
  setText: NativePostResult;
}
