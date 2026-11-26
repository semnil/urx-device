// Scene references (F14-R) and recorder reads and sources (F16-R). The scene
// and recorder reads are read only and expose no write path. Built from the
// catalog rules.

import { SCENE_RECORDER_RULES } from "../catalog/scene-recorder.js";
import type { RecorderState } from "../catalog/settings.js";
import { deviceRuleSetting, readOnly, trackRuleSetting } from "./rules.js";

const rules = SCENE_RECORDER_RULES;

export const sceneCurrent = readOnly(deviceRuleSetting<string>(rules["scene.current"]));
export const sceneCursor = readOnly(deviceRuleSetting<string>(rules["scene.cursor"]));
export const recorderState = readOnly(deviceRuleSetting<RecorderState>(rules["recorder.state"]));
export const recorderCardPresent = readOnly(deviceRuleSetting<boolean>(rules["recorder.card-present"]));
export const recorderTrackCount = readOnly(deviceRuleSetting<number>(rules["recorder.track-count"]));
export const recorderSource = trackRuleSetting<string>(rules["recorder.source"]);
