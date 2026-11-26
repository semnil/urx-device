// Device-wide settings (F11-U, F11-H, F11-C) and the Console Lock read
// (F20-L). Built from the catalog rules; the clock writes read Follow USB and
// the recorder state first.

import { DEVICE_RULES } from "../catalog/device.js";
import type { DateFormat, DeviceLanguage, HdmiInputChannels, TimeFormat, UsbSuppression } from "../catalog/settings.js";
import { deviceRuleSetting, readOnly } from "./rules.js";

export const deviceBrightness = deviceRuleSetting<number>(DEVICE_RULES["device.brightness"]);
export const deviceAutoPowerOff = deviceRuleSetting<boolean>(DEVICE_RULES["device.auto-power-off"]);
export const deviceAutoPowerOffTime = deviceRuleSetting<number>(DEVICE_RULES["device.auto-power-off-time"]);
export const deviceLanguage = deviceRuleSetting<DeviceLanguage>(DEVICE_RULES["device.language"]);
export const deviceUsbSuppression = deviceRuleSetting<UsbSuppression>(DEVICE_RULES["device.usb-suppression"]);
export const deviceDateFormat = deviceRuleSetting<DateFormat>(DEVICE_RULES["device.date-format"]);
export const deviceTimeFormat = deviceRuleSetting<TimeFormat>(DEVICE_RULES["device.time-format"]);
export const deviceTimeZoneIndex = deviceRuleSetting<number>(DEVICE_RULES["device.time-zone-index"]);
export const deviceHdmiHdcp = deviceRuleSetting<boolean>(DEVICE_RULES["device.hdmi-hdcp"]);
export const deviceHdmiInputChannels = deviceRuleSetting<HdmiInputChannels>(DEVICE_RULES["device.hdmi-input-channels"]);
export const deviceSampleRate = deviceRuleSetting<number>(DEVICE_RULES["device.sample-rate"]);
export const deviceFollowUsb = deviceRuleSetting<boolean>(DEVICE_RULES["device.follow-usb"]);
/** Read only (F20-L): no plan, write, validation or dry run is exposed. */
export const deviceConsoleLock = readOnly(deviceRuleSetting<boolean>(DEVICE_RULES["device.console-lock"]));
