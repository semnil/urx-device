// Operations entry point: semantic operations over a caller-supplied
// transport. It may import the catalog; the catalog never imports it (K1).
export { OperationContext } from "./context.js";
export { OperationFailureError, operationFailureOf } from "./failure.js";
export type { OperationCause, OperationFailure, OperationPhase } from "./failure.js";
export { validateNameRead, validateNumericRead, validatePost, validateTextRead } from "./native.js";
export type * from "./native.js";
export { previewSetting, readSetting, settingHandlers, writeSetting } from "./registry.js";
export type { ReadHandler, SettingHandlers, WriteHandler } from "./registry.js";
export type * from "./results.js";
export type * from "./transport.js";
export { validateDeviceList, validateDiscovery, validateLifecycle } from "./lifecycle.js";
export type * from "./lifecycle.js";
