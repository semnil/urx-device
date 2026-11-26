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

import type { UrxfFile } from "../catalog/urxf.js";
import type { ConsoleLockGuard } from "../operations/console-lock.js";
import type { OperationContext, WriteGuard } from "../operations/context.js";
import type { OperationCause } from "../operations/failure.js";
import type { ParameterAddress, TransportNotification, TransportOperation, TransportSubscription } from "../operations/transport.js";
import { OperationFailureError, operationFailureOf } from "../operations/failure.js";
import { decodeFileSetting, dryRunSettingAfter, readSetting, writeSetting, type ReadArgs, type WriteArgs } from "../operations/registry.js";
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
  /** The overall failure code, or null when every step was accepted (or planned in a dry-run). */
  readonly error: string | null;
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
  #stop: OperationCause | undefined;

  constructor(context: OperationContext, fileRate: number) {
    this.#context = context;
    this.#fileRate = fileRate;
  }

  get stop(): OperationCause | undefined {
    return this.#stop;
  }

  deliver(notification: TransportNotification): void {
    if (notification.kind === "text" && sameAddress(notification.address, RATE_ADDRESS)) {
      this.latch("invalid_response");
    }
    if (notification.kind !== "numeric" || !sameAddress(notification.address, RATE_ADDRESS)) {
      return;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(notification.value)) {
      this.latch("invalid_response");
    } else if (Number(notification.value) !== this.#fileRate) {
      this.latch("precondition_failed");
    }
  }

  latch(cause: OperationCause): void {
    if (this.#stop === undefined) {
      this.#stop = cause;
      this.#context.cancel(cause);
    }
  }
}

const sameAddress = (a: ParameterAddress, b: ParameterAddress) => a.paramId === b.paramId && a.x === b.x && a.y === b.y;

/**
 * Registers the rate observation, then makes the one rate read (L3, L5):
 * a mismatch is a failed precondition and a missing or invalid file value
 * invalid input, both before any write. The clock is never written from the
 * file. The returned function releases the observation.
 */
async function watchRate(context: OperationContext, file: UrxfFile): Promise<() => Promise<void>> {
  const fileRate = decodeFileSetting(file.current, context.model, ...(["device.sample-rate", {}] as unknown as ReadArgs)) as number;
  const watch = new RateWatch(context, fileRate);
  let operation: TransportOperation;
  try {
    operation = context.transport.createOperation();
  } catch {
    throw new OperationFailureError({ code: "internal_error", phase: "admission", progress: null });
  }
  let subscription: TransportSubscription | undefined;
  const release = async () => {
    try {
      await subscription?.release();
    } finally {
      operation.finish();
    }
  };
  try {
    subscription = context.transport.prepareSubscription([RATE_ADDRESS], operation, (notification) => watch.deliver(notification));
    await subscription.activate();
    context.guardWrites(watch);
    const device = await readSetting(context, "device.sample-rate", {});
    if (device.value !== fileRate) {
      watch.latch("precondition_failed");
    }
    if (watch.stop !== undefined) {
      throw new OperationFailureError({ code: watch.stop, phase: "preparation", progress: null });
    }
  } catch (error) {
    await release();
    throw operationFailureOf(error) === undefined ? new OperationFailureError({ code: "internal_error", phase: "admission", progress: null }) : error;
  }
  return release;
}

/**
 * Applies (or, with `dryRun`, plans with the prerequisite reads) `plan` from
 * `file` as one write operation under `options.guard`, which the caller has
 * opened and releases: its lock read precedes the rate check, a lock stops
 * the unsent steps, and a dry run makes the same reads.
 */
export async function applyCurrent(
  context: OperationContext,
  file: UrxfFile,
  plan: CurrentPlan,
  options: { readonly guard: ConsoleLockGuard; readonly dryRun?: boolean },
): Promise<ApplyResult> {
  const results: StepResult[] = plan.steps.map((step) => ({ ...step, outcome: "not_sent", error: null, unverified: [] }));
  const failWith = (index: number, error: unknown, outcome: WriteOutcome): ApplyResult => {
    const failure = operationFailureOf(error);
    const step = results[index] as StepResult;
    results[index] = { ...step, outcome, error: failure?.code ?? "internal_error" };
    return { steps: results, error: failure?.code ?? "internal_error" };
  };
  let detach: () => void;
  try {
    detach = await options.guard.begin(context);
  } catch (error) {
    return { steps: results, error: operationFailureOf(error)?.code ?? "internal_error" };
  }
  try {
    return await run(context, file, plan, results, failWith, options.dryRun === true);
  } finally {
    detach();
  }
}

async function run(
  context: OperationContext,
  file: UrxfFile,
  plan: CurrentPlan,
  results: StepResult[],
  failWith: (index: number, error: unknown, outcome: WriteOutcome) => ApplyResult,
  dryRun: boolean,
): Promise<ApplyResult> {
  let releaseRate: () => Promise<void>;
  try {
    releaseRate = await watchRate(context, file);
  } catch (error) {
    return { steps: results, error: operationFailureOf(error)?.code ?? "internal_error" };
  }
  try {
    return await runSteps(context, plan, results, failWith, dryRun);
  } finally {
    await releaseRate();
  }
}

async function runSteps(
  context: OperationContext,
  plan: CurrentPlan,
  results: StepResult[],
  failWith: (index: number, error: unknown, outcome: WriteOutcome) => ApplyResult,
  dryRun: boolean,
): Promise<ApplyResult> {
  // O13: in a dry run nothing is sent, so every earlier step stays a pending change to what later steps check.
  const pending = new PendingEffects();
  for (const [index, step] of plan.steps.entries()) {
    const args = [step.setting, step.target, step.requested] as unknown as WriteArgs;
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
  return { steps: results, error: null };
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
