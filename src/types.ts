/** Output container formats pixelscrub can encode to. */
export type OutputFormat = 'image/webp' | 'image/jpeg' | 'image/png';

/** The eight EXIF orientation values defined by the TIFF spec. */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface SanitizeOptions {
  /** Maximum output width in CSS pixels. Default: no limit. */
  maxWidth?: number;
  /** Maximum output height in CSS pixels. Default: no limit. */
  maxHeight?: number;
  /** Encoder quality, 0-1. Ignored for `image/png`. Default: 0.85. */
  quality?: number;
  /** Container to encode to. Default: `image/webp`, falling back to JPEG where unsupported. */
  outputFormat?: OutputFormat;
  /**
   * Hard ceiling on either canvas dimension, applied after `maxWidth`/`maxHeight`.
   * Older iOS Safari refuses to rasterise canvases above roughly 4096x4096 and
   * silently returns a blank image, so we clamp before drawing. Default: 4096.
   */
  maxCanvasDimension?: number;
}

export interface SanitizeBatchOptions extends SanitizeOptions {
  /**
   * How many images to process at once. Default: 4.
   *
   * Decoding is the memory-hungry step — a 12MP photo is roughly 48MB as RGBA
   * before any scratch canvases — so this is a memory ceiling more than a speed
   * dial. Lower it if you are sanitizing very large images on phones.
   */
  concurrency?: number;
  /** Cancels the run. Already-finished results are discarded; see `onProgress`. */
  signal?: AbortSignal;
  /** Called as each image settles, in completion order. */
  onProgress?: (progress: BatchProgress) => void;
}

/** The outcome of one image in a batch, mirroring `Promise.allSettled`. */
export type BatchResult =
  | { status: 'fulfilled'; index: number; input: File | Blob; file: File }
  | { status: 'rejected'; index: number; input: File | Blob; reason: Error };

export interface BatchProgress {
  /** How many images have settled, successfully or not. */
  completed: number;
  total: number;
  /** The result that just settled. */
  result: BatchResult;
}

export type PixelScrubErrorCode =
  /** Input was not a Blob, or its MIME type is plainly not an image. */
  | 'INVALID_INPUT'
  /** The bytes are an image we could not decode (truncated, corrupt, unsupported codec). */
  | 'DECODE_FAILED'
  /** The canvas refused to produce a blob. */
  | 'ENCODE_FAILED'
  /** No canvas implementation is reachable from this JS environment. */
  | 'UNSUPPORTED_ENVIRONMENT';

/** Every rejection from `sanitizeImage` is one of these. */
export class PixelScrubError extends Error {
  readonly code: PixelScrubErrorCode;

  constructor(code: PixelScrubErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PixelScrubError';
    this.code = code;
  }
}

/**
 * The geometry of a single sanitize pass.
 *
 * `drawWidth`/`drawHeight` are the scaled *source* dimensions handed to
 * `drawImage`. `outputWidth`/`outputHeight` are the canvas dimensions, which
 * are the draw dimensions swapped when the EXIF orientation rotates by 90.
 */
export interface ResizePlan {
  drawWidth: number;
  drawHeight: number;
  outputWidth: number;
  outputHeight: number;
  scale: number;
  /** True when orientation 5-8 turns the image on its side. */
  swapped: boolean;
}

/** A 2D affine transform in `CanvasRenderingContext2D.setTransform` argument order. */
export type TransformMatrix = [a: number, b: number, c: number, d: number, e: number, f: number];
