import type { OutputFormat } from './types.js';

/**
 * Adaptive size compression.
 *
 * The canvas encoder can easily produce output larger than the source —
 * different quality setting, suboptimal PNG encoder, etc. This module tries
 * to beat the source size while keeping quality as high as possible.
 */

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type AnyContext2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** Maximum binary-search iterations before giving up. */
const MAX_ITERATIONS = 6;

// ─── Lossy optimiser (JPEG / WebP) ────────────────────────────────────────────

/**
 * Encodes `canvas` at progressively lower quality until the blob fits inside
 * `targetSize`, or `minQuality` is reached. Returns the best blob it found.
 */
export async function optimizeLossy(
  canvas: AnyCanvas,
  format: OutputFormat,
  initialQuality: number,
  minQuality: number,
  targetSize: number,
): Promise<Blob> {
  let lo = minQuality;
  let hi = initialQuality;
  let best = await canvasToBlob(canvas, format, hi);

  if (best.size <= targetSize) return best;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const attempt = await canvasToBlob(canvas, format, mid);

    if (attempt.size <= targetSize) {
      best = attempt;
      lo = mid; // try higher quality
    } else {
      hi = mid; // try lower quality
    }

    // Close enough — the gap is <1% of the quality range.
    if (hi - lo < 0.01) break;
  }

  // One final attempt at the floor if nothing fit yet.
  if (best.size > targetSize) {
    const floor = await canvasToBlob(canvas, format, minQuality);
    if (floor.size < best.size) best = floor;
  }

  return best;
}

// ─── PNG optimiser (indexed palette) ──────────────────────────────────────────

/**
 * Tries to build a palette PNG from the canvas's pixel data. Returns `null`
 * when the image has more than 256 unique colours or CompressionStream is
 * unavailable — the caller should fall back to the canvas's own PNG encoder.
 */
export async function optimizePng(
  context: AnyContext2D,
  width: number,
  height: number,
  targetSize: number,
): Promise<Blob | null> {
  if (!supportsCompressionStream()) return null;

  let imageData: ImageData;
  try {
    imageData = context.getImageData(0, 0, width, height);
  } catch {
    return null; // tainted canvas or other security restriction
  }

  const { palette, indices } = buildPalette(imageData.data, width * height);
  if (!palette) return null; // > 256 unique colours

  const blob = await encodePalettePng(width, height, palette, indices!);
  return blob.size < targetSize ? blob : null;
}

// ─── Palette builder ──────────────────────────────────────────────────────────

interface PaletteResult {
  /** Null when there are more than 256 unique RGBA tuples. */
  palette: Uint8Array | null;
  indices: Uint8Array | null;
}

/**
 * Scans the raw RGBA pixel buffer. If there are ≤ 256 distinct colours,
 * returns the palette (R,G,B triples) and an index buffer. Otherwise
 * returns nulls so the caller can fall back.
 */
function buildPalette(data: Uint8ClampedArray, pixelCount: number): PaletteResult {
  const colorMap = new Map<number, number>(); // packed RGBA → palette index
  const indices = new Uint8Array(pixelCount);
  let count = 0;

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    const r = data[offset]!;
    const g = data[offset + 1]!;
    const b = data[offset + 2]!;
    const a = data[offset + 3]!;

    // Pack into a single 32-bit key.
    const key = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;

    let index = colorMap.get(key);
    if (index === undefined) {
      if (count >= 256) return { palette: null, indices: null };
      index = count;
      colorMap.set(key, count++);
    }
    indices[i] = index;
  }

  // Build the PLTE chunk data (RGB triples, no alpha).
  const palette = new Uint8Array(count * 3);
  const alphas = new Uint8Array(count);
  let hasAlpha = false;

  for (const [key, index] of colorMap) {
    const a = (key >>> 24) & 0xff;
    const r = (key >>> 16) & 0xff;
    const g = (key >>> 8) & 0xff;
    const b = key & 0xff;
    palette[index * 3] = r;
    palette[index * 3 + 1] = g;
    palette[index * 3 + 2] = b;
    alphas[index] = a;
    if (a !== 255) hasAlpha = true;
  }

  // Stash the alpha data on the palette array so encodePalettePng can find it.
  (palette as PaletteWithAlpha).__alphas = hasAlpha ? alphas : null;
  (palette as PaletteWithAlpha).__count = count;

  return { palette, indices };
}

interface PaletteWithAlpha extends Uint8Array {
  __alphas: Uint8Array | null;
  __count: number;
}

// ─── Minimal PNG encoder ──────────────────────────────────────────────────────

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

async function encodePalettePng(
  width: number,
  height: number,
  palette: Uint8Array,
  indices: Uint8Array,
): Promise<Blob> {
  const info = palette as PaletteWithAlpha;
  const alphas = info.__alphas;
  const colorCount = info.__count;

  const ihdr = makeIHDR(width, height);
  const plte = makeChunk('PLTE', palette.subarray(0, colorCount * 3));
  const trns = alphas ? makeChunk('tRNS', alphas.subarray(0, colorCount)) : new Uint8Array(0);
  const idat = await makeIDAT(indices, width, height);
  const iend = makeChunk('IEND', new Uint8Array(0));

  return new Blob(
    [PNG_SIGNATURE, ihdr, plte, trns, idat, iend] as BlobPart[],
    { type: 'image/png' },
  );
}

function makeIHDR(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = 3; // colour type: indexed
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return makeChunk('IHDR', data);
}

/**
 * Builds the IDAT chunk. Each scanline gets a filter byte (0 = None, which is
 * fine for indexed data), then the palette indices. The whole thing is DEFLATE-
 * compressed via the browser's CompressionStream.
 */
async function makeIDAT(
  indices: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  // Prepend a filter byte (0x00 = None) to each row.
  const raw = new Uint8Array(height * (1 + width));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width);
    raw[rowStart] = 0; // filter: None
    raw.set(indices.subarray(y * width, (y + 1) * width), rowStart + 1);
  }

  const compressed = await deflate(raw);
  return makeChunk('IDAT', compressed);
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const length = data.length;
  const chunk = new Uint8Array(4 + 4 + length + 4); // length + type + data + crc
  const view = new DataView(chunk.buffer);

  view.setUint32(0, length);
  chunk[4] = type.charCodeAt(0);
  chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2);
  chunk[7] = type.charCodeAt(3);
  chunk.set(data, 8);

  // CRC covers type + data.
  const crc = crc32(chunk, 4, 4 + length);
  view.setUint32(8 + length, crc);
  return chunk;
}

// ─── DEFLATE via CompressionStream ────────────────────────────────────────────

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  void writer.write(data as unknown as BufferSource);
  void writer.close();

  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  // PNG uses raw deflate (RFC 1951), but CompressionStream('deflate') produces
  // zlib-wrapped deflate (RFC 1950): 2-byte header + raw deflate + 4-byte Adler32.
  // We need to strip the wrapper.
  const full = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    full.set(chunk, offset);
    offset += chunk.length;
  }

  // Strip zlib header (2 bytes) and Adler-32 checksum (4 bytes).
  return full.subarray(2, full.length - 4);
}

// ─── CRC-32 (PNG uses ISO 3309 / ITU-T V.42) ─────────────────────────────────

let crcTable: Uint32Array | null = null;

function ensureCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  crcTable = table;
  return table;
}

function crc32(buf: Uint8Array, start: number, length: number): number {
  const table = ensureCrcTable();
  let crc = 0xffffffff;
  const end = start + length;
  for (let i = start; i < end; i++) {
    crc = table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── Feature detection ────────────────────────────────────────────────────────

function supportsCompressionStream(): boolean {
  return typeof CompressionStream === 'function';
}

// ─── Shared canvas encoder ────────────────────────────────────────────────────

async function canvasToBlob(
  canvas: AnyCanvas,
  format: OutputFormat,
  quality: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: format, quality });
  }
  const element = canvas as HTMLCanvasElement;
  return new Promise<Blob>((resolve, reject) => {
    element.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('toBlob returned null'));
      },
      format,
      quality,
    );
  });
}
