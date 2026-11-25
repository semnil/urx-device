// The closed setting registry (K2-B): every catalog setting ID is bound to
// exactly one handler. Stages D6–D15 add catalog rows with their handlers.

import { settingDefinitions, type SettingId } from "../catalog/settings.js";
import type { OperationContext } from "./context.js";
import { OperationFailureError } from "./failure.js";

/** What reading or writing one setting does; types come from its definition. */
export interface SettingHandler<Target, Value> {
  read(context: OperationContext, target: Target): Promise<Value>;
}

/** One handler per setting ID; a missing or extra binding fails type-checking. */
export type SettingHandlers = { [K in SettingId]: SettingHandler<unknown, unknown> };

export const settingHandlers: SettingHandlers = {};

/**
 * Reads `id` for `target` through its handler. An ID outside the catalog,
 * reachable only from untyped input, is `invalid_input` without traffic.
 */
export function readSetting(context: OperationContext, id: SettingId, target: unknown): Promise<unknown> {
  if (!Object.hasOwn(settingDefinitions, id)) {
    return Promise.reject(new OperationFailureError({ code: "invalid_input", phase: "preparation", progress: null }));
  }
  const handler: SettingHandler<unknown, unknown> = settingHandlers[id];
  return handler.read(context, target);
}
