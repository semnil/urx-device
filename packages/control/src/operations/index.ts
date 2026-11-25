// Operations entry point: semantic operations over a caller-supplied
// transport. It may import the catalog; the catalog never imports it (K1).
export { OperationContext } from "./context.js";
export { OperationFailureError, operationFailureOf } from "./failure.js";
export type { OperationCause, OperationFailure, OperationPhase } from "./failure.js";
export { validateNameRead, validateNumericRead, validatePost, validateTextRead } from "./native.js";
export type * from "./native.js";
export { readSetting, settingHandlers } from "./registry.js";
export type { SettingHandler, SettingHandlers } from "./registry.js";
export type * from "./transport.js";
