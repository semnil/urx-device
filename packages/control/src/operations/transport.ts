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
}

/** The records the methods resolve with, once validated. */
export interface TransportRecords {
  getNumeric: NativeNumericReadResult;
  getText: NativeTextReadResult;
  getName: NativeNameReadResult;
  setNumeric: NativePostResult;
  setText: NativePostResult;
}
