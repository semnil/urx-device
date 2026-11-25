// Catalog entry point: model capabilities, setting definitions and codecs.
// It must not import the operations entry point or any platform API, so that
// help and completion can load it without a transport (K1).
export { formatI64, isI64Text, isU32, parseI64 } from "./i64.js";
export type { I64Text } from "./i64.js";
export { settingDefinitions, settingIds } from "./settings.js";
export type {
  InputTarget,
  SettingDefinitionBase,
  SettingId,
  SettingTypes,
  SourceTarget,
  WritableSettingId,
} from "./settings.js";
export { decodeCentiDb, decodeSwitch, encodeCentiDb, encodeSwitch, planWholeDb } from "./codecs.js";
export {
  HI_Z_JACKS,
  INPUT_GAIN_DB,
  INPUT_JACKS,
  INPUT_PARAMS,
  SOURCE_GAIN,
  SOURCE_GAIN_DB,
  SOURCE_TOKENS,
  isSourceToken,
} from "./inputs.js";
export type { SourceGainAddress, SourceToken } from "./inputs.js";
export { firmwareStatus, validatedFirmware } from "./firmware.js";
export type { FirmwareStatus } from "./firmware.js";
export { MODELS, isModel } from "./models.js";
export type { Model } from "./models.js";
