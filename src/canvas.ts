import { PixelScrubError } from './types.js';
import type { Orientation, OutputFormat, ResizePlan, TransformMatrix } from './types.js';
import { swapsAxes, withOrientationTag } from './exif.js';
import { drawWatermark } from './watermark.js';
import type { PreparedWatermark } from './watermark.js';

/**
 * The decode -> resize -> draw -> encode pipeline. Everything else in the
 * library hangs off this file: stripping metadata is a side effect of the fact
 * that a canvas holds pixels and nothing else.
 */

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type AnyContext2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** How long we wait on the legacy `<img>` decode before giving up. */
const DECODE_TIMEOUT_MS = 30_000;

/** Formats whose encoder cannot represent transparency. */
const OPAQUE_FORMATS: ReadonlySet<OutputFormat> = new Set<OutputFormat>(['image/jpeg']);

export interface EncodedSize {
  width: number;
  height: number;
}

export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  /**
   * True when the browser already applied the EXIF rotation during decode, so
   * our own orientation transform must be skipped or the image rotates twice.
   */
  orientationAlreadyApplied: boolean;
  release(): void;
}

export interface ResizeBounds {
  maxWidth: number;
  maxHeight: number;
  maxCanvasDimension: number;
}

/**
 * Works out the geometry of one pass.
 *
 * `maxWidth`/`maxHeight` bound the *displayed* image, so they are compared
 * against the orientation-corrected dimensions — asking for `maxWidth: 1920` on
 * a sideways portrait photo should bound the width you end up looking at, not
 * the width as stored. Scale is capped at 1: a source smaller than the bounds
 * is re-encoded, never stretched up.
 */
export function computeResizePlan(
  sourceWidth: number,
  sourceHeight: number,
  orientation: Orientation,
  bounds: ResizeBounds,
): ResizePlan {
  if (!isPositiveSize(sourceWidth) || !isPositiveSize(sourceHeight)) {
    throw new PixelScrubError(
      'DECODE_FAILED',
      'Decoded image has no usable dimensions (' + sourceWidth + 'x' + sourceHeight + ').',
    );
  }

  const swapped = swapsAxes(orientation);
  const orientedWidth = swapped ? sourceHeight : sourceWidth;
  const orientedHeight = swapped ? sourceWidth : sourceHeight;

  const scale = Math.min(
    bounds.maxWidth / orientedWidth,
    bounds.maxHeight / orientedHeight,
    bounds.maxCanvasDimension / orientedWidth,
    bounds.maxCanvasDimension / orientedHeight,
    1,
  );

  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));

  return {
    drawWidth,
    drawHeight,
    outputWidth: swapped ? drawHeight : drawWidth,
    outputHeight: swapped ? drawWidth : drawHeight,
    scale,
    swapped,
  };
}

/**
 * The affine transform that undoes an EXIF orientation.
 *
 * `width`/`height` are the *output* canvas dimensions. Applying this and then
 * drawing the source at `0, 0, drawWidth, drawHeight` lands every source corner
 * on the canvas corner it belongs on, which is why the result needs no
 * orientation tag of its own to display correctly.
 */
export function orientationTransform(
  orientation: Orientation,
  width: number,
  height: number,
): TransformMatrix {
  switch (orientation) {
    case 2: // mirrored horizontally
      return [-1, 0, 0, 1, width, 0];
    case 3: // rotated 180
      return [-1, 0, 0, -1, width, height];
    case 4: // mirrored vertically
      return [1, 0, 0, -1, 0, height];
    case 5: // mirrored along the main diagonal
      return [0, 1, 1, 0, 0, 0];
    case 6: // rotated 90 clockwise
      return [0, 1, -1, 0, width, 0];
    case 7: // mirrored along the anti-diagonal
      return [0, -1, -1, 0, width, height];
    case 8: // rotated 90 counter-clockwise
      return [0, -1, 1, 0, 0, height];
    case 1:
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/**
 * Decodes a blob and reports whether the decoder already applied the EXIF
 * rotation, so the caller knows whether it still has to.
 *
 * Browsers disagree here and the disagreement is not detectable from feature
 * flags. `createImageBitmap`'s `imageOrientation: 'none'` was dropped from the
 * spec in favour of a `from-image` default, so Chrome rotates during decode
 * whatever you ask for, while older engines do not rotate at all. Getting this
 * wrong turns every portrait photo either sideways or upside down, so we settle
 * it by measurement rather than by assumption: a one-off probe establishes the
 * decoder's policy, and a per-image dimension check backs it up.
 */
export async function decodeImage(
  blob: Blob,
  encodedSize: EncodedSize | null,
): Promise<DecodedImage> {
  const raw = await decodeRaw(blob);
  return {
    ...raw,
    orientationAlreadyApplied:
      (await decoderAppliesOrientation()) || isAlreadyRotated(encodedSize, raw.width, raw.height),
  };
}

type RawDecode = Omit<DecodedImage, 'orientationAlreadyApplied'>;

async function decodeRaw(blob: Blob): Promise<RawDecode> {
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (cause) {
      throw new PixelScrubError('DECODE_FAILED', 'The image could not be decoded.', { cause });
    }
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  }
  return decodeViaImageElement(blob);
}

let orientationProbe: Promise<boolean> | null = null;

/** Test seam: drops the memoised decoder probe. */
export function resetOrientationProbeCache(): void {
  orientationProbe = null;
}

/**
 * Answers "does this browser's decoder rotate from EXIF on its own?" once per
 * session.
 *
 * Encodes a 2x1 JPEG with the browser's own encoder, splices an orientation-6
 * tag into it, and decodes it back. A decoder that honours EXIF hands back a
 * 1x2 image; one that ignores it hands back 2x1. Nothing is assumed about the
 * engine, and no fixture has to be shipped.
 */
function decoderAppliesOrientation(): Promise<boolean> {
  // A decoder that cannot be probed is assumed not to rotate, which leaves the
  // per-image dimension check as the safety net.
  orientationProbe ??= probeDecoderOrientation().catch(() => false);
  return orientationProbe;
}

async function probeDecoderOrientation(): Promise<boolean> {
  const canvas = createCanvas(PROBE_WIDTH, 1);
  const context = get2dContext(canvas, false);
  context.fillStyle = '#808080';
  context.fillRect(0, 0, PROBE_WIDTH, 1);

  const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.5);
  const tagged = withOrientationTag(new Uint8Array(await jpeg.arrayBuffer()), 6);
  const decoded = await decodeRaw(new Blob([tagged], { type: 'image/jpeg' }));

  try {
    return decoded.width < decoded.height;
  } finally {
    decoded.release();
    canvas.width = 0;
    canvas.height = 0;
  }
}

const PROBE_WIDTH = 2;

async function decodeViaImageElement(blob: Blob): Promise<RawDecode> {
  if (typeof Image !== 'function' || typeof URL === 'undefined') {
    throw new PixelScrubError(
      'UNSUPPORTED_ENVIRONMENT',
      'Neither createImageBitmap nor Image() is available in this environment.',
    );
  }

  const url = URL.createObjectURL(blob);
  const image = new Image();

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        image.src = '';
        reject(new PixelScrubError('DECODE_FAILED', 'Timed out decoding the image.'));
      }, DECODE_TIMEOUT_MS);

      image.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      image.onerror = () => {
        clearTimeout(timer);
        reject(new PixelScrubError('DECODE_FAILED', 'The image could not be decoded.'));
      };
      image.src = url;
    });

    return {
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * Second line of defence behind the probe: the decoded dimensions come back
 * transposed relative to the JPEG's frame header, which only happens if
 * something rotated the image on the way in.
 *
 * This catches the four quarter-turn orientations on its own, per image, even
 * when the probe could not run. Mirrors and 180-degree turns leave the
 * dimensions alone and rely on the probe.
 */
function isAlreadyRotated(
  encodedSize: EncodedSize | null,
  width: number,
  height: number,
): boolean {
  if (!encodedSize) return false;
  if (encodedSize.width === encodedSize.height) return false;
  return width === encodedSize.height && height === encodedSize.width;
}

/**
 * Draws the decoded image at the planned size with the orientation baked in,
 * then encodes the canvas. The blob that comes out has pixels and a header —
 * no EXIF, no GPS, no device model, because none of it ever reached the canvas.
 */
export async function renderToBlob(
  decoded: DecodedImage,
  plan: ResizePlan,
  orientation: Orientation,
  format: OutputFormat,
  quality: number,
  watermark: PreparedWatermark | null = null,
): Promise<Blob> {
  const opaque = OPAQUE_FORMATS.has(format);
  const canvas = createCanvas(plan.outputWidth, plan.outputHeight);
  const context = get2dContext(canvas, !opaque);

  // JPEG has no alpha channel; without this, transparent pixels encode black.
  if (opaque) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, plan.outputWidth, plan.outputHeight);
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  const prescaled = prescale(decoded, plan);
  try {
    context.setTransform(...orientationTransform(orientation, plan.outputWidth, plan.outputHeight));
    context.drawImage(prescaled.source, 0, 0, plan.drawWidth, plan.drawHeight);
    context.setTransform(1, 0, 0, 1, 0, 0);
  } finally {
    prescaled.release();
  }

  // Drawn only after the transform is back to the identity, so the mark sits on
  // the finished image rather than being rotated along with it.
  if (watermark) drawWatermark(context, watermark, plan.outputWidth, plan.outputHeight);

  try {
    return await canvasToBlob(canvas, format, quality);
  } finally {
    // iOS holds on to canvas backing stores aggressively; zeroing frees them.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Halves the source repeatedly until it is within 2x of the target.
 *
 * A single `drawImage` that shrinks a 12MP photo to a thumbnail aliases badly
 * in every engine — box-filtered halving steps cost a few extra draws and look
 * dramatically better.
 */
function prescale(
  decoded: DecodedImage,
  plan: ResizePlan,
): { source: CanvasImageSource; release: () => void } {
  let source = decoded.source;
  let width = decoded.width;
  let height = decoded.height;
  let scratch: AnyCanvas | null = null;

  while (width > plan.drawWidth * 2 && height > plan.drawHeight * 2) {
    const nextWidth = Math.max(plan.drawWidth, Math.floor(width / 2));
    const nextHeight = Math.max(plan.drawHeight, Math.floor(height / 2));

    const next = createCanvas(nextWidth, nextHeight);
    const context = get2dContext(next, true);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, nextWidth, nextHeight);

    releaseCanvas(scratch);
    scratch = next;
    source = next;
    width = nextWidth;
    height = nextHeight;
  }

  return { source, release: () => releaseCanvas(scratch) };
}

export function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new PixelScrubError(
    'UNSUPPORTED_ENVIRONMENT',
    'No canvas implementation is available in this environment.',
  );
}

function releaseCanvas(canvas: AnyCanvas | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function get2dContext(canvas: AnyCanvas, alpha: boolean): AnyContext2D {
  const context = (canvas as HTMLCanvasElement).getContext('2d', { alpha }) as AnyContext2D | null;
  if (!context) {
    throw new PixelScrubError('UNSUPPORTED_ENVIRONMENT', 'Could not acquire a 2D canvas context.');
  }
  return context;
}

async function canvasToBlob(
  canvas: AnyCanvas,
  format: OutputFormat,
  quality: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    try {
      return await canvas.convertToBlob({ type: format, quality });
    } catch (cause) {
      throw new PixelScrubError('ENCODE_FAILED', 'Could not encode the image as ' + format + '.', {
        cause,
      });
    }
  }

  const element = canvas as HTMLCanvasElement;
  if (typeof element.toBlob !== 'function') {
    throw new PixelScrubError('UNSUPPORTED_ENVIRONMENT', 'This canvas cannot produce a Blob.');
  }
  return new Promise<Blob>((resolve, reject) => {
    element.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new PixelScrubError('ENCODE_FAILED', 'Could not encode the image as ' + format + '.'));
      },
      format,
      quality,
    );
  });
}

function isPositiveSize(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
