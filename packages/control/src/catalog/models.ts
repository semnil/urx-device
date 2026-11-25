// The target models (Confirmed requirements: URX22, URX44, URX44V). A model
// outside this list may still be listed by discovery (D14) but has no
// supported operations.

export const MODELS = ["URX22", "URX44", "URX44V"] as const;

export type Model = (typeof MODELS)[number];

/** Whether `model` is one of the target models, compared exactly. */
export function isModel(model: string): model is Model {
  return (MODELS as readonly string[]).includes(model);
}
