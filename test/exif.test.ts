import { describe, expect, it } from 'vitest';

import {
  isOrientation,
  readEncodedSize,
  readOrientation,
  swapsAxes,
  withOrientationTag,
} from '../src/exif.js';
import { makeJpeg, makePngBytes } from './helpers/fixtures.js';

describe('readOrientation', () => {
  it('reads every orientation value in both TIFF byte orders', () => {
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(readOrientation(makeJpeg({ orientation, endian: 'MM' }))).toBe(orientation);
      expect(readOrientation(makeJpeg({ orientation, endian: 'II' }))).toBe(orientation);
    }
  });

  it('finds EXIF behind a JFIF segment and stray fill bytes', () => {
    const bytes = makeJpeg({ orientation: 6, withJfif: true, withFillBytes: true });
    expect(readOrientation(bytes)).toBe(6);
  });

  it('accepts an ArrayBuffer as well as a view', () => {
    const bytes = makeJpeg({ orientation: 8 });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(readOrientation(buffer)).toBe(8);
  });

  it('reports upright for a JPEG with no EXIF segment', () => {
    expect(readOrientation(makeJpeg({ withJfif: true }))).toBe(1);
  });

  it('reports upright for containers that are not JPEG', () => {
    expect(readOrientation(makePngBytes())).toBe(1);
    expect(readOrientation(new Uint8Array(0))).toBe(1);
    expect(readOrientation(Uint8Array.from([0x00, 0x01, 0x02, 0x03]))).toBe(1);
  });

  it('reports upright rather than throwing on a truncated EXIF segment', () => {
    const bytes = makeJpeg({ orientation: 6 });
    for (const cut of [4, 8, 12, 16, 20, 24, 30]) {
      expect(() => readOrientation(bytes.slice(0, cut))).not.toThrow();
      expect(readOrientation(bytes.slice(0, cut))).toBe(1);
    }
  });

  it('reports upright for an orientation value outside the defined range', () => {
    expect(readOrientation(makeJpeg({ orientation: 0 }))).toBe(1);
    expect(readOrientation(makeJpeg({ orientation: 9 }))).toBe(1);
    expect(readOrientation(makeJpeg({ orientation: 0xffff }))).toBe(1);
  });

  it('reports upright when the TIFF byte-order mark is corrupt', () => {
    const bytes = makeJpeg({ orientation: 6, endian: 'MM' });
    const exifAt = bytes.indexOf(0x45); // start of "Exif\0\0"
    bytes[exifAt + 6] = 0x58; // clobber the "MM" marker
    bytes[exifAt + 7] = 0x58;
    expect(readOrientation(bytes)).toBe(1);
  });

  it('does not scan into entropy-coded data past the start of scan', () => {
    // An EXIF-looking byte run after SOS is image data, not metadata.
    const head = [...makeJpeg({ width: 10, height: 10 })].slice(0, -2);
    const scan = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
    const trap = [...makeJpeg({ orientation: 6 })].slice(2);
    const bytes = Uint8Array.from([...head, ...scan, ...trap]);
    expect(readOrientation(bytes)).toBe(1);
  });
});

describe('readEncodedSize', () => {
  it('reads the dimensions from the frame header', () => {
    expect(readEncodedSize(makeJpeg({ width: 4032, height: 3024 }))).toEqual({
      width: 4032,
      height: 3024,
    });
  });

  it('reads dimensions as stored, ignoring the orientation tag', () => {
    expect(readEncodedSize(makeJpeg({ width: 4032, height: 3024, orientation: 6 }))).toEqual({
      width: 4032,
      height: 3024,
    });
  });

  it('returns null when there is no frame header to read', () => {
    expect(readEncodedSize(makePngBytes())).toBeNull();
    expect(readEncodedSize(Uint8Array.from([0xff, 0xd8]))).toBeNull();
  });
});

describe('withOrientationTag', () => {
  it('tags a JPEG that had no EXIF at all', () => {
    const plain = makeJpeg({ width: 2, height: 1 });
    expect(readOrientation(plain)).toBe(1);

    const tagged = withOrientationTag(plain, 6);
    expect(readOrientation(tagged)).toBe(6);
  });

  it('leaves the frame header intact so the image still decodes', () => {
    const tagged = withOrientationTag(makeJpeg({ width: 640, height: 480 }), 8);
    expect(readEncodedSize(tagged)).toEqual({ width: 640, height: 480 });
  });

  it('round-trips every orientation it can write', () => {
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      expect(readOrientation(withOrientationTag(makeJpeg(), orientation))).toBe(orientation);
    }
  });
});

describe('orientation helpers', () => {
  it('accepts only the eight defined orientation values', () => {
    expect([0, 9, -1, 1.5, Number.NaN].some(isOrientation)).toBe(false);
    expect([1, 2, 3, 4, 5, 6, 7, 8].every(isOrientation)).toBe(true);
  });

  it('flags exactly the orientations that transpose the axes', () => {
    expect([1, 2, 3, 4].map((value) => swapsAxes(value as 1))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect([5, 6, 7, 8].map((value) => swapsAxes(value as 5))).toEqual([true, true, true, true]);
  });
});
