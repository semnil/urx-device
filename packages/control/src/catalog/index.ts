// Catalog entry point: model capabilities, setting definitions and codecs.
// It must not import the operations entry point or any platform API, so that
// help and completion can load it without a transport (K1).
export { formatI64, isI64Text, isU32, parseI64 } from "./i64.js";
export type { I64Text } from "./i64.js";
export { settingDefinitions, settingIds } from "./settings.js";
export {
  CHANNEL_PARAMS,
  FADER_DB,
  FADER_NEGATIVE_INFINITY_RAW,
  MONO_CHANNELS,
  CHANNEL_COLORS,
  IDENTITY_PARAMS,
  MONO_PAIRS,
  NAME_MAX_CODE_POINTS,
  REC_POINTS,
  REC_POINT_PARAMS,
  STEREO_REC_POINTS,
  PAIR_PARAMS,
  PAN_RANGE,
  STEREO_CHANNELS,
  channelIndex,
} from "./channels.js";
export type { ChannelIndex, ChannelKind } from "./channels.js";
export { decodeInteger, planOnGrid } from "./codecs.js";
export { INPUT_PORTS, SOURCE_PARAMS, portOfRaw } from "./ports.js";
export { DYNAMICS_RULES } from "./dynamics.js";
export type {
  ByBandRule,
  ChannelBandSettingRule,
  ChannelSettingRule,
  ChoiceRule,
  GridRule,
  Sentinel,
  SettingRule,
  StopsRule,
  SwitchRule,
  ValueRule,
  ValueUnit,
} from "./rules.js";
export { EQ_BANDS, EQ_ONE_KNOB_TYPES, EQ_RULES } from "./eq.js";
export { ATTACK_STOPS_RAW, HOLD_STOPS_RAW, RATIO_STOPS_RAW, RELEASE_STOPS_RAW } from "./dynamics-stops.js";
export {
  HPF_FREQUENCY_ID,
  HPF_READ_RAW,
  HPF_WRITE_HZ,
  HPF_WRITE_STOPS_HZ,
  PROCESSING_MODES,
  PROCESSING_MODE_ID,
  PROCESSING_SWITCHES,
} from "./processing.js";
export type { InputPort } from "./ports.js";
export type {
  ChannelSideTarget,
  ChannelTarget,
  ChannelColor,
  ChannelName,
  CompKnee,
  CompRatio,
  ChannelBandTarget,
  EqBand,
  EqBandType,
  EqOneKnobType,
  GateRange,
  ProcessingMode,
  RecPoint,
  FaderLevel,
  PanMode,
  Polarity,
  InputTarget,
  SettingDefinitionBase,
  SettingId,
  SettingTypes,
  SourceTarget,
  WritableSettingId,
} from "./settings.js";
export { decodeCentiDb, decodeSwitch, encodeCentiDb, encodeSwitch, nearestStopIndex, planWholeDb } from "./codecs.js";
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
