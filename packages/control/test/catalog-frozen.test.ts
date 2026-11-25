import { describe, expect, it } from "vitest";
import * as catalog from "../src/catalog/index.js";
import { DYNAMICS_RULES } from "../src/catalog/dynamics.js";
import { settingDefinitions } from "../src/catalog/settings.js";
import { OperationContext } from "../src/operations/context.js";
import { readSetting } from "../src/operations/registry.js";
import { FakeTransport } from "./fake-transport.js";

/** Paths of the objects and arrays under `value` that are not frozen. */
function unfrozen(value: unknown, path: string, seen = new Set<unknown>()): string[] {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return [];
  }
  seen.add(value);
  const own = Object.isFrozen(value) ? [] : [path];
  return [
    ...own,
    ...Reflect.ownKeys(value).flatMap((key) => unfrozen((value as Record<PropertyKey, unknown>)[key], `${path}.${String(key)}`, seen)),
  ];
}

describe("catalog immutability", () => {
  it("freeze every exported catalog value to the last nested object", () => {
    const exported = Object.entries(catalog).filter(([, value]) => typeof value === "object" && value !== null);
    expect(exported.length).toBeGreaterThan(20);
    expect(exported.flatMap(([name, value]) => unfrozen(value, name))).toEqual([]);
  });

  it("keep reads unchanged after a consumer tries to edit a rule", async () => {
    const rule = settingDefinitions["channel.comp.gain"].rule;
    expect(() => {
      (rule.address as { mono: number }).mono = 36;
    }).toThrow(TypeError);
    expect(() => (DYNAMICS_RULES["channel.gate.attack"].value.stops as number[]).reverse()).toThrow(TypeError);
    expect(() => {
      (settingDefinitions as Record<string, unknown>)["channel.comp.gain"] = settingDefinitions["channel.comp.ratio"];
    }).toThrow(TypeError);
    const transport = new FakeTransport().script("getNumeric", { kind: "success", value: "706", evidence: { state: "read" } });
    expect((await readSetting(new OperationContext(transport, "URX44"), "channel.comp.gain", { channel: 1 })).value).toBe(7.06);
    expect(transport.calls[0]?.address.paramId).toBe(38);
    const typeChecks = () => {
      // @ts-expect-error a rule's address is read-only
      DYNAMICS_RULES["channel.comp.gain"].address.mono = 36;
      // @ts-expect-error a rule's value is read-only
      settingDefinitions["channel.gate.range"].rule.value.sentinel = { value: "x", raw: "0" };
    };
    expect(typeof typeChecks).toBe("function");
  });
});
