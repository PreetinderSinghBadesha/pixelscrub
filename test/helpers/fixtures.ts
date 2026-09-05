/**
 * Hand-built JPEG headers.
 *
 * pixelscrub reads EXIF straight off the bytes, so the fixtures are real bytes:
 * a genuine SOI / APP1 / SOF0 / EOI marker sequence with a genuine TIFF IFD
 * inside it. No entropy-coded scan data — nothing in the library reads past the
 * frame header, and the fake decoder in `fakeCanvas.ts` takes its dimensions
 * from SOF0 exactly like a real decoder would.
 */

export type Endian = 'II' | 'MM';

export interface JpegFixtureOptions {
  width?: number;
  height?: number;
  /** Omit to build a JPEG with no EXIF segment at all. */
  orientation?: number;
  /** TIFF byte order. Canon writes "II", most phones write "MM". */
  endian?: Endian;
  /** Insert a JFIF APP0 segment before APP1, as most encoders do. */
  withJfif?: boolean;
  /** Extra 0xFF fill bytes between segments, which the spec permits. */
  withFillBytes?: boolean;
}

export function makeJpeg(options: JpegFixtureOptions = {}): Uint8Array<ArrayBuffer> {
  const {
    width = 4000,
    height = 3000,
    orientation,
    endian = 'MM',
    withJfif = false,
    withFillBytes = false,
  } = options;

  const parts: number[][] = [[0xff, 0xd8]];
  if (withJfif) parts.push(jfifSegment());
  if (withFillBytes) parts.push([0xff, 0xff]);
  if (orientation !== undefined) parts.push(exifSegment(orientation, endian));
  parts.push(sof0Segment(width, height));
  parts.push([0xff, 0xd9]);

  return Uint8Array.from(parts.flat());
}

export function makeJpegBlob(options: JpegFixtureOptions = {}): Blob {
  return new Blob([makeJpeg(options)], { type: 'image/jpeg' });
}

export function makeJpegFile(name: string, options: JpegFixtureOptions = {}): File {
  return new File([makeJpeg(options)], name, { type: 'image/jpeg', lastModified: 0 });
}

/** A PNG signature followed by junk — a valid image that is not a JPEG. */
export function makePngBytes(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
}

export async function bytesOf(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** True if the bytes carry an APP1 segment with an "Exif\0\0" payload. */
export function containsExifMarker(bytes: Uint8Array<ArrayBuffer>): boolean {
  for (let i = 0; i + 9 < bytes.length; i += 1) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xe1) continue;
    const header = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
    if (header.every((byte, k) => bytes[i + 4 + k] === byte)) return true;
  }
  return false;
}

function jfifSegment(): number[] {
  const payload = [
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version
    0x00, // units
    0x00, 0x01, 0x00, 0x01, // density
    0x00, 0x00, // no thumbnail
  ];
  return [0xff, 0xe0, ...uint16be(payload.length + 2), ...payload];
}

function sof0Segment(width: number, height: number): number[] {
  const payload = [
    0x08, // sample precision
    ...uint16be(height),
    ...uint16be(width),
    0x01, // one component
    0x01, 0x11, 0x00, // component id, sampling factors, quant table
  ];
  return [0xff, 0xc0, ...uint16be(payload.length + 2), ...payload];
}

function exifSegment(orientation: number, endian: Endian): number[] {
  const little = endian === 'II';
  const u16 = (value: number) => (little ? uint16le(value) : uint16be(value));
  const u32 = (value: number) => (little ? uint32le(value) : uint32be(value));

  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(0x002a),
    ...u32(8), // IFD0 sits immediately after the 8-byte TIFF header
    ...u16(1), // one entry
    ...u16(0x0112), // Orientation
    ...u16(3), // SHORT
    ...u32(1), // count
    ...u16(orientation),
    0x00,
    0x00, // SHORT is inlined in the value field, remaining bytes are padding
    ...u32(0), // no next IFD
  ];

  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  return [0xff, 0xe1, ...uint16be(payload.length + 2), ...payload];
}

function uint16be(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function uint16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function uint32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function uint32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}
