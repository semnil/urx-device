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
export { BASIC_RULES } from "./basic-rules.js";
export { DUCKER_RULES } from "./ducker.js";
export { SEND_RULES } from "./sends.js";
export { BUS_RULES, BUS_TOKENS, CHANNEL_STEREO_ASSIGN_RULE } from "./buses.js";
export { INSERT_FX_EFFECTS, INSERT_FX_RULES } from "./insert-fx.js";
export { FX_RETURN_EFFECTS, FX_RETURN_RULES } from "./fx-return.js";
export { GEQ_BANDS, OUTPUT_EQ_RULES } from "./output-eq.js";
export { OUTPUT_PEQ_RULES } from "./output-peq.js";
export { CUE_RULES, MONITOR_RULES, OUTPUT_SOURCE_RULES, OUTPUT_TOKENS, STREAM_DELAY_RULES } from "./output-routing.js";
export { OSCILLATOR_RULES } from "./oscillator.js";
export { DEVICE_RULES } from "./device.js";
export { INTEGRATION_RULES, KNOB_RULES } from "./integration-panel.js";
export { SCENE_RECORDER_RULES } from "./scene-recorder.js";
export {
  LEVEL_TAPS,
  METER_BUSES,
  METER_PROCESSORS,
  busLevelPoint,
  channelLevelPoint,
  channelReductionPoint,
  decodeMeterLevel,
  decodeMeterReduction,
  engineReductionPoint,
  pointLevel,
} from "./meters.js";
export type { MeterAddress, MeterLevel, MeterPoint, MeterRefusal } from "./meters.js";
export {
  FX2_FREQUENCY_DECIHZ,
  INITIAL_DELAY_DECIMS,
  REV_R3_TIME_DECISECONDS,
  REVX_FREQUENCY_HZ,
  REVX_TIME_MS,
} from "./fx-return-tables.js";
export { DYNAMICS_RULES } from "./dynamics.js";
export type {
  ByBandRule,
  ByKindRule,
  ChannelSideSettingRule,
  InputSettingRule,
  PairSettingRule,
  SourceSettingRule,
  ChannelBandSettingRule,
  ChannelSettingRule,
  ChoiceRule,
  GridRule,
  PortChoiceRule,
  SendRoute,
  BusSettingRule,
  NameRule,
  SelectorRule,
  ContextStopsRule,
  FxEffectRule,
  FxParameterRule,
  BusBandSettingRule,
  OutputSideSettingRule,
  OutputSettingRule,
  DeviceSettingRule,
  NumericSetRule,
  FlagRule,
  KnobAssignmentRule,
  TrackSettingRule,
  WritePrerequisite,
  BusSideAddress,
  BusSideSettingRule,
  GeqGainRule,
  SendSettingRule,
  Sentinel,
  SettingRule,
  StopsRule,
  SwitchRule,
  TextIndexRule,
  ValueRule,
  ValueUnit,
} from "./rules.js";
export { EQ_BANDS, EQ_ONE_KNOB_TYPES, EQ_RULES } from "./eq.js";
export {
  SSMCS_BANDS,
  SSMCS_FREQUENCY_STEPS_DECIHZ,
  SSMCS_PRESET_LABELS,
  SSMCS_Q_STEPS_CENTI,
  SSMCS_RULES,
} from "./ssmcs.js";
export {
  ATTACK_STOPS_RAW,
  DUCKER_DECAY_STOPS_RAW,
  HOLD_STOPS_RAW,
  RATIO_STOPS_RAW,
  RELEASE_STOPS_RAW,
} from "./dynamics-stops.js";
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
  ChannelSsmcsBandTarget,
  SsmcsBand,
  SendTap,
  BusTarget,
  BusType,
  InsertFxType,
  FxParameterTarget,
  FxParameterValue,
  FxReturnType,
  BusBandTarget,
  OutputSideTarget,
  OutputTarget,
  DeviceTarget,
  CueMode,
  OscillatorAssignTarget,
  OscillatorMode,
  DateFormat,
  KnobAssignment,
  KnobAssignmentReading,
  KnobTarget,
  SendsTarget,
  RecorderState,
  TrackTarget,
  DeviceLanguage,
  HdmiInputChannels,
  TimeFormat,
  UsbSuppression,
  BusSideBandTarget,
  BusSideTarget,
  GeqLimit,
  GeqLink,
  OutputEqType,
  SendTarget,
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
export { URXF_MAX_BYTES, UrxfError, parseUrxf, urxfValue } from "./urxf.js";
export type { UrxfChunk, UrxfFault, UrxfFile, UrxfValues } from "./urxf.js";
