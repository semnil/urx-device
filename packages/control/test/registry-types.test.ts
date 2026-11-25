import { describe, expect, it } from "vitest";
import {
  settingDefinitions,
  type ChannelTarget,
  type InputTarget,
  type SettingId,
  type SettingTypes,
  type SourceTarget,
} from "../src/catalog/settings.js";
import { OperationContext } from "../src/operations/context.js";
import { previewSetting, readSetting, writeSetting, type ReadArgs } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

// Type-level checks: each line marked @ts-expect-error must fail to compile.
type ChannelId = {
  [K in SettingId]: SettingTypes[K]["target"] extends ChannelTarget ? (ChannelTarget extends SettingTypes[K]["target"] ? K : never) : never;
}[SettingId];
const channelIds = Object.keys(settingDefinitions).filter((id) => id.startsWith("channel.")) as ChannelId[];

describe("registry argument types", () => {
  it("bind each ID to its own target and value", () => {
    const context = new OperationContext(new FakeTransport(), "URX44");
    const id = "input.gain" as "input.gain" | "source.gain";
    const input: InputTarget | SourceTarget = { input: 1 };
    const checks = () => {
      // @ts-expect-error a union of IDs with a union of targets
      void readSetting(context, id, input);
      // @ts-expect-error a source target for a physical input setting
      void readSetting(context, "input.gain", { source: "aux" });
      // @ts-expect-error a number for a switch
      void writeSetting(context, "input.phantom", { input: 1 }, 3);
      // @ts-expect-error a boolean for a gain
      void previewSetting("URX44", "input.gain", { input: 1 }, true);
      // @ts-expect-error a read-only setting cannot be written
      void writeSetting(context, "input.clip-safe-active", { input: 1 }, true);
      const pair: ReadArgs = Math.random() > 2 ? ["input.gain", { input: 1 }] : ["source.gain", { source: "aux" }];
      void readSetting(context, ...pair);
      const gain: Promise<{ value: number }> = readSetting(context, "input.gain", { input: 1 });
      void gain;
      // A queue mixing the name (string input) with the color keeps string results.
      const edit = Math.random() > 2 ? (["channel.name", { channel: 1 }, "Lead"] as const) : (["channel.color", { channel: 1 }, "red"] as const);
      const planned: string = previewSetting("URX44", ...edit).planned;
      const written: Promise<{ planned: string }> = writeSetting(context, ...edit);
      void planned;
      void written;
      // @ts-expect-error a read-side name object is not a write value
      void writeSetting(context, "channel.name", { channel: 1 }, { kind: "text", text: "Lead" });
      // Every channel-target ID from the catalog list, read alike, however many there are.
      for (const each of channelIds) {
        void readSetting(context, each, { channel: 1 });
      }
      const levels = "channel.gate.threshold" as "channel.gate.threshold" | "channel.comp.gain" | "channel.fader";
      const level: Promise<{ planned: number | "-inf" }> = writeSetting(context, levels, { channel: 1 }, -3);
      void level;
      void previewSetting("URX44", levels, { channel: 1 }, -3);
      const withInput = "channel.on" as "channel.on" | "input.phantom";
      // @ts-expect-error a channel target is not an input target
      void readSetting(context, withInput, { channel: 1 });
      // @ts-expect-error "-inf" is not a value every ID of the group takes
      void writeSetting(context, levels, { channel: 1 }, "-inf");
      // Values of a union type every ID of the group takes: both booleans, a level or "-inf".
      const switches = "channel.on" as "channel.on" | "channel.gate.on";
      void writeSetting(context, switches, { channel: 1 }, Math.random() > 0.5);
      const floors = "channel.fader" as "channel.fader" | "channel.gate.range";
      void previewSetting("URX44", floors, { channel: 1 }, "-inf");
      void writeSetting(context, floors, { channel: 1 }, -12);
      // An adapter forwarding the published parameter types takes every valid call.
      const reads = (...[on, ...args]: Parameters<typeof readSetting>) => readSetting(on, ...args);
      const writes = (...[on, ...args]: Parameters<typeof writeSetting>) => writeSetting(on, ...args);
      const previews = (...[model, ...args]: Parameters<typeof previewSetting>) => previewSetting(model, ...args);
      void reads(context, "input.gain", { input: 1 });
      for (const each of channelIds) {
        void reads(context, each, { channel: 1 });
      }
      void writes(context, "input.phantom", { input: 1 }, true);
      void previews("URX44", "channel.fader", { channel: 1 }, "-inf");
      void writes(context, switches, { channel: 1 }, false);
      // @ts-expect-error the forwarded types keep each ID's own target
      void reads(context, "input.gain", { channel: 1 });
      // @ts-expect-error the forwarded types keep each ID's own value
      void writes(context, "input.phantom", { input: 1 }, 3);
      // A pair whose ID is the union of the channel settings.
      const wide = [channelIds[0] as ChannelId, { channel: 1 }] as [id: ChannelId, target: ChannelTarget];
      void readSetting(context, ...wide);
      const edits =
        Math.random() > 2
          ? (["input.phantom", { input: 1 }, true] as ["input.phantom", InputTarget, boolean])
          : (["channel.fader", { channel: 1 }, -3] as ["channel.fader", ChannelTarget, number | "-inf"]);
      void writeSetting(context, ...edits);
      void previewSetting("URX44", ...edits);
      // @ts-expect-error a forwarded preview keeps the value type
      void previews("URX44", "channel.fader", { channel: 1 }, true);
      const mixed = "input.gain" as "input.gain" | "channel.fader";
      // @ts-expect-error a selector uncorrelated with the target
      void readSetting(context, mixed, { channel: 1 });
    };
    expect(typeof checks).toBe("function");
  });
});
