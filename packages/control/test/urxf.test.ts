import { describe, expect, it } from "vitest";
import { URXF_MAX_BYTES, UrxfError, parseUrxf, urxfValue } from "../src/catalog/urxf.js";
import { operationFailureOf } from "../src/operations/failure.js";
import { decodeFileSetting, type ReadArgs } from "../src/operations/registry.js";

// A synthetic .urxf builder: record headers and descriptors big-endian,
// block headers and values little-endian.
const ascii = (text: string, width: number) => {
  const out = new Uint8Array(width);
  out.set(new TextEncoder().encode(text).subarray(0, width));
  return out;
};
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const be = (value: number, bytes: number) => {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) out[i] = (value >>> (8 * (bytes - 1 - i))) & 0xff;
  return out;
};
const le = (value: number, bytes: number, signed = false) => {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  if (bytes === 1) (signed ? view.setInt8(0, value) : view.setUint8(0, value));
  if (bytes === 2) (signed ? view.setInt16(0, value, true) : view.setUint16(0, value, true));
  if (bytes === 4) (signed ? view.setInt32(0, value, true) : view.setUint32(0, value, true));
  return out;
};
const pad4 = (bytes: Uint8Array) => concat(bytes, new Uint8Array((4 - (bytes.length % 4)) % 4));

function record(tag: Uint8Array, extra: Uint8Array, data: Uint8Array) {
  return pad4(concat(tag, be(extra.length, 4), be(data.length, 4), be(0, 4), extra, data));
}

type Param = { id: number; type: "signed" | "unsigned" | "ascii"; size: number; values: (number | string)[]; array?: boolean };

function body(params: Param[], remainder: Uint8Array = new Uint8Array(0)) {
  const descriptors: Uint8Array[] = [];
  const values: Uint8Array[] = [];
  for (const param of params) {
    const array = param.array ?? param.values.length > 1;
    const typecode = param.type === "ascii" ? 4 : param.type === "signed" ? 2 : 1;
    descriptors.push(concat(be(param.id, 2), Uint8Array.of(array ? 0x40 : 0x00, typecode), be(param.size, 2), array ? be(param.values.length, 2) : new Uint8Array(0)));
    for (const value of param.values) {
      values.push(typeof value === "string" ? ascii(value, param.size) : le(value, param.size, param.type === "signed"));
    }
  }
  const f = concat(...descriptors);
  const d = concat(...values);
  const block = (name: string, payload: Uint8Array) => concat(ascii(name, 24), le(10000, 4), le(payload.length, 4), payload);
  return concat(block("F_PARAM", f), block("D_PARAM", d), remainder);
}

function chunk(name: string, params: Param[], remainder?: Uint8Array) {
  const tag = concat(ascii("#ChunkData", 12), ascii(name, 12));
  return record(tag, concat(be(0, 4), ascii(name === "CURRENT" ? "" : "Scene 1", 64)), body(params, remainder));
}

function file(...chunks: Uint8Array[]) {
  const header = record(ascii("#YAMAHA MBDFProjectFile", 24), concat(ascii("URX", 16)), new Uint8Array(0));
  return concat(header, ...chunks, record(ascii("#END", 24), new Uint8Array(0), new Uint8Array(0)));
}

const CURRENT: Param[] = [
  { id: 139, type: "signed", size: 2, values: [-600, 1000, -32768, 0] },
  { id: 18, type: "ascii", size: 64, values: ["Vocal", "", "Gtr  ", "x"] },
  { id: 140, type: "unsigned", size: 1, values: [1, 0, 1, 1] },
];

function fault(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof UrxfError ? error.fault : String(error);
  }
  return undefined;
}

describe(".urxf structure (F18-F, F18-L, F18-M)", () => {
  it("parse every chunk, the one CURRENT, its parameters per y and the family string", () => {
    const parsed = parseUrxf(file(chunk("SCENE", CURRENT), chunk("CURRENT", CURRENT), chunk("SCENE", CURRENT)));
    expect(parsed.family).toBe("URX");
    expect(parsed.chunks.map((each) => each.name)).toEqual(["SCENE", "CURRENT", "SCENE"]);
    expect(parsed.current.name).toBe("CURRENT");
    expect(urxfValue(parsed.current, 139, 0, 2)).toBe(-32768);
    expect(urxfValue(parsed.current, 18, 0, 2)).toBe("Gtr  ");
    expect(urxfValue(parsed.current, 138, 1, 0)).toBe(-600);
    expect(urxfValue(parsed.current, 999, 0, 0)).toBeUndefined();
  });

  it("refuse the whole file on any structural fault, unused scenes included", () => {
    const remainder = concat(ascii("D_PARAM", 24), ascii("#ChunkData", 12));
    // A valid scene with an opaque remainder inside its declared end still passes.
    expect(() => parseUrxf(file(chunk("SCENE", CURRENT, remainder), chunk("CURRENT", CURRENT)))).not.toThrow();
    expect(fault(() => parseUrxf(file(chunk("SCENE", CURRENT))))).toBe("current_count");
    expect(fault(() => parseUrxf(file(chunk("CURRENT", CURRENT), chunk("CURRENT", CURRENT))))).toBe("current_count");
    const repeated = [...CURRENT, { id: 139, type: "signed" as const, size: 2, values: [-600, 1000, -32768, 0] }];
    expect(fault(() => parseUrxf(file(chunk("SCENE", repeated), chunk("CURRENT", CURRENT))))).toBe("duplicate_parameter");
    const badType = [{ id: 1, type: "signed" as const, size: 3, values: [0] }];
    expect(fault(() => parseUrxf(file(chunk("SCENE", badType), chunk("CURRENT", CURRENT))))).toBe("bad_descriptor");
    const whole = file(chunk("CURRENT", CURRENT));
    expect(fault(() => parseUrxf(whole.subarray(0, whole.length - 36)))).toBe("truncated");
    expect(fault(() => parseUrxf(whole.subarray(0, whole.length - 60)))).toBe("truncated");
    expect(fault(() => parseUrxf(ascii("not a settings file at all", 64)))).toBe("not_urxf");
    expect(fault(() => parseUrxf(new Uint8Array(URXF_MAX_BYTES + 1)))).toBe("too_large");
    // A value block that disagrees with its descriptors.
    const short = file(chunk("CURRENT", CURRENT));
    const corrupt = short.slice();
    const dLength = corrupt.findIndex((_, i) => i > 200 && corrupt[i] === 0x44 && corrupt[i + 1] === 0x5f);
    new DataView(corrupt.buffer).setUint32(dLength + 28, 7, true);
    expect(["length_mismatch", "bad_block", "truncated"]).toContain(fault(() => parseUrxf(corrupt)));
  });

  it("decode CURRENT values with each setting's read codec, strictly", () => {
    const current = parseUrxf(file(chunk("CURRENT", CURRENT))).current;
    const decode = (id: string, target: object, model = "URX44") =>
      decodeFileSetting(current, model, ...([id, target] as unknown as ReadArgs));
    expect([decode("channel.fader", { channel: 1 }), decode("channel.fader", { channel: 2 }), decode("channel.fader", { channel: 3 })]).toEqual([-6, 10, "-inf"]);
    expect(decode("channel.on", { channel: 2 })).toBe(false);
    expect(decode("channel.name", { channel: 3 })).toEqual({ kind: "text", text: "Gtr  " });
    // The destination model interprets the stored position (F18-M): fixed stereo position 0 is CH 3 on URX22.
    const stereo = parseUrxf(file(chunk("CURRENT", [{ id: 266, type: "signed", size: 2, values: [-1200, 0, 0, 0] }]))).current;
    expect(decodeFileSetting(stereo, "URX22", ...(["channel.fader", { channel: 3 }] as unknown as ReadArgs))).toBe(-12);
    expect(decodeFileSetting(stereo, "URX44", ...(["channel.fader", { channel: 5 }] as unknown as ReadArgs))).toBe(-12);
    const refused = (id: string, target: object, chunkParams = CURRENT) =>
      operationFailureOf(
        (() => {
          try {
            decodeFileSetting(parseUrxf(file(chunk("CURRENT", chunkParams))).current, "URX44", ...([id, target] as unknown as ReadArgs));
          } catch (error) {
            return error;
          }
          return undefined;
        })(),
      )?.code;
    expect(refused("channel.pan", { channel: 1 })).toBe("invalid_input");
    expect(refused("channel.fader", { channel: 4 }, [{ id: 139, type: "signed", size: 2, values: [0, 0, 0] }])).toBe("invalid_input");
    expect(refused("channel.fader", { channel: 1 }, [{ id: 139, type: "signed", size: 2, values: [1001, 0, 0, 0] }])).toBe("invalid_input");
    expect(refused("channel.fader", { channel: 1 }, [{ id: 139, type: "ascii", size: 4, values: ["-600", "0", "0", "0"] }])).toBe("invalid_input");
    expect(refused("channel.name", { channel: 1 }, [{ id: 18, type: "unsigned", size: 1, values: [1, 1, 1, 1] }])).toBe("invalid_input");
    expect(refused("channel.fader", { channel: 9 })).toBe("invalid_input");
  });
});

describe("parseUrxf input type", () => {
  it("refuse anything but a byte array as not_urxf, without a runtime type error", () => {
    for (const [index, input] of [[], "file", 42, null, undefined, { length: 40 }, new ArrayBuffer(40)].entries()) {
      let fault: unknown;
      try {
        parseUrxf(input as never);
      } catch (error) {
        fault = error instanceof UrxfError ? error.fault : error;
      }
      expect(fault, `input #${index}`).toBe("not_urxf");
    }
  });
});

describe("parser review fixes (PR #35)", () => {
  const faultOf = (bytes: Uint8Array) => {
    try {
      parseUrxf(bytes);
      return "accepted";
    } catch (error) {
      return error instanceof UrxfError ? error.fault : String(error);
    }
  };
  const endRecord = (extra: Uint8Array, data: Uint8Array) => record(ascii("#END", 24), extra, data);
  const head = () => record(ascii("#YAMAHA MBDFProjectFile", 24), concat(ascii("URX", 16)), new Uint8Array(0));

  it("take #END only empty and at the end of the file", () => {
    const current = chunk("CURRENT", CURRENT);
    expect(faultOf(concat(head(), current, endRecord(new Uint8Array(0), new Uint8Array(0))))).toBe("accepted");
    for (const [label, bytes] of [
      ["END with an extra", concat(head(), current, endRecord(new Uint8Array(4), new Uint8Array(0)))],
      ["END with a body", concat(head(), current, endRecord(new Uint8Array(0), new Uint8Array(4)))],
      ["zero bytes after END", concat(head(), current, endRecord(new Uint8Array(0), new Uint8Array(0)), new Uint8Array(4))],
      ["a second CURRENT after END", concat(head(), current, endRecord(new Uint8Array(0), new Uint8Array(0)), chunk("CURRENT", CURRENT))],
      ["a second END", concat(head(), current, endRecord(new Uint8Array(0), new Uint8Array(0)), endRecord(new Uint8Array(0), new Uint8Array(0)))],
    ] as const) {
      expect(faultOf(bytes), label).toBe("truncated");
    }
  });

  it("refuse an illegal numeric width even with no element", () => {
    for (const type of ["signed", "unsigned"] as const) {
      for (const size of [3, 5, 8]) {
        const bytes = file(chunk("CURRENT", [...CURRENT, { id: 500, type, size, values: [], array: true }]));
        expect(faultOf(bytes), `${type} ${size}`).toBe("bad_descriptor");
      }
      for (const size of [1, 2, 4]) {
        expect(faultOf(file(chunk("CURRENT", [...CURRENT, { id: 500, type, size, values: [], array: true }]))), `${type} ${size}`).toBe("accepted");
      }
    }
  });

  it("decode a file's sample rate, Follow USB and GEQ gain like a device read, with no default", () => {
    const decode = (params: Param[], id: string, target: object, model = "URX44") => {
      try {
        return decodeFileSetting(parseUrxf(file(chunk("CURRENT", params))).current, model, ...([id, target] as unknown as ReadArgs));
      } catch (error) {
        return operationFailureOf(error)?.code;
      }
    };
    expect(decode([{ id: 766, type: "unsigned", size: 4, values: [48000] }], "device.sample-rate", {})).toBe(48000);
    expect(decode([{ id: 766, type: "unsigned", size: 4, values: [32000] }], "device.sample-rate", {})).toBe("invalid_input");
    expect(decode([], "device.sample-rate", {})).toBe("invalid_input");
    expect(decode([{ id: 848, type: "unsigned", size: 1, values: [1] }], "device.follow-usb", {}, "URX22")).toBe(true);
    // MIX 1 band 20 Hz left at 638 y 0; STEREO band 25 Hz left at 545 + x 1 (flattened onto the ID) y 0.
    expect(decode([{ id: 638, type: "signed", size: 2, values: [-250] }], "bus.geq.gain", { bus: "mix-1", side: "left", band: "20" })).toBe(-2.5);
    expect(decode([{ id: 546, type: "signed", size: 2, values: [1475] }], "bus.geq.gain", { bus: "stereo", side: "left", band: "25" })).toBe(14.75);
    expect(decode([{ id: 638, type: "signed", size: 2, values: [1501] }], "bus.geq.gain", { bus: "mix-1", side: "left", band: "20" })).toBe("invalid_input");
    expect(decode([{ id: 638, type: "ascii", size: 4, values: ["x"] }], "bus.geq.gain", { bus: "mix-1", side: "left", band: "20" })).toBe("invalid_input");
  });
});
