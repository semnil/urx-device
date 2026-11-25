// Device-wide settings (F11-U utilities, F11-H HDMI, F11-C clock, F20-L
// Console Lock read): one addressed read or write each, at (id, 0, 0). A model
// without a field is unsupported before any request.

import { frozen } from "./frozen.js";
import type { DeviceSettingRule, WritePrerequisite } from "./rules.js";

const URX44S = ["URX44", "URX44V"] as const;
const ALL = ["URX22", "URX44", "URX44V"] as const;

const device = (paramId: number, value: DeviceSettingRule["value"], models?: readonly string[]): DeviceSettingRule => ({
  target: "device",
  address: { paramId, y: 0 },
  value,
  ...(models === undefined ? {} : { models }),
});

/** Follow USB (848) must be off: raw 0 allows, 1 refuses. */
const FOLLOW_USB_OFF: WritePrerequisite = { paramId: 848, y: 0, models: ALL, allowed: ["0"], refused: ["1"] };
/** The recorder (836, URX44/V) must be stopped: raw 0 allows, 1…5 refuse. */
const RECORDER_STOPPED: WritePrerequisite = { paramId: 836, y: 0, models: URX44S, allowed: ["0"], refused: ["1", "2", "3", "4", "5"] };

export const DEVICE_RULES = frozen({
  "device.brightness": device(758, { kind: "grid", unit: null, min: 0, max: 10, scale: 1 }),
  "device.auto-power-off": device(760, { kind: "switch" }),
  "device.auto-power-off-time": device(761, { kind: "grid", unit: "min", min: 2, max: 20, scale: 1 }),
  "device.language": device(795, { kind: "choice", choices: ["en", "ja", "zh-cn"] }),
  "device.usb-suppression": device(812, { kind: "choice", choices: ["none", "2-channels"] }),
  "device.date-format": device(787, { kind: "choice", choices: ["mm/dd/yyyy", "dd/mm/yyyy", "yyyy/mm/dd"] }, URX44S),
  "device.time-format": device(788, { kind: "choice", choices: ["24h", "12h"] }, URX44S),
  // The device's own index; no city or UTC offset is implied.
  "device.time-zone-index": device(831, { kind: "grid", unit: null, min: 0, max: 153, scale: 1 }, URX44S),
  "device.hdmi-hdcp": device(767, { kind: "switch" }, ["URX44V"]),
  "device.hdmi-input-channels": device(768, { kind: "choice", choices: ["2-channels", "multi-channels"] }, ["URX44V"]),
  "device.sample-rate": {
    ...device(766, { kind: "numeric-set", unit: "Hz", values: [44100, 48000, 88200, 96000, 176400, 192000] }),
    writePrerequisites: [FOLLOW_USB_OFF, RECORDER_STOPPED],
  },
  "device.follow-usb": { ...device(848, { kind: "switch" }), writePrerequisites: [RECORDER_STOPPED] },
  // Read only: no set, unlock or password operation.
  "device.console-lock": device(895, { kind: "switch" }),
} as const satisfies Record<string, DeviceSettingRule>);
