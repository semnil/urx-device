// Scene references (F14-R) and recorder reads and sources (F16-R). Built from
// the catalog rules.

import { SCENE_RECORDER_RULES } from "../catalog/scene-recorder.js";
import type { RecorderState } from "../catalog/settings.js";
import { deviceRuleSetting, trackRuleSetting } from "./rules.js";

const rules = SCENE_RECORDER_RULES;

export const sceneCurrent = deviceRuleSetting<string>(rules["scene.current"]);
export const sceneCursor = deviceRuleSetting<string>(rules["scene.cursor"]);
export const recorderState = deviceRuleSetting<RecorderState>(rules["recorder.state"]);
export const recorderCardPresent = deviceRuleSetting<boolean>(rules["recorder.card-present"]);
export const recorderTrackCount = deviceRuleSetting<number>(rules["recorder.track-count"]);
export const recorderSource = trackRuleSetting<string>(rules["recorder.source"]);
