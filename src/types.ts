/** Output container formats pixelscrub can encode to. */
export type OutputFormat = 'image/webp' | 'image/jpeg' | 'image/png';

/** The eight EXIF orientation values defined by the TIFF spec. */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Where a watermark sits on the output. */
export type WatermarkPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/**
 * A watermark drawn onto the output.
 *
 * Sizes are fractions of the image's *shorter* side rather than pixels, because
 * a watermark specified in pixels is either illegible on a thumbnail or
 * enormous on a full-resolution photo. Pass exactly one of `text` or `image`.
 */
export interface Watermark {
  /** Text to draw. Mutually exclusive with `image`. */
  text?: string;
  /**
   * Image to draw. Mutually exclusive with `text`.
   *
   * A `Blob` is decoded on every call, so when watermarking many images, decode
   * once yourself and pass the `ImageBitmap` instead.
   */
  image?: Blob | CanvasImageSource;
  /** Default: `'bottom-right'`. */
  position?: WatermarkPosition;
  /** Inset from the edge, as a fraction of the shorter side. Default: `0.03`. */
  margin?: number;
  /** 0-1. Default: `0.8`. */
  opacity?: number;
  /**
   * Fraction of the shorter side: the font size for text, the drawn width for
   * an image. Default: `0.04` for text, `0.15` for an image.
   */
  size?: number;
  /** Text only. Default: white. */
  color?: string;
  /** Text only. A CSS font-family list. Default: a system sans stack. */
  fontFamily?: string;
  /** Text only. Default: `'600'`. */
  fontWeight?: string;
  /**
   * Text only. An outline behind the text so it stays readable over whatever it
   * lands on — white text on a snow photo is otherwise invisible. Pass a colour
   * to override, or `false` to disable. Default: a translucent black.
   */
  outline?: string | false;
}

export interface SanitizeOptions {
  /** Maximum output width in CSS pixels. Default: no limit. */
  maxWidth?: number;
  /** Maximum output height in CSS pixels. Default: no limit. */
  maxHeight?: number;
  /** Encoder quality, 0-1. Ignored for `image/png`. Default: 0.85. */
  quality?: number;
  /** Container to encode to. Default: `image/webp`, falling back to JPEG where unsupported. */
  outputFormat?: OutputFormat;
  /** Draws text or a logo onto the output, after resizing and rotation. */
  watermark?: Watermark;
  /**
   * Hard ceiling on either canvas dimension, applied after `maxWidth`/`maxHeight`.
   * Older iOS Safari refuses to rasterise canvases above roughly 4096x4096 and
   * silently returns a blank image, so we clamp before drawing. Default: 4096.
   */
  maxCanvasDimension?: number;
  /**
   * When true, if the re-encoded output is larger than the input, the encoder
   * will try harder to shrink it:
   *
   * - **JPEG / WebP**: binary-search for the highest quality that beats the
   *   input size, stopping at `minQuality`.
   * - **PNG**: attempt palette (indexed-color) encoding when the image has
   *   ≤ 256 unique colours, using the browser's built-in `CompressionStream`.
   *
   * Default: `true`.
   */
  optimizeSize?: boolean;
  /**
   * Floor for the quality binary search when `optimizeSize` is active.
   * Below this the encoder gives up and returns whatever it has. 0-1.
   * Default: `0.5`.
   */
  minQuality?: number;
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
