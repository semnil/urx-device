// The target models (Confirmed requirements: URX22, URX44, URX44V). A model
// outside this list may still be listed by discovery (D14) but has no
// supported operations.

import { frozen } from "./frozen.js";

export const MODELS = frozen(["URX22", "URX44", "URX44V"] as const);

export type Model = (typeof MODELS)[number];

/**
 * The models on which a write of the representative instance was measured to
 * move its partner instance natively, so that one write is the whole write
 * sequence (F03-G): URX22 at System firmware 1.5.0.1, for the settings that
 * cite this list. URX44 and URX44V are unmeasured.
 */
export const PARTNER_FOLLOWS: readonly Model[] = frozen(["URX22"]);

/** Whether `model` is one of the target models, compared exactly. */
export function isModel(model: string): model is Model {
  return (MODELS as readonly string[]).includes(model);
}
