// A controlled transport for common-operation tests (K30): each method
// resolves with the next scripted record for it and records the call.

import type { I64Text } from "../src/catalog/i64.js";
import type { OperationCause } from "../src/operations/failure.js";
import type {
  ParameterAddress,
  Transport,
  TransportNotification,
  TransportOperation,
  TransportRequest,
  TransportSubscription,
} from "../src/operations/transport.js";

export type Method = "getNumeric" | "getText" | "getName" | "setNumeric" | "setText";

export interface Call {
  method: Method;
  address: ParameterAddress;
  value?: I64Text | string;
  ticket: string;
}

export class FakeTransport implements Transport {
  readonly calls: Call[] = [];
  readonly adopted: string[] = [];
  readonly undelivered: string[] = [];
  #nextTicket = 0;
  cancelled = 0;
  /** The cause each `cancel` was given, in order: `undefined` for none. */
  readonly cancelCauses: (OperationCause | undefined)[] = [];
  finished = 0;
  readonly #scripts = new Map<Method, unknown[]>();

  /** Queues `records` for `method`, resolved in order. */
  script(method: Method, ...records: unknown[]): this {
    this.#scripts.set(method, [...(this.#scripts.get(method) ?? []), ...records]);
    return this;
  }

  createOperation(): TransportOperation {
    return {
      cancel: (cause) => {
        this.cancelled += 1;
        this.cancelCauses.push(cause);
      },
      finish: () => {
        this.finished += 1;
        if (this.finishFailure !== undefined) {
          throw this.finishFailure;
        }
      },
    };
  }

  /** Admitted subscriptions in order, with their routes and lifecycle. */
  readonly subscriptions: {
    addresses: readonly ParameterAddress[];
    deliver: (notification: TransportNotification) => void;
    state: "prepared" | "active" | "released";
  }[] = [];
  /** When set, `activate` rejects with it (after the subscription is marked released). */
  activation: Error | undefined;
  /** When set, `release` rejects with it (after the subscription is marked released). */
  releaseFailure: Error | undefined;
  /** When set, called as each subscription's `release` starts. */
  onRelease: (() => void) | undefined;
  /** When set, an operation's `finish` throws it (after counting the call). */
  finishFailure: Error | undefined;

  prepareSubscription(
    addresses: readonly ParameterAddress[],
    _operation: TransportOperation,
    deliver: (notification: TransportNotification) => void,
  ): TransportSubscription {
    const entry = { addresses, deliver, state: "prepared" as "prepared" | "active" | "released" };
    this.subscriptions.push(entry);
    return {
      activate: async () => {
        if (this.activation !== undefined) {
          entry.state = "released";
          throw this.activation;
        }
        entry.state = "active";
      },
      release: async () => {
        this.onRelease?.();
        entry.state = "released";
        if (this.releaseFailure !== undefined) {
          throw this.releaseFailure;
        }
      },
    };
  }

  /** Routes `notification` to every active subscription to its address (a bulk change to all). */
  notify(notification: TransportNotification): void {
    for (const entry of this.subscriptions) {
      if (entry.state !== "active") continue;
      const hit =
        notification.kind === "bulk-change" ||
        notification.kind === "meter" ||
        entry.addresses.some((a) => a.paramId === notification.address.paramId && a.x === notification.address.x && a.y === notification.address.y);
      if (hit) entry.deliver(notification);
    }
  }

  getNumeric(address: ParameterAddress, request: TransportRequest): Promise<unknown> {
    return this.#answer("getNumeric", address, undefined, request);
  }

  getText(address: ParameterAddress, request: TransportRequest): Promise<unknown> {
    return this.#answer("getText", address, undefined, request);
  }

  getName(address: ParameterAddress, request: TransportRequest): Promise<unknown> {
    return this.#answer("getName", address, undefined, request);
  }

  setNumeric(address: ParameterAddress, value: I64Text, request: TransportRequest): Promise<unknown> {
    return this.#answer("setNumeric", address, value, request);
  }

  setText(address: ParameterAddress, value: string, request: TransportRequest): Promise<unknown> {
    return this.#answer("setText", address, value, request);
  }

  newRequestTicket(): string {
    return `t${this.#nextTicket++}`;
  }

  /** How `adoptResult` and `failDelivery` complete; resolving by default. */
  completion: "resolve" | "throw" | "reject" = "resolve";
  /** Whether completions wait for a timer; off for tests issuing many requests. */
  timers = true;
  readonly terminated: string[] = [];

  terminate(requestTicket: string): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        this.terminated.push(requestTicket);
        resolve();
      }, 1);
    });
  }

  adoptResult(requestTicket: string): Promise<void> {
    return this.#complete(() => this.adopted.push(requestTicket));
  }

  failDelivery(requestTicket: string): Promise<void> {
    return this.#complete(() => this.undelivered.push(requestTicket));
  }

  #complete(record: () => void): Promise<void> {
    if (this.completion === "throw") {
      throw new Error("adapter failure");
    }
    // Recorded only once the asynchronous completion runs: after a timer,
    // or in a microtask when `timers` is off.
    const later = (run: () => void) => (this.timers ? setTimeout(run, 1) : queueMicrotask(run));
    return new Promise((resolve, reject) => {
      later(() => {
        record();
        if (this.completion === "reject") {
          reject(new Error("adapter failure"));
        } else {
          resolve();
        }
      });
    });
  }

  #answer(
    method: Method,
    address: ParameterAddress,
    value: I64Text | string | undefined,
    request: TransportRequest,
  ): Promise<unknown> {
    this.calls.push({ method, address, ...(value === undefined ? {} : { value }), ticket: request.requestTicket });
    const queue = this.#scripts.get(method) ?? [];
    if (queue.length === 0) {
      return Promise.reject(new Error(`no scripted record for ${method}`));
    }
    const next = queue.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}
