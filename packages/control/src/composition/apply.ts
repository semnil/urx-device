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
  readonly #stops: ImportStops;
  #stop: OperationCause | undefined;

  constructor(context: OperationContext, fileRate: number, stops: ImportStops) {
    this.#context = context;
    this.#fileRate = fileRate;
    this.#stops = stops;
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

  /** The first condition stops the import; each one found after the import stopped is a cause beside the stop. */
  latch(cause: OperationCause): void {
    const stopped = this.#stops.stopped;
    if (this.#stop === undefined) {
      this.#stop = cause;
      this.#context.cancel(cause);
    }
    if (stopped) {
      this.#stops.found(cause, "preparation");
    }
  }
}

/**
 * The import's stops in the order they are found (E3): whether it has stopped
 * — its owner or a guard cancelled it, or a failure ended it — and the first
 * cause found after that, a prerequisite's own failure or a rate condition.
 */
class ImportStops {
  readonly #context: OperationContext;
  #failed = false;
  #later: LaterCause | null = null;

  constructor(context: OperationContext) {
    this.#context = context;
  }

  get stopped(): boolean {
    return this.#failed || this.#context.stopping !== undefined;
  }

  get later(): LaterCause | null {
    return this.#later;
  }

  /** A failure ended the import. */
  fail(): void {
    this.#failed = true;
  }

  /** `code` found at `phase`: the cause beside the stop when the import had already stopped and none was found before it. */
  found(code: OperationCause, phase: OperationPhase): void {
    if (this.stopped && this.#later === null) {
      this.#later = { code, phase };
    }
  }
}

const sameAddress = (a: ParameterAddress, b: ParameterAddress) => a.paramId === b.paramId && a.x === b.x && a.y === b.y;

/** The device sample rate's codec, shared with its read (F11-C). */
const RATE_CODEC = codecOf(DEVICE_RULES["device.sample-rate"].value);

/** An observation's outcome: its first failure, and the release that reports its own failure. */
interface RateObservation {
  readonly error: string | null;
  readonly release: () => Promise<string | null>;
}

/**
 * Registers the rate observation, then makes the one rate read (L3, L5):
 * a mismatch is a failed precondition before any write. The clock is never
 * written from the file. A failure is the operation's first stopping cause
 * where one stopped it; a failure of the observation's own (an admission, a
 * registration or the read that was not the stop's cancellation) found after
 * that stop goes to `stops` beside it. The observation's release is always
 * returned, and reports its own failure instead of replacing an earlier one.
 */
async function watchRate(context: OperationContext, fileRate: number, stops: ImportStops): Promise<RateObservation> {
  const watch = new RateWatch(context, fileRate, stops);
  // A failure of the observation's own; an exception that carries no failure is an internal error.
  const failed = (error: unknown): string => {
    const failure = operationFailureOf(error) ?? { code: "internal_error" as const, phase: "preparation" as const, cancelled: undefined };
    if (failure.cancelled !== true) {
      stops.found(failure.code, failure.phase);
    }
    return context.stopping ?? failure.code;
  };
  let operation: TransportOperation;
  try {
    operation = context.transport.createOperation();
  } catch (error) {
    return { error: failed(error), release: async () => null };
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
    return { error: watch.stop === undefined ? null : (context.stopping ?? watch.stop), release };
  } catch (error) {
    return { error: failed(error), release };
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
  const stops = new ImportStops(context);
  const failWith = (index: number, error: unknown, outcome: WriteOutcome): Outcome => {
    stops.fail();
    const failure = operationFailureOf(error);
    const step = results[index] as StepResult;
    // The operation's own planned value, where it settled one before failing (a live-prerequisite step included).
    const progress = failure?.progress as { planned?: unknown } | null | undefined;
    const planned = progress !== null && progress !== undefined && "planned" in progress ? progress.planned : step.planned;
    results[index] = { ...step, planned, outcome, error: failure?.code ?? "internal_error" };
    // The step keeps its own outcome and code; the overall error is the first cause that stopped the import.
    return { steps: results, error: context.stopping ?? failure?.code ?? "internal_error" };
  };
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
    return await run(context, plan, results, failWith, stops, options.dryRun === true);
  } finally {
    detach();
  }
}

/** The steps and overall error before the observation's release and its later cause are added. */
type Outcome = Omit<ApplyResult, "cleanup" | "later">;

async function run(
  context: OperationContext,
  plan: CurrentPlan,
  results: StepResult[],
  failWith: (index: number, error: unknown, outcome: WriteOutcome) => Outcome,
  stops: ImportStops,
  dryRun: boolean,
): Promise<ApplyResult> {
  const rate = await watchRate(context, plan.fileRate, stops);
  let outcome: Outcome | undefined;
  try {
    if (rate.error !== null) {
      stops.fail();
    }
    outcome = rate.error !== null ? { steps: results, error: rate.error } : await runSteps(context, plan, results, failWith, dryRun);
  } finally {
    const cleanup = await rate.release();
    if (outcome !== undefined) {
      // E3, in processing order: the first failure or stop; for a dry run, whose result is settled only
      // now, a stop recorded during the release; then a release failure.
      const stop = dryRun ? (context.stopping ?? null) : null;
      outcome = { ...outcome, error: outcome.error ?? stop ?? cleanup, cleanup, later: stops.later } as ApplyResult;
    }
  }
  return outcome as ApplyResult;
}

async function runSteps(
  context: OperationContext,
  plan: CurrentPlan,
  results: StepResult[],
  failWith: (index: number, error: unknown, outcome: WriteOutcome) => Outcome,
  dryRun: boolean,
): Promise<Outcome> {
  // O13: in a dry run nothing is sent, so every earlier step stays a pending change to what later steps check.
  const pending = new PendingEffects();
  // A dry run sends no write, so it checks the stop itself before each step.
  const stopped = () => (dryRun ? context.stopping : undefined);
  for (const [index, step] of plan.steps.entries()) {
    const args = [step.setting, step.target, step.requested] as unknown as WriteArgs;
    const stop = stopped();
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
  // overall error, the steps keeping their actual outcomes; a stop after it settled leaves the result as it is.
  return { steps: results, error: context.stopping ?? null };
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
