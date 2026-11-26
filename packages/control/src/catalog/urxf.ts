// The URX settings file (.urxf) structural parser (F18-F, F18-L), adapted
// from urx-router src/core/control/urxf.ts at ced9c7d2 (MIT License,
// Copyright (c) 2026 semnil; see LICENSE). Parses every chunk body and
// refuses the whole file on any structural fault, before anything is
// applied: no recovery path, no scan for a replacement header.
//
// Endianness alternates by level: record headers and descriptor records are
// big-endian; block headers and every stored value are little-endian. The
// value block is a frameless concatenation walked with its descriptor table.

/** The input bound: a larger file is refused before parsing (F18-L). */
export const URXF_MAX_BYTES = 8 * 1024 * 1024;

const FILE_TAG = "#YAMAHA MBDFProjectFile";
const CHUNK_TAG = "#ChunkData";
const END_TAG = "#END";
const RECORD_HEADER = 36;
const BLOCK_HEADER = 32;
const BLOCK_MAGIC = 10000;
/** Padding between records is NUL bytes up to the next alignment boundary. */
const MAX_PADDING = 4;

const TC_UNSIGNED = 1;
const TC_SIGNED = 2;
const TC_ASCII = 4;

export type UrxfFault =
  | "too_large"
  | "not_urxf"
  | "truncated"
  | "bad_block"
  | "bad_descriptor"
  | "length_mismatch"
  | "duplicate_parameter"
  | "current_count";

/** A refusal to use the file: its fault and where the file stopped making sense. */
export class UrxfError extends Error {
  constructor(
    readonly fault: UrxfFault,
    readonly detail = "",
  ) {
    super(detail === "" ? fault : `${fault}: ${detail}`);
    this.name = "UrxfError";
  }
}

/** One parameter's stored values, one entry per y (ASCII parameters hold strings). */
export type UrxfValues = readonly number[] | readonly string[];

export interface UrxfChunk {
  /** "CURRENT" (the live settings), "SCENE" (a stored scene) or another framed name. */
  readonly name: string;
  readonly label: string;
  /** Parameter ID → values; an x axis is stored flattened onto consecutive IDs (id + x). */
  readonly params: ReadonlyMap<number, UrxfValues>;
}

export interface UrxfFile {
  /** The header's family string ("URX" for every unit): not the saved model (F18-M). */
  readonly family: string;
  readonly chunks: readonly UrxfChunk[];
  /** The one CURRENT chunk. */
  readonly current: UrxfChunk;
}

/** The UTF-8 decoder every supported runtime provides (Node, the webview); not in the ES2022 library types. */
declare const TextDecoder: new () => { decode(input: Uint8Array): string };
const DECODER = new TextDecoder();

/** Parses one byte snapshot: every chunk body, exactly one CURRENT (F18-F). */
export function parseUrxf(bytes: Uint8Array): UrxfFile {
  // Only bytes are a file: anything else is refused with a fault, not a runtime type error.
  if (!(bytes instanceof Uint8Array)) {
    throw new UrxfError("not_urxf", "not a byte array");
  }
  if (bytes.length > URXF_MAX_BYTES) {
    throw new UrxfError("too_large", `${bytes.length} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < RECORD_HEADER) {
    throw new UrxfError("not_urxf", `${bytes.length} bytes`);
  }
  const header = readRecordHeader(view, bytes, 0);
  if (header.tag !== FILE_TAG) {
    throw new UrxfError("not_urxf", header.tag);
  }
  // The family string is read within the header's own extra block only.
  if (header.extraLen < 16) {
    throw new UrxfError("truncated", `header extra ${header.extraLen} < 16`);
  }
  const family = readCString(bytes, RECORD_HEADER, 16);
  const chunks: UrxfChunk[] = [];
  let at = RECORD_HEADER + header.extraLen + header.dataLen;
  let ended = false;
  while (at < bytes.length) {
    const record = readRecordHeader(view, bytes, at);
    if (record.tag === END_TAG) {
      // The terminator declares no extra or body, and the file ends right after its header.
      if (record.extraLen !== 0 || record.dataLen !== 0 || at + RECORD_HEADER !== bytes.length) {
        throw new UrxfError("truncated", `#END at ${at} declares ${record.extraLen}+${record.dataLen} bytes, file ends at ${bytes.length}`);
      }
      ended = true;
      break;
    }
    if (record.tag !== CHUNK_TAG) {
      throw new UrxfError("truncated", `record "${record.tag}" at ${at}`);
    }
    const body = at + RECORD_HEADER + record.extraLen;
    need(bytes, body, record.dataLen, at);
    if (record.extraLen < 68) {
      throw new UrxfError("truncated", `chunk extra ${record.extraLen} < 68 at ${at}`);
    }
    chunks.push({
      name: readCString(bytes, at + 12, 12),
      label: readCString(bytes, at + RECORD_HEADER + 4, 64),
      params: readChunkBody(view, bytes, body, record.dataLen),
    });
    // Resume at the declared outer boundary: a valid opaque remainder inside it is not read.
    at = skipPadding(bytes, body + record.dataLen);
  }
  if (!ended) {
    throw new UrxfError("truncated", "no #END record");
  }
  const currents = chunks.filter((chunk) => chunk.name === "CURRENT");
  if (currents.length !== 1) {
    throw new UrxfError("current_count", `${currents.length} CURRENT chunks`);
  }
  return { family, chunks, current: currents[0] as UrxfChunk };
}

/**
 * The stored value at a parameter address of `chunk` (x flattened onto the
 * ID): a number for a numeric parameter, a string for an ASCII one, or
 * undefined when the chunk does not carry it. Nothing is supplied from
 * another chunk or a default.
 */
export function urxfValue(chunk: UrxfChunk, paramId: number, x: number, y: number): number | string | undefined {
  const values = chunk.params.get(paramId + x);
  return values?.[y];
}

interface RecordHeader {
  readonly tag: string;
  readonly extraLen: number;
  readonly dataLen: number;
}

/** Record header: a 24-byte tag, then three big-endian u32 (the third reserved). */
function readRecordHeader(view: DataView, bytes: Uint8Array, at: number): RecordHeader {
  need(bytes, at, RECORD_HEADER);
  return { tag: readCString(bytes, at, 24), extraLen: view.getUint32(at + 24, false), dataLen: view.getUint32(at + 28, false) };
}

/** A chunk body: the descriptor block, then the value block; bytes after them up to the declared end are an opaque remainder. */
function readChunkBody(view: DataView, bytes: Uint8Array, at: number, length: number): Map<number, UrxfValues> {
  const descriptors = readBlockHeader(view, bytes, at, "F_");
  const values = readBlockHeader(view, bytes, descriptors.payload + descriptors.length, "D_");
  const end = values.payload + values.length;
  if (end > at + length) {
    throw new UrxfError("bad_block", `blocks end at ${end}, chunk at ${at + length}`);
  }
  return readValues(view, bytes, values.payload, values.length, readDescriptors(view, bytes, descriptors.payload, descriptors.length));
}

/** Block header: a 24-byte name, then two little-endian u32 (magic, payload length). */
function readBlockHeader(view: DataView, bytes: Uint8Array, at: number, prefix: string): { payload: number; length: number } {
  need(bytes, at, BLOCK_HEADER);
  const name = readCString(bytes, at, 24);
  if (!name.startsWith(prefix)) {
    throw new UrxfError("bad_block", `expected ${prefix}* at ${at}`);
  }
  if (view.getUint32(at + 24, true) !== BLOCK_MAGIC) {
    throw new UrxfError("bad_block", `bad magic at ${at}`);
  }
  const length = view.getUint32(at + 28, true);
  need(bytes, at + BLOCK_HEADER, length, at);
  return { payload: at + BLOCK_HEADER, length };
}

interface Descriptor {
  readonly id: number;
  readonly typecode: number;
  readonly elemSize: number;
  readonly count: number;
}

/** Descriptors, big-endian: u16 id, u8 flag, u8 typecode, u16 element size, and a u16 count for an array. */
function readDescriptors(view: DataView, bytes: Uint8Array, at: number, length: number): Descriptor[] {
  const table: Descriptor[] = [];
  const end = at + length;
  let cursor = at;
  while (cursor < end) {
    need(bytes, cursor, 6);
    const flag = view.getUint8(cursor + 2);
    if (flag !== 0x00 && flag !== 0x40) {
      throw new UrxfError("bad_descriptor", `flag ${flag} at ${cursor}`);
    }
    const array = flag === 0x40;
    if (array) {
      need(bytes, cursor, 8);
    }
    const id = view.getUint16(cursor, false);
    const elemSize = view.getUint16(cursor + 4, false);
    if (elemSize === 0) {
      throw new UrxfError("bad_descriptor", `element size 0 on parameter ${id}`);
    }
    table.push({ id, typecode: view.getUint8(cursor + 3), elemSize, count: array ? view.getUint16(cursor + 6, false) : 1 });
    cursor += array ? 8 : 6;
  }
  if (cursor !== end) {
    throw new UrxfError("length_mismatch", `descriptors end at ${cursor}, block at ${end}`);
  }
  return table;
}

/** The value block in descriptor order; a repeated parameter ID is refused, even with equal values. */
function readValues(view: DataView, bytes: Uint8Array, at: number, length: number, table: readonly Descriptor[]): Map<number, UrxfValues> {
  const params = new Map<number, UrxfValues>();
  let cursor = at;
  for (const descriptor of table) {
    if (params.has(descriptor.id)) {
      throw new UrxfError("duplicate_parameter", `parameter ${descriptor.id}`);
    }
    const span = descriptor.elemSize * descriptor.count;
    if (cursor + span > at + length) {
      throw new UrxfError("length_mismatch", `parameter ${descriptor.id} overruns the value block`);
    }
    if (descriptor.typecode === TC_ASCII) {
      params.set(
        descriptor.id,
        Array.from({ length: descriptor.count }, (_, i) => readCString(bytes, cursor + i * descriptor.elemSize, descriptor.elemSize)),
      );
    } else if (descriptor.typecode === TC_SIGNED || descriptor.typecode === TC_UNSIGNED) {
      const signed = descriptor.typecode === TC_SIGNED;
      // The width is checked before any element, so an empty array of an illegal width is refused too.
      if (!NUMBER_WIDTHS.includes(descriptor.elemSize)) {
        throw new UrxfError("bad_descriptor", `element size ${descriptor.elemSize} on parameter ${descriptor.id}`);
      }
      params.set(
        descriptor.id,
        Array.from({ length: descriptor.count }, (_, i) => readNumber(view, cursor + i * descriptor.elemSize, descriptor.elemSize, signed)),
      );
    } else {
      throw new UrxfError("bad_descriptor", `typecode ${descriptor.typecode} on parameter ${descriptor.id}`);
    }
    cursor += span;
  }
  if (cursor !== at + length) {
    throw new UrxfError("length_mismatch", `values end at ${cursor}, block at ${at + length}`);
  }
  return params;
}

/** The element widths a numeric parameter may have. */
const NUMBER_WIDTHS: readonly number[] = [1, 2, 4];

function readNumber(view: DataView, at: number, size: number, signed: boolean): number {
  switch (size) {
    case 1:
      return signed ? view.getInt8(at) : view.getUint8(at);
    case 2:
      return signed ? view.getInt16(at, true) : view.getUint16(at, true);
    case 4:
      return signed ? view.getInt32(at, true) : view.getUint32(at, true);
    default:
      throw new UrxfError("bad_descriptor", `element size ${size}`);
  }
}

/** A fixed-width field cut at its first NUL. */
function readCString(bytes: Uint8Array, at: number, width: number): string {
  need(bytes, at, width);
  let end = at;
  while (end < at + width && bytes[end] !== 0) {
    end += 1;
  }
  return DECODER.decode(bytes.subarray(at, end));
}

function skipPadding(bytes: Uint8Array, at: number): number {
  let next = at;
  while (next < bytes.length && next - at < MAX_PADDING && bytes[next] === 0) {
    next += 1;
  }
  return next;
}

function need(bytes: Uint8Array, at: number, length: number, context = at): void {
  if (at < 0 || length < 0 || at + length > bytes.length) {
    throw new UrxfError("truncated", `need ${length} bytes at ${at} (record ${context})`);
  }
}
