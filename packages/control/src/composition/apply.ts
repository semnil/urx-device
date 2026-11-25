// Executing a CURRENT plan (K36, O11, L3): one device sample-rate read
// compared with the file's before the first write, then each step's own
// operation in order. The first failure stops the unsent steps; accepted
// steps are kept, and nothing is rolled back, retried or read back. A
// dry-run performs the same prerequisite reads and sends no setting write.

import type { UrxfFile } from "../catalog/urxf.js";
import type { OperationContext } from "../operations/context.js";
import { OperationFailureError, operationFailureOf } from "../operations/failure.js";
import { decodeFileSetting, dryRunSetting, readSetting, writeSetting, type ReadArgs, type WriteArgs } from "../operations/registry.js";
import type { WriteOutcome } from "../operations/results.js";
import type { CurrentPlan, PlannedStep } from "./plan.js";

export interface StepResult extends PlannedStep {
  readonly outcome: WriteOutcome;
  /** The failure's code at the step that failed; null elsewhere. */
  readonly error: string | null;
}

export interface ApplyResult {
  readonly steps: readonly StepResult[];
  /** The overall failure code, or null when every step was accepted (or planned in a dry-run). */
  readonly error: string | null;
}

/**
 * The file's sample rate against the device's (L3): a mismatch is a failed
 * precondition and a missing or invalid file value invalid input, both before
 * any write. One read; the clock is never written from the file.
 */
async function checkRate(context: OperationContext, file: UrxfFile): Promise<void> {
  const fileRate = decodeFileSetting(file.current, context.model, ...(["device.sample-rate", {}] as unknown as ReadArgs));
  const device = await readSetting(context, "device.sample-rate", {});
  if (device.value !== fileRate) {
    throw new OperationFailureError({ code: "precondition_failed", phase: "preparation", progress: null });
  }
}

/** Applies (or, with `dryRun`, plans with the prerequisite reads) `plan` from `file`. */
export async function applyCurrent(context: OperationContext, file: UrxfFile, plan: CurrentPlan, options: { dryRun?: boolean } = {}): Promise<ApplyResult> {
  const results: StepResult[] = plan.steps.map((step) => ({ ...step, outcome: "not_sent", error: null }));
  const failWith = (index: number, error: unknown, outcome: WriteOutcome): ApplyResult => {
    const failure = operationFailureOf(error);
    const step = results[index] as StepResult;
    results[index] = { ...step, outcome, error: failure?.code ?? "internal_error" };
    return { steps: results, error: failure?.code ?? "internal_error" };
  };
  try {
    await checkRate(context, file);
  } catch (error) {
    return { steps: results, error: operationFailureOf(error)?.code ?? "internal_error" };
  }
  for (const [index, step] of plan.steps.entries()) {
    const args = [step.setting, step.target, step.requested] as unknown as WriteArgs;
    try {
      if (options.dryRun === true) {
        const planned = await dryRunSetting(context, ...args);
        results[index] = { ...step, planned: planned.planned, outcome: "not_sent", error: null };
      } else {
        const written = await writeSetting(context, ...args);
        results[index] = { ...step, planned: written.planned, outcome: "accepted", error: null };
      }
    } catch (error) {
      // The failed step keeps its actual outcome (not sent, uncertain, rejected); later steps stay not sent.
      const progress = operationFailureOf(error)?.progress as { outcome?: WriteOutcome } | null | undefined;
      return failWith(index, error, progress?.outcome ?? "not_sent");
    }
  }
  return { steps: results, error: null };
}
