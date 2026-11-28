// Executing a CURRENT plan (K36, O11, L3, L5): the whole import is one
// logical operation under the caller's Console Lock guard (F20-L-A), whose
// one lock read comes first; then the rate subscription is registered and
// one device sample-rate read is compared with the file's before the first
// write; then each step's own operation runs in order. A received rate
// notification that differs from the file's rate stops the unsent steps,
// and a later return to the file's rate does not resume them; no further
// rate read is made for this import-wide condition. The first failure stops the unsent steps; accepted
// steps are kept, and nothing is rolled back, retried or read back. A
// dry-run performs the same prerequisite reads and sends no setting write.

import type { ConsoleLockGuard } from "../operations/console-lock.js";
import type { OperationContext, WriteGuard } from "../operations/context.js";
import type { LaterCause, OperationCause, OperationPhase } from "../operations/failure.js";
import type { ParameterAddress, TransportNotification, TransportOperation, TransportSubscription } from "../operations/transport.js";
import { OperationFailureError, operationFailureOf } from "../operations/failure.js";
import { cleanupFailureOf } from "../operations/lifecycle.js";
import { DEVICE_RULES } from "../catalog/device.js";
import { dryRunSettingAfter, readSetting, writeSetting, type WriteArgs } from "../operations/registry.js";
import { codecOf } from "../operations/rules.js";
import type { UnverifiedCondition, WriteOutcome } from "../operations/results.js";
import type { CurrentPlan, PlannedStep } from "./plan.js";

export interface StepResult extends PlannedStep {
  readonly outcome: WriteOutcome;
  /** The failure's code at the step that failed; null elsewhere. */
  readonly error: string | null;
  /** In a dry run, the step's prerequisites an earlier unsent step can change (O13); empty otherwise. */
  readonly unverified: readonly UnverifiedCondition[];
}

export interface ApplyResult {
  readonly steps: readonly StepResult[];
  /**
   * The overall failure code: the operation's first stopping cause where one
   * stopped it, otherwise the first failure (a failed release of the rate
   * observation included); null when every step was accepted (or planned in
   * a dry-run) and the observation released.
   */
  readonly error: string | null;
  /** The rate observation's release failure code, reported even after an earlier failure; null when released or never registered. */
  readonly cleanup: string | null;
  /**
   * A cause found after `error` had stopped the import (E3): the lock read's
   * or the rate read's own failure, or a rate condition (L5) the rate read or
   * a rate notification found; the first one found, null when there is none.
   * A lock the guard found is the guard's own `stop`.
   */
  readonly later: LaterCause | null;
}

/** The device sample rate (F11-C): 766, x 0, y 0. */
const RATE_ADDRESS: ParameterAddress = Object.freeze({ paramId: 766, x: "0", y: "0" });

/**
 * The import-wide rate condition (L5): once registered, a valid rate
 * notification other than the file's rate latches precondition_failed, an
 * invalid one invalid_response, and the latch cancels the import and refuses
 * its unsent writes; it never clears. Other addresses do not affect it.
 */
class RateWatch implements WriteGuard {
  readonly #context: OperationContext;
  readonly #fileRate: number;
  readonly #record: ImportRecord;
  #stop: OperationCause | undefined;

  constructor(context: OperationContext, fileRate: number, record: ImportRecord) {
    this.#context = context;
    this.#fileRate = fileRate;
    this.#record = record;
  }

  get stop(): OperationCause | undefined {
    return this.#stop;
  }

  /** Judged by the same rate codec as the rate read: a value it does not decode is invalid. */
  deliver(notification: TransportNotification): void {
    if (notification.kind === "text" && sameAddress(notification.address, RATE_ADDRESS)) {
      this.latch("invalid_response");
    }
    if (notification.kind !== "numeric" || !sameAddress(notification.address, RATE_ADDRESS)) {
      return;
    }
    const rate = RATE_CODEC.decode(notification.value);
    if (rate === undefined) {
      this.latch("invalid_response");
    } else if (rate !== this.#fileRate) {
      this.latch("precondition_failed");
    }
  }

  /** Each condition goes on the import's record; the first one also stops the import. */
  latch(cause: OperationCause): void {
    this.#record.condition(cause);
    if (this.#stop === undefined) {
      this.#stop = cause;
      this.#context.cancel(cause);
    }
  }
}

/** One event on the import's record. */
type ImportEvent =
  | { readonly kind: "stop"; readonly code: OperationCause }
  | { readonly kind: "failure"; readonly code: OperationCause; readonly phase: OperationPhase; readonly beside: boolean }
  | { readonly kind: "condition"; readonly code: OperationCause }
  | { readonly kind: "settled" };

/**
 * The import's record (E3): each event that stops or settles it — the
 * context's stop (its owner's, or a guard's), a failure (a prerequisite's or
 * a step's), a rate condition, the settling of a success — appended where it
 * happens, so the record holds them in the order the import met them. The
 * import's error and the cause beside it are read from the record alone: the
 * error is the first event, unless a success was settled first; the cause
 * beside it is the first prerequisite's own failure or condition after it.
 */
class ImportRecord {
  readonly #context: OperationContext;
  readonly #events: ImportEvent[] = [];
  #stopSeen = false;

  constructor(context: OperationContext) {
    this.#context = context;
  }

  /** A failure: a prerequisite's own (`beside`: a cause that may go beside the stop), a step's, or a cancellation. */
  failure(code: OperationCause, phase: OperationPhase, beside: boolean): void {
    this.#append({ kind: "failure", code, phase, beside });
  }

  condition(code: OperationCause): void {
    this.#append({ kind: "condition", code });
  }

  /** Every write accepted: the import's result is settled, unless something stopped it first. */
  settle(): void {
    if (!this.ended) {
      this.#append({ kind: "settled" });
    }
  }

  /** Whether an event stopped the import before any success was settled. */
  get ended(): boolean {
    return this.#first() !== undefined;
  }

  /** The first event's code; null when a success was settled first, or nothing stopped the import. */
  get error(): OperationCause | null {
    return this.#first()?.code ?? null;
  }

  /** The first prerequisite's own failure or condition after the event that stopped the import. */
  get later(): LaterCause | null {
    if (this.#first() === undefined) {
      return null;
    }
    for (const event of this.#events.slice(1)) {
      if (event.kind === "failure" && event.beside) {
        return { code: event.code, phase: event.phase };
      }
      if (event.kind === "condition") {
        return { code: event.code, phase: "preparation" };
      }
    }
    return null;
  }

  #first(): Exclude<ImportEvent, { kind: "settled" }> | undefined {
    this.#syncStop();
    const first = this.#events[0];
    return first === undefined || first.kind === "settled" ? undefined : first;
  }

  /** The context's stop goes on the record before whatever comes after it is seen. */
  #syncStop(): void {
    const stopping = this.#context.stopping;
    if (stopping !== undefined && !this.#stopSeen) {
      this.#stopSeen = true;
      this.#events.push({ kind: "stop", code: stopping });
    }
  }

  #append(event: ImportEvent): void {
    this.#syncStop();
    this.#events.push(event);
  }
}

const sameAddress = (a: ParameterAddress, b: ParameterAddress) => a.paramId === b.paramId && a.x === b.x && a.y === b.y;

/** The device sample rate's codec, shared with its read (F11-C). */
const RATE_CODEC = codecOf(DEVICE_RULES["device.sample-rate"].value);

/** An observation's outcome: whether it ended the import, and the release that reports its own failure. */
interface RateObservation {
  readonly ended: boolean;
  readonly release: () => Promise<string | null>;
}

/**
 * Registers the rate observation, then makes the one rate read (L3, L5):
 * a mismatch is a failed precondition before any write. The clock is never
 * written from the file. The observation's own failures (its admission, its
 * registration, its read) and its conditions go on the import's record where
 * they happen; a failure that is a cancellation ends the import and is no
 * cause of its own. The observation's release is always returned, and
 * reports its own failure instead of replacing an earlier one.
 */
async function watchRate(context: OperationContext, fileRate: number, record: ImportRecord): Promise<RateObservation> {
  const watch = new RateWatch(context, fileRate, record);
  // An exception that carries no failure is an internal error.
  const failed = (error: unknown): true => {
    const failure = operationFailureOf(error);
    record.failure(failure?.code ?? "internal_error", failure?.phase ?? "preparation", failure?.cancelled !== true);
    // The cause found after it, as the guard keeps it: the one the failure already carries, else a
    // failure the registration's own cleanup settled (`cleanupFailureOf`).
    const after = failure?.later ?? cleanupFailureOf(failure?.progress);
    if (after !== undefined) record.failure(after.code, after.phase, true);
    return true;
  };
  let operation: TransportOperation;
  try {
    operation = context.transport.createOperation();
  } catch (error) {
    return { ended: failed(error), release: async () => null };
  }
  let subscription: TransportSubscription | undefined;
  // The subscription's release failure first, then the owner's; neither replaces the result.
  const release = async () => {
    let cleanup: string | null = null;
    try {
      await subscription?.release();
    } catch (error) {
      cleanup = operationFailureOf(error)?.code ?? "internal_error";
    }
    try {
      operation.finish();
    } catch {
      cleanup ??= "internal_error";
    }
    return cleanup;
  };
  try {
    subscription = context.transport.prepareSubscription([RATE_ADDRESS], operation, (notification) => watch.deliver(notification));
    await subscription.activate();
    context.guardWrites(watch);
    const device = await readSetting(context, "device.sample-rate", {});
    if (device.value !== fileRate) {
      watch.latch("precondition_failed");
    }
    return { ended: watch.stop !== undefined, release };
  } catch (error) {
    return { ended: failed(error), release };
  }
}

/**
 * Applies (or, with `dryRun`, plans with the prerequisite reads) `plan` as
 * one write operation under `options.guard`, which the caller has opened and
 * releases: its lock read precedes the rate check, a lock stops the unsent
 * steps, and a dry run makes the same reads. The plan carries its own model
 * and file rate, so the values sent, the omissions and the rate checked come
 * from one file; a plan built for another model is refused before any
 * request.
 */
export async function applyCurrent(
  context: OperationContext,
  plan: CurrentPlan,
  options: { readonly guard: ConsoleLockGuard; readonly dryRun?: boolean },
): Promise<ApplyResult> {
  const results: StepResult[] = plan.steps.map((step) => ({ ...step, outcome: "not_sent", error: null, unverified: [] }));
  if (context.model !== plan.model) {
    return { steps: results, error: "invalid_input", cleanup: null, later: null };
  }
  let detach: () => void;
  try {
    detach = await options.guard.begin(context);
  } catch (error) {
    const failure = operationFailureOf(error);
    return { steps: results, error: failure?.code ?? "internal_error", cleanup: null, later: failure?.later ?? null };
  }
  try {
    return await run(context, plan, results, options.dryRun === true);
  } finally {
    detach();
  }
}

async function run(context: OperationContext, plan: CurrentPlan, results: StepResult[], dryRun: boolean): Promise<ApplyResult> {
  const record = new ImportRecord(context);
  const rate = await watchRate(context, plan.fileRate, record);
  let cleanup: string | null;
  try {
    if (!rate.ended) {
      await runSteps(context, plan, results, record, dryRun);
    }
  } finally {
    cleanup = await rate.release();
  }
  // E3, in the order the import met them: the first event that stopped it (for a dry run, whose result is
  // settled only now, a stop during the release included), then a release failure.
  return { steps: results, error: record.error ?? cleanup, cleanup, later: record.later };
}

async function runSteps(context: OperationContext, plan: CurrentPlan, results: StepResult[], record: ImportRecord, dryRun: boolean): Promise<void> {
  // O13: in a dry run nothing is sent, so every earlier step stays a pending change to what later steps check.
  const pending = new PendingEffects();
  const failWith = (index: number, error: unknown, outcome: WriteOutcome): void => {
    const failure = operationFailureOf(error);
    const step = results[index] as StepResult;
    // The operation's own planned value, where it settled one before failing (a live-prerequisite step included).
    const progress = failure?.progress as { planned?: unknown } | null | undefined;
    const planned = progress !== null && progress !== undefined && "planned" in progress ? progress.planned : step.planned;
    results[index] = { ...step, planned, outcome, error: failure?.code ?? "internal_error" };
    // The step keeps its own outcome and code; the record has the import's first cause.
    record.failure(failure?.code ?? "internal_error", failure?.phase ?? "delivery", false);
  };
  for (const [index, step] of plan.steps.entries()) {
    const args = [step.setting, step.target, step.requested] as unknown as WriteArgs;
    // A dry run sends no write, so it checks the stop itself before each step.
    const stop = dryRun ? context.stopping : undefined;
    if (stop !== undefined) {
      return failWith(index, new OperationFailureError({ code: stop, phase: "admission", progress: null }), "not_sent");
    }
    try {
      if (dryRun) {
        const planned = await dryRunSettingAfter(context, pending.affecting(step), ...args);
        results[index] = { ...step, planned: planned.planned, outcome: "not_sent", error: null, unverified: planned.unverified };
        pending.add(step);
      } else {
        const written = await writeSetting(context, ...args);
        results[index] = { ...step, planned: written.planned, outcome: "accepted", error: null, unverified: [] };
      }
    } catch (error) {
      // The failed step keeps its actual outcome (not sent, uncertain, rejected); later steps stay not sent.
      const progress = operationFailureOf(error)?.progress as { outcome?: WriteOutcome } | null | undefined;
      return failWith(index, error, progress?.outcome ?? "not_sent");
    }
  }
  // E3: a stop recorded while the last step was in flight (an interruption, a lock, a lost connection) is the
  // import's first event, the steps keeping their actual outcomes. Otherwise an execution's result is settled
  // here, where its last write was accepted, so nothing met after it — during the release included — is a
  // cause of its failure or beside one. A dry run settles only after the release.
  if (!dryRun) {
    record.settle();
  }
}

/**
 * The prerequisite conditions earlier planned steps can change (O13, K40), by
 * what they affect: an FX bus's type write changes its type and resets Room
 * Size; a Room Size write changes the Reverb Time conversion; an EQ Type
 * write changes the GEQ type; a Limit write changes that side's range, and a
 * Link write copies the Limit to the other side; a Follow USB write changes
 * Follow USB. The set only grows; a later step does not clear it.
 */
class PendingEffects {
  readonly #conditions = new Map<string, Set<UnverifiedCondition>>();

  #mark(key: string, ...conditions: UnverifiedCondition[]): void {
    const set = this.#conditions.get(key) ?? new Set<UnverifiedCondition>();
    for (const condition of conditions) set.add(condition);
    this.#conditions.set(key, set);
  }

  add(step: PlannedStep): void {
    const target = step.target as { bus?: string; side?: string; parameter?: string };
    switch (step.setting) {
      case "bus.fx.type":
        this.#mark(`fx ${target.bus}`, "fx_type_matches", "revx_room_size");
        break;
      case "bus.fx.parameter":
        if (target.parameter === "room-size") this.#mark(`fx ${target.bus}`, "revx_room_size");
        break;
      case "bus.eq.type":
        this.#mark(`geq ${target.bus}`, "geq_type_selected");
        break;
      case "bus.geq.limit":
        this.#mark(`limit ${target.bus} ${target.side}`, "geq_limit_allows_gain");
        break;
      case "bus.geq.link":
        this.#mark(`limit ${target.bus} left`, "geq_limit_allows_gain");
        this.#mark(`limit ${target.bus} right`, "geq_limit_allows_gain");
        break;
      case "device.follow-usb":
        this.#mark("device", "follow_usb_off");
        break;
    }
  }

  affecting(step: PlannedStep): ReadonlySet<UnverifiedCondition> {
    const target = step.target as { bus?: string; side?: string };
    const keys =
      step.setting === "bus.fx.parameter"
        ? [`fx ${target.bus}`]
        : step.setting.startsWith("bus.geq.")
          ? [`geq ${target.bus}`, `limit ${target.bus} ${target.side}`]
          : step.setting === "device.sample-rate"
            ? ["device"]
            : [];
    return new Set(keys.flatMap((key) => [...(this.#conditions.get(key) ?? [])]));
  }
}
