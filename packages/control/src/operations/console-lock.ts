// The Console Lock write guard (F20-L-A). One guard belongs to one logical
// operation, or to one write-containing run: it registers its subscription
// to the lock (895, x 0, y 0) before any lock read, and each write operation
// under it begins with one fresh strict read. A locked read, a lock
// notification, or an invalid lock notification latches a stop that never
// clears; the setting writes of every operation attached to the guard are
// then refused at the send boundary and the attached operations cancelled.
// No polling, unlock, bypass or password access; it reads nothing else.

import { OperationFailureError, operationFailureOf, type OperationCause } from "./failure.js";
import type { OperationContext, WriteGuard } from "./context.js";
import { readSetting } from "./registry.js";
import type { ParameterAddress, Transport, TransportNotification, TransportOperation, TransportSubscription } from "./transport.js";

/** The Console Lock address (F20-L-A). */
export const CONSOLE_LOCK_ADDRESS: ParameterAddress = Object.freeze({ paramId: 895, x: "0", y: "0" });

const sameAddress = (a: ParameterAddress, b: ParameterAddress) => a.paramId === b.paramId && a.x === b.x && a.y === b.y;

export class ConsoleLockGuard implements WriteGuard {
  /** The connection the lock subscription is on; every write under the guard uses it. */
  readonly #transport: Transport;
  readonly #operation: TransportOperation;
  readonly #attached = new Set<OperationContext>();
  #subscription: TransportSubscription | undefined;
  #stop: OperationCause | undefined;
  #released: Promise<void> | undefined;

  private constructor(transport: Transport, operation: TransportOperation) {
    this.#transport = transport;
    this.#operation = operation;
  }

  /**
   * Registers the guard's lock subscription on the context's connection
   * (K9): it settles once the registration is accepted, and nothing is read
   * yet. A refused admission or a failed registration rejects with its
   * cause, the guard's own resources released; where that release fails
   * too, its code is the failure's `progress.cleanup`.
   */
  static async open(context: OperationContext): Promise<ConsoleLockGuard> {
    let operation: TransportOperation;
    try {
      operation = context.transport.createOperation();
    } catch {
      throw new OperationFailureError({ code: "internal_error", phase: "admission", progress: null });
    }
    const guard = new ConsoleLockGuard(context.transport, operation);
    try {
      guard.#subscription = context.transport.prepareSubscription([CONSOLE_LOCK_ADDRESS], operation, (notification) => guard.#deliver(notification));
      await guard.#subscription.activate();
    } catch (error) {
      // The failed registration is the first failure; a failing release is reported beside it.
      const cleanup = await guard.release().then(
        () => null,
        (failure: unknown) => operationFailureOf(failure)?.code ?? "internal_error",
      );
      const failure = operationFailureOf(error) ?? { code: "internal_error" as const, phase: "admission" as const };
      throw new OperationFailureError({ code: failure.code, phase: failure.phase, progress: cleanup === null ? null : { cleanup } });
    }
    return guard;
  }

  /** The latched stop, once there is one; it never clears. */
  get stop(): OperationCause | undefined {
    return this.#stop;
  }

  /**
   * Begins one write operation under the guard: attaches `context`, then
   * makes its one fresh strict lock read. A locked unit, a latched stop, or
   * a failed read rejects (the context detached), and no setting is sent;
   * a stop latched before the rejection is its cause.
   * A context on another connection than the guard's is refused before any
   * request: the lock it observes would not be that connection's.
   * The returned function detaches the context once its operation is done.
   */
  async begin(context: OperationContext): Promise<() => void> {
    const detach = () => {
      this.#attached.delete(context);
    };
    if (this.#released !== undefined || context.transport !== this.#transport) {
      throw new OperationFailureError({ code: "internal_error", phase: "preparation", progress: null });
    }
    context.guardWrites(this);
    this.#attached.add(context);
    try {
      this.#refuseIfStopped();
      const reading = await readSetting(context, "device.console-lock", {});
      if (reading.value) {
        this.#latch("precondition_failed");
      }
      this.#refuseIfStopped();
    } catch (error) {
      detach();
      // The operation's first stopping cause stays, whatever the lock read then returned.
      const failure = operationFailureOf(error);
      if (context.stopping !== undefined && failure !== undefined && failure.code !== context.stopping) {
        throw new OperationFailureError({ code: context.stopping, phase: failure.phase, progress: failure.progress });
      }
      throw error;
    }
    return detach;
  }

  /**
   * Releases the guard's subscription and owner; repeated calls join one
   * completion, which rejects with the first failure (the subscription's,
   * then the owner's).
   */
  release(): Promise<void> {
    this.#released ??= (async () => {
      this.#attached.clear();
      let failure: unknown;
      try {
        await this.#subscription?.release();
      } catch (error) {
        failure = error;
      }
      try {
        this.#operation.finish();
      } catch {
        failure ??= new OperationFailureError({ code: "internal_error", phase: "preparation", progress: null });
      }
      if (failure !== undefined) {
        throw failure;
      }
    })();
    return this.#released;
  }

  #refuseIfStopped(): void {
    if (this.#stop !== undefined) {
      throw new OperationFailureError({ code: this.#stop, phase: "preparation", progress: null });
    }
  }

  /** Strict: 0 unlocked, 1 locked; any other value or kind at the lock address is invalid. */
  #deliver(notification: TransportNotification): void {
    if (notification.kind === "numeric" && sameAddress(notification.address, CONSOLE_LOCK_ADDRESS)) {
      if (notification.value === "1") {
        this.#latch("precondition_failed");
      } else if (notification.value !== "0") {
        this.#latch("invalid_response");
      }
    } else if (notification.kind === "text" && sameAddress(notification.address, CONSOLE_LOCK_ADDRESS)) {
      this.#latch("invalid_response");
    }
  }

  #latch(cause: OperationCause): void {
    if (this.#stop !== undefined) {
      return;
    }
    this.#stop = cause;
    for (const context of this.#attached) {
      context.cancel(cause);
    }
  }
}
