// Knob assignments (F12-K): one logical setting of three strings, read and
// written in function → parameter1 → parameter2 order. A read fails whole
// on any component failure (O12); a write keeps the accepted steps, reports
// the failed one and leaves the rest unsent (O11). No pre-read, equality
// skip, bank change or rollback.

import { KNOB_RULES } from "../catalog/integration-panel.js";
import type { KnobAssignment, KnobAssignmentReading } from "../catalog/settings.js";
import type { OperationContext } from "./context.js";
import { OperationFailureError } from "./failure.js";
import type { CompositeReadProgress, CompositeStep, Reading, WritePlan, WriteProgress, WriteResult } from "./results.js";
import { address, modelOf, readTextDecoded, refuse, targetOf, writeText } from "./setting-io.js";

const rule = KNOB_RULES["knob.assignment"];

function slot(model: string, target: unknown): number {
  modelOf(model);
  const own = targetOf<{ bank?: unknown; knob?: unknown }>(target, ["bank", "knob"]);
  const knob = rule.knobs.indexOf(own.knob as (typeof rule.knobs)[number]);
  if (typeof own.bank !== "number" || !Number.isInteger(own.bank) || own.bank < 1 || own.bank > rule.banks || knob < 0) {
    return refuse("invalid_input");
  }
  return (own.bank - 1) * rule.knobs.length + knob;
}

function triple(value: unknown): readonly [string, string, string] {
  const own = targetOf<{ function?: unknown; parameter1?: unknown; parameter2?: unknown }>(value, ["function", "parameter1", "parameter2"]);
  const found = rule.triples.find((each) => each[0] === own.function && each[1] === own.parameter1 && each[2] === own.parameter2);
  return found ?? refuse("invalid_input");
}

/** The validated triple, detached from the caller's object and frozen, with its steps in catalog order. */
function planOf(requested: unknown) {
  const values = triple(requested);
  const value: KnobAssignment = Object.freeze({ function: values[0], parameter1: values[1], parameter2: values[2] }) as KnobAssignment;
  const steps: readonly CompositeStep[] = Object.freeze(
    rule.components.map((component, index) =>
      Object.freeze({ component: component.name, requested: values[index] as string, planned: values[index] as string, outcome: "not_sent" as const }),
    ),
  );
  return { value, values, steps };
}

export const knobAssignment = {
  async read(context: OperationContext, target: unknown): Promise<Reading<KnobAssignmentReading>> {
    const y = slot(context.model, target);
    const components: Record<string, Reading<string>> = {};
    for (const component of rule.components) {
      // Stopped before or between component requests: no component is to blame (O12).
      if (context.stopping !== undefined) {
        throw new OperationFailureError<CompositeReadProgress>({ code: context.stopping, phase: "preparation", progress: { failedComponent: null } });
      }
      try {
        // An actual string each; an empty string is a value. Any failure fails the whole read.
        components[component.name] = await readTextDecoded(context, address(component.paramId, y), (text) => text);
      } catch (error) {
        if (!(error instanceof OperationFailureError)) {
          throw error;
        }
        // The failed component, with the request's own cause; no value read before it is exposed.
        throw new OperationFailureError<CompositeReadProgress>({
          code: error.failure.code,
          phase: error.failure.phase,
          progress: { failedComponent: component.name },
        });
      }
    }
    const value = components as unknown as KnobAssignmentReading;
    return { value, observedAt: value.parameter2.observedAt };
  },
  plan(model: string, target: unknown, requested: KnobAssignment): WritePlan<KnobAssignment> {
    slot(model, target);
    const { value, steps } = planOf(requested);
    return { requested: value, planned: value, steps };
  },
  async write(context: OperationContext, target: unknown, requested: KnobAssignment): Promise<WriteResult<KnobAssignment>> {
    const y = slot(context.model, target);
    // One plan for the whole write: the sent strings, the steps and the results never follow later edits of `requested`.
    const { value, values, steps: planned } = planOf(requested);
    const steps: CompositeStep[] = [...planned];
    for (const [index, component] of rule.components.entries()) {
      try {
        await writeText(context, address(component.paramId, y), values[index] as string, { requested: values[index], planned: values[index] });
        steps[index] = { ...(steps[index] as CompositeStep), outcome: "accepted" };
      } catch (error) {
        if (!(error instanceof OperationFailureError)) {
          throw error;
        }
        const failure = error.failure as { code: never; phase: never; progress: WriteProgress<string> | null };
        const progress = failure.progress;
        steps[index] = {
          ...(steps[index] as CompositeStep),
          outcome: progress?.outcome ?? "uncertain",
          ...(progress?.responseCode === undefined ? {} : { responseCode: progress.responseCode }),
        };
        throw new OperationFailureError<WriteProgress<KnobAssignment>>({
          code: failure.code,
          phase: failure.phase,
          progress: { requested: value, planned: value, outcome: steps[index]?.outcome ?? "uncertain", steps },
        });
      }
    }
    return { requested: value, planned: value, outcome: "accepted", steps };
  },
};
