// Catalog entry point: model capabilities, setting definitions and codecs.
// It must not import the operations entry point or any platform API, so that
// help and completion can load it without a transport (K1).
export { formatI64, isI64Text, isU32, parseI64 } from "./i64.js";
export type { I64Text } from "./i64.js";
export { settingDefinitions, settingIds } from "./settings.js";
export type { SettingDefinitionBase, SettingId } from "./settings.js";
export { firmwareStatus, validatedFirmware } from "./firmware.js";
export type { FirmwareStatus } from "./firmware.js";
export { MODELS, isModel } from "./models.js";
export type { Model } from "./models.js";
