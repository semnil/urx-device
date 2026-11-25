// A controlled transport for common-operation tests (K30): each method
// resolves with the next scripted record for it and records the call.

import type { I64Text } from "../src/catalog/i64.js";
import type {
  ParameterAddress,
  Transport,
  TransportOperation,
  TransportRequest,
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
  finished = 0;
  readonly #scripts = new Map<Method, unknown[]>();

  /** Queues `records` for `method`, resolved in order. */
  script(method: Method, ...records: unknown[]): this {
    this.#scripts.set(method, [...(this.#scripts.get(method) ?? []), ...records]);
    return this;
  }

  createOperation(): TransportOperation {
    return {
      cancel: () => {
        this.cancelled += 1;
      },
      finish: () => {
        this.finished += 1;
      },
    };
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
    // Recorded only once the asynchronous completion runs.
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        record();
        if (this.completion === "reject") {
          reject(new Error("adapter failure"));
        } else {
          resolve();
        }
      }, 1);
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
