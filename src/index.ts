import { computeResizePlan, decodeImage, renderToBlob } from './canvas.js';
import type { ResizeBounds } from './canvas.js';
import { HEADER_SCAN_BYTES, readEncodedSize, readOrientation } from './exif.js';
import { isOutputFormat, replaceExtension, resolveOutputFormat } from './formats.js';
import { PixelScrubError } from './types.js';
import type { Orientation, OutputFormat, SanitizeOptions } from './types.js';

export { PixelScrubError } from './types.js';
export type {
  Orientation,
  OutputFormat,
  PixelScrubErrorCode,
  ResizePlan,
  SanitizeOptions,
} from './types.js';
export { extensionFor, replaceExtension, supportsEncoding } from './formats.js';
export { readOrientation } from './exif.js';

const DEFAULT_QUALITY = 0.85;
const DEFAULT_FORMAT: OutputFormat = 'image/webp';
/** Older iOS Safari silently returns a blank canvas past roughly 4096x4096. */
const DEFAULT_MAX_CANVAS_DIMENSION = 4096;

interface ResolvedOptions extends ResizeBounds {
  quality: number;
  outputFormat: OutputFormat;
}

/**
 * Strips metadata from an image, optionally resizing and re-encoding it, without
 * the bytes ever leaving the browser.
 *
 * The image is decoded, drawn to a canvas and read back out. A canvas holds
 * pixel data and nothing else, so EXIF — GPS coordinates, device model, capture
 * timestamps — is gone by construction rather than by being edited out. The one
 * piece of metadata that carries visual meaning, the orientation tag, is read
 * off the source bytes first and baked into the pixels instead.
 *
 * Resolves to a `File`, not a `Blob`, so it drops straight into existing
 * `FormData` upload code. The name keeps its stem with the extension swapped to
 * match the output format, and `lastModified` is set to now — the original
 * capture time is metadata too.
 *
 * @example
 * const safe = await sanitizeImage(input.files[0], { maxWidth: 1920, quality: 0.8 });
 * body.append('photo', safe);
 */
export async function sanitizeImage(file: File | Blob, options?: SanitizeOptions): Promise<File> {
  assertBlob(file);
  assertImageType(file);

  const resolved = resolveOptions(options);
  const header = await readHeader(file);
  const sourceOrientation = readOrientation(header);
  const encodedSize = readEncodedSize(header);

  const decoded = await decodeImage(file, encodedSize);
  try {
    // A browser that rotated during decode has already done our job for us;
    // applying the transform again would rotate the image twice.
    const orientation: Orientation = decoded.orientationAlreadyApplied ? 1 : sourceOrientation;
    const plan = computeResizePlan(decoded.width, decoded.height, orientation, resolved);
    const format = await resolveOutputFormat(resolved.outputFormat);
    const blob = await renderToBlob(decoded, plan, orientation, format, resolved.quality);

    // The encoder is the authority on what it actually produced: a browser can
    // accept a WebP request and hand back PNG.
    const actualFormat = isOutputFormat(blob.type) ? blob.type : format;
    return new File([blob], outputName(file, actualFormat), {
      type: actualFormat,
      lastModified: Date.now(),
    });
  } finally {
    decoded.release();
  }
}

function assertBlob(file: unknown): asserts file is Blob {
  if (typeof Blob === 'undefined' || !(file instanceof Blob)) {
    throw new PixelScrubError(
      'INVALID_INPUT',
      'sanitizeImage expects a File or Blob, received ' + describe(file) + '.',
    );
  }
}

/**
 * Rejects obvious non-images up front so a PDF or a zip fails fast with a clear
 * message instead of after a decode attempt. A blob with no type at all is let
 * through — plenty of legitimate sources produce those, and the decoder is the
 * real arbiter.
 */
function assertImageType(file: Blob): void {
  if (file.type && !file.type.startsWith('image/')) {
    throw new PixelScrubError(
      'INVALID_INPUT',
      'Expected an image, received a file of type "' + file.type + '".',
    );
  }
  if (file.size === 0) {
    throw new PixelScrubError('INVALID_INPUT', 'Received an empty file.');
  }
}

function resolveOptions(options: SanitizeOptions | undefined): ResolvedOptions {
  return {
    maxWidth: positiveBound(options?.maxWidth, 'maxWidth'),
    maxHeight: positiveBound(options?.maxHeight, 'maxHeight'),
    maxCanvasDimension:
      options?.maxCanvasDimension === undefined
        ? DEFAULT_MAX_CANVAS_DIMENSION
        : positiveBound(options.maxCanvasDimension, 'maxCanvasDimension'),
    quality: resolveQuality(options?.quality),
    outputFormat: resolveFormat(options?.outputFormat),
  };
}

/** An omitted bound means "no limit", which the scale math reads as Infinity. */
function positiveBound(value: number | undefined, name: string): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw new PixelScrubError(
      'INVALID_INPUT',
      name + ' must be a positive number, received ' + describe(value) + '.',
    );
  }
  return value;
}

function resolveQuality(quality: number | undefined): number {
  if (quality === undefined) return DEFAULT_QUALITY;
  if (typeof quality !== 'number' || Number.isNaN(quality)) {
    throw new PixelScrubError(
      'INVALID_INPUT',
      'quality must be a number between 0 and 1, received ' + describe(quality) + '.',
    );
  }
  return Math.min(1, Math.max(0, quality));
}

function resolveFormat(format: OutputFormat | undefined): OutputFormat {
  if (format === undefined) return DEFAULT_FORMAT;
  if (!isOutputFormat(format)) {
    throw new PixelScrubError(
      'INVALID_INPUT',
      'outputFormat must be one of image/webp, image/jpeg or image/png, received ' +
        describe(format) +
        '.',
    );
  }
  return format;
}

/**
 * Pulls just the head of the file. EXIF and the frame header both sit near the
 * start, and a 10MB phone photo has no business being in memory twice.
 */
async function readHeader(file: Blob): Promise<ArrayBuffer> {
  try {
    return await file.slice(0, HEADER_SCAN_BYTES).arrayBuffer();
  } catch {
    // An unreadable head is not fatal: it costs us the orientation tag, not the
    // sanitize pass.
    return new ArrayBuffer(0);
  }
}

function outputName(file: Blob, format: OutputFormat): string {
  const name = typeof File === 'function' && file instanceof File ? file.name : '';
  return replaceExtension(name || 'image', format);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return String(value);
}
