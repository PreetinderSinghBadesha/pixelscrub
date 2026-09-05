import type { Orientation } from './types.js';

/**
 * Orientation parsing only — deliberately not an EXIF library.
 *
 * Drawing to a canvas discards every byte of metadata, including the EXIF
 * orientation tag that phone cameras rely on to display portrait shots the
 * right way up. So before we throw the metadata away we read the one tag we
 * have to honour, by hand, straight off the ArrayBuffer.
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP1 = 0xe1;
const TEM = 0x01;
const RST_FIRST = 0xd0;
const RST_LAST = 0xd7;
const DHT = 0xc4;
const JPG_RESERVED = 0xc8;
const DAC = 0xcc;

const TAG_ORIENTATION = 0x0112;
const TIFF_LITTLE_ENDIAN = 0x4949; // "II"
const TIFF_BIG_ENDIAN = 0x4d4d; // "MM"
const TIFF_MAGIC = 0x002a;

/** "Exif\0\0" — the APP1 payload prefix that marks an EXIF segment. */
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/**
 * EXIF and the frame header both live near the head of a JPEG. We only ever
 * read this much of the source rather than pulling megabytes into memory to
 * find a handful of bytes.
 */
export const HEADER_SCAN_BYTES = 256 * 1024;

interface Segment {
  marker: number;
  payloadAt: number;
  payloadLength: number;
}

/**
 * Walks JPEG marker segments from SOI up to the start of entropy-coded data.
 * Yields nothing at all for input that is not a JPEG.
 */
function* segments(bytes: Uint8Array): Generator<Segment> {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return;

  let offset = 2;
  while (offset + 1 < bytes.length) {
    // Segments may be preceded by any number of 0xFF fill bytes.
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let markerAt = offset;
    while (markerAt + 1 < bytes.length && bytes[markerAt + 1] === 0xff) markerAt += 1;
    const marker = bytes[markerAt + 1];
    if (marker === undefined) return;

    // Standalone markers carry no length field.
    if (marker === TEM || marker === SOI || (marker >= RST_FIRST && marker <= RST_LAST)) {
      offset = markerAt + 2;
      continue;
    }
    // Entropy-coded data starts here; nothing we want lives past it.
    if (marker === SOS || marker === EOI) return;

    const lengthAt = markerAt + 2;
    if (lengthAt + 1 >= bytes.length) return;
    const length = readUint16(bytes, lengthAt, false);
    if (length < 2) return;

    yield { marker, payloadAt: lengthAt + 2, payloadLength: length - 2 };
    offset = lengthAt + length;
  }
}

/**
 * Reads the EXIF orientation tag out of a JPEG.
 *
 * Returns 1 (the no-op orientation) for anything we cannot read: non-JPEG
 * containers, JPEGs with no EXIF, malformed segments, out-of-range values. A
 * missing orientation tag and an upright image are the same thing, so there is
 * nothing here worth throwing over.
 */
export function readOrientation(buffer: ArrayBuffer | Uint8Array): Orientation {
  const bytes = toBytes(buffer);
  for (const segment of segments(bytes)) {
    if (segment.marker !== APP1) continue;
    if (!hasExifHeader(bytes, segment.payloadAt, segment.payloadLength)) continue;
    return readOrientationFromTiff(bytes, segment.payloadAt + EXIF_HEADER.length);
  }
  return 1;
}

/**
 * Reads the dimensions recorded in a JPEG's frame header — the size of the
 * pixel grid as encoded, before any orientation tag is applied.
 *
 * The `<img>` decode fallback needs this: browsers auto-rotate `<img>` elements
 * from EXIF, so comparing `naturalWidth`/`naturalHeight` against these tells us
 * whether the browser has already done the rotation for us.
 *
 * Returns null when the input is not a JPEG or has no frame header in range.
 */
export function readEncodedSize(
  buffer: ArrayBuffer | Uint8Array,
): { width: number; height: number } | null {
  const bytes = toBytes(buffer);
  for (const { marker, payloadAt, payloadLength } of segments(bytes)) {
    if (marker < 0xc0 || marker > 0xcf) continue;
    if (marker === DHT || marker === JPG_RESERVED || marker === DAC) continue;
    if (payloadLength < 5 || payloadAt + 5 > bytes.length) return null;
    const height = readUint16(bytes, payloadAt + 1, false);
    const width = readUint16(bytes, payloadAt + 3, false);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

function hasExifHeader(bytes: Uint8Array, at: number, payloadLength: number): boolean {
  if (payloadLength < EXIF_HEADER.length) return false;
  if (at + EXIF_HEADER.length > bytes.length) return false;
  return EXIF_HEADER.every((byte, i) => bytes[at + i] === byte);
}

/** Reads IFD0 at a TIFF header and pulls tag 0x0112 out of it. */
function readOrientationFromTiff(bytes: Uint8Array, tiffAt: number): Orientation {
  if (tiffAt + 8 > bytes.length) return 1;

  const byteOrder = readUint16(bytes, tiffAt, false);
  let littleEndian: boolean;
  if (byteOrder === TIFF_LITTLE_ENDIAN) littleEndian = true;
  else if (byteOrder === TIFF_BIG_ENDIAN) littleEndian = false;
  else return 1;

  if (readUint16(bytes, tiffAt + 2, littleEndian) !== TIFF_MAGIC) return 1;

  const ifdOffset = readUint32(bytes, tiffAt + 4, littleEndian);
  const ifdAt = tiffAt + ifdOffset;
  if (ifdOffset < 8 || ifdAt + 2 > bytes.length) return 1;

  const entryCount = readUint16(bytes, ifdAt, littleEndian);
  const entriesAt = ifdAt + 2;
  if (entriesAt + entryCount * 12 > bytes.length) return 1;

  for (let i = 0; i < entryCount; i += 1) {
    const entryAt = entriesAt + i * 12;
    if (readUint16(bytes, entryAt, littleEndian) !== TAG_ORIENTATION) continue;
    // Orientation is a SHORT, so it is inlined in the first two bytes of the
    // entry's 4-byte value field.
    const value = readUint16(bytes, entryAt + 8, littleEndian);
    return isOrientation(value) ? value : 1;
  }
  return 1;
}

/**
 * Returns a copy of a JPEG with an EXIF orientation tag spliced in after SOI,
 * replacing nothing and parsing nothing.
 *
 * This exists to build the decoder probe in `canvas.ts`: browsers disagree about
 * whether decoding applies EXIF rotation, and the only reliable way to find out
 * is to hand one an image with a known tag and measure what comes back.
 */
export function withOrientationTag(
  bytes: Uint8Array,
  orientation: Orientation,
): Uint8Array<ArrayBuffer> {
  const tiff = [
    0x4d, 0x4d, // big-endian
    0x00, 0x2a,
    0x00, 0x00, 0x00, 0x08, // IFD0 immediately follows the header
    0x00, 0x01, // one entry
    0x01, 0x12, // Orientation
    0x00, 0x03, // SHORT
    0x00, 0x00, 0x00, 0x01, // count
    0x00, orientation,
    0x00, 0x00, // padding in the value field
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
  const payload = [...EXIF_HEADER, ...tiff];
  const app1 = [0xff, APP1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff];

  const out = new Uint8Array(bytes.length + app1.length + payload.length);
  out.set(bytes.subarray(0, 2), 0); // SOI
  out.set(app1, 2);
  out.set(payload, 2 + app1.length);
  out.set(bytes.subarray(2), 2 + app1.length + payload.length);
  return out;
}

export function isOrientation(value: number): value is Orientation {
  return Number.isInteger(value) && value >= 1 && value <= 8;
}

/** True for the four orientations that put the image on its side. */
export function swapsAxes(orientation: Orientation): boolean {
  return orientation >= 5;
}

function toBytes(buffer: ArrayBuffer | Uint8Array): Uint8Array {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

function readUint16(bytes: Uint8Array, at: number, littleEndian: boolean): number {
  const a = bytes[at];
  const b = bytes[at + 1];
  if (a === undefined || b === undefined) return 0;
  return littleEndian ? a | (b << 8) : (a << 8) | b;
}

function readUint32(bytes: Uint8Array, at: number, littleEndian: boolean): number {
  const a = bytes[at];
  const b = bytes[at + 1];
  const c = bytes[at + 2];
  const d = bytes[at + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return 0;
  return littleEndian
    ? (a | (b << 8) | (c << 16) | (d << 24)) >>> 0
    : ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}
