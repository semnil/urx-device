// Scene references (F14-R) and recorder reads and sources (F16-R): one
// addressed read or write each. No recall, store, transport, song, card or
// track-count write.

import { frozen } from "./frozen.js";
import { sourceLaneRule } from "./output-routing.js";
import type { DeviceSettingRule, SelectorRule, TrackSettingRule } from "./rules.js";

/** User scenes 0…62, Initial Data 32768, presets 32769…32771: the 67 references. */
const SCENE: SelectorRule = {
  kind: "selector",
  known: [],
  choices: [
    { token: "initial", raw: "32768" },
    ...Array.from({ length: 63 }, (_, index) => ({ token: `user-${index + 1}`, raw: `${index}` })),
    ...[1, 2, 3].map((n) => ({ token: `preset-${n}`, raw: `${32768 + n}` })),
  ],
};

const RECORDER = ["URX44", "URX44V"] as const;

const read = (paramId: number, value: DeviceSettingRule["value"], models?: readonly string[]): DeviceSettingRule => ({
  target: "device",
  address: { paramId, y: 0 },
  value,
  ...(models === undefined ? {} : { models }),
});

const channelLanes = ["channel-1", "channel-2", "channel-3", "channel-4", ...[5, 7, 9, 11].flatMap((n) => [`channel-${n}-left`, `channel-${n}-right`])];

export const SCENE_RECORDER_RULES = frozen({
  "scene.current": read(781, SCENE),
  "scene.cursor": read(863, SCENE),
  "recorder.state": read(
    836,
    { kind: "choice", choices: ["stopped", "playing", "playback-paused", "recording", "record-standby", "recording-paused"] },
    RECORDER,
  ),
  "recorder.card-present": read(837, { kind: "switch" }, RECORDER),
  // Raw 1…8 is 2, 4, … 16 tracks.
  "recorder.track-count": read(839, { kind: "grid", unit: "tracks", min: 2, max: 16, scale: 0.5, step: 2 }, RECORDER),
  "recorder.source": {
    target: "track",
    tracks: 16,
    paramId: 736,
    models: RECORDER,
    value: sourceLaneRule(["none", ...channelLanes, ...["stereo", "mix-1", "mix-2"].flatMap((bus) => [`${bus}-left`, `${bus}-right`])]),
  },
} as const satisfies Record<string, DeviceSettingRule | TrackSettingRule>);
