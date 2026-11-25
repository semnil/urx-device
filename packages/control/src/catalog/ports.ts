// Individual input-port selection (F03-I): the closed port tokens, their raw
// values and model availability. A token names one source lane.

import type { Model } from "./models.js";

const ALL: readonly Model[] = ["URX22", "URX44", "URX44V"];
const LARGER: readonly Model[] = ["URX44", "URX44V"];

interface Port {
  readonly raw: string;
  readonly models: readonly Model[];
}

function ports(): Readonly<Record<string, Port>> {
  const table: Record<string, Port> = { none: { raw: "4294967295", models: ALL } };
  for (let jack = 1; jack <= 4; jack += 1) {
    table[`input-${jack}`] = { raw: `${jack - 1}`, models: jack <= 2 ? ALL : LARGER };
  }
  const pairs: [string, number, readonly Model[]][] = [
    ["aux", 256, ALL],
    ["usb-main-a", 512, ALL],
    ["usb-main-b", 514, ALL],
    ["usb-main-c", 516, ALL],
    ["usb-sub", 576, ALL],
    ["sd-playback", 608, LARGER],
    ["hdmi", 624, ["URX44V"]],
  ];
  for (const [name, left, models] of pairs) {
    table[`${name}-left`] = { raw: `${left}`, models };
    table[`${name}-right`] = { raw: `${left + 1}`, models };
  }
  for (let lane = 1; lane <= 12; lane += 1) {
    table[`usb-daw-${lane}`] = { raw: `${543 + lane}`, models: lane <= 10 ? ALL : LARGER };
  }
  return table;
}

/** Port token to raw value and the models that have it. */
export const INPUT_PORTS: Readonly<Record<string, Port>> = ports();

export type InputPort = string;

/** Parameter IDs of the channel source: mono 22, fixed stereo left 209 / right 210. */
export const SOURCE_PARAMS = { mono: 22, left: 209, right: 210 } as const;

/** The token of a raw value valid on `model`, or undefined. */
export function portOfRaw(model: Model, raw: string): InputPort | undefined {
  for (const [token, port] of Object.entries(INPUT_PORTS)) {
    if (port.raw === raw && port.models.includes(model)) {
      return token;
    }
  }
  return undefined;
}
