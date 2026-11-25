import { describe, expect, it } from "vitest";
import { settingDefinitions, settingIds, type SettingId } from "../src/catalog/settings.js";
import { OperationContext } from "../src/operations/context.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { readSetting, settingHandlers } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

describe("setting registry (K2)", () => {
  it("binds exactly the catalog's setting IDs", () => {
    expect(Object.keys(settingHandlers).sort()).toEqual(settingIds().sort());
    expect(settingIds()).toEqual(Object.keys(settingDefinitions));
  });

  it("refuses an ID outside the catalog without traffic", async () => {
    const transport = new FakeTransport();
    const context = new OperationContext(transport, "URX44");
    const error = await readSetting(context, "no.such.setting" as SettingId, {}).catch((caught: unknown) => caught);
    expect(operationFailureOf(error)).toEqual({ code: "invalid_input", phase: "preparation", progress: null });
    expect(transport.calls).toEqual([]);
  });
});
