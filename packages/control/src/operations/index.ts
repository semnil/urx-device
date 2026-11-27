// Operations entry point: semantic operations over a caller-supplied
// transport. It may import the catalog; the catalog never imports it (K1).
export { CONSOLE_LOCK_ADDRESS, ConsoleLockGuard } from "./console-lock.js";
export { OperationContext } from "./context.js";
export type { WriteGuard } from "./context.js";
export { marksOf, OperationFailureError, operationFailureOf } from "./failure.js";
export type { LaterCause, OperationCause, OperationFailure, OperationPhase } from "./failure.js";
export { validateNameRead, validateNumericRead, validatePost, validateTextRead } from "./native.js";
export type * from "./native.js";
export { decodeFileSetting, dryRunSetting, dryRunSettingAfter, previewSetting, readSetting, settingHandlers, validateSetting, writeSetting } from "./registry.js";
export type { DecimalWriteArgs, ReadHandler, SettingHandlers, WriteHandler } from "./registry.js";
export type * from "./results.js";
export type * from "./transport.js";
export { validateDeviceList, validateDiscovery, validateLifecycle } from "./lifecycle.js";
export type * from "./lifecycle.js";
export { PLAN_ITEM_LIMIT, planCurrent } from "../composition/plan.js";
export type { CurrentPlan, Omission, PlannedStep } from "../composition/plan.js";
export { applyCurrent } from "../composition/apply.js";
export type { ApplyResult, StepResult } from "../composition/apply.js";
export { EXCLUDED, PHASES } from "../composition/coverage.js";
export type { OmissionReason } from "../composition/coverage.js";
