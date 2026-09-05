import { PixelScrubError } from './types.js';
import type { Watermark, WatermarkPosition } from './types.js';

/**
 * Watermark drawing.
 *
 * Two things make watermarks fail in practice, and both are handled here rather
 * than left to the caller. Sizes are fractions of the image's shorter side, so
 * one config reads correctly on a thumbnail and a full-resolution photo alike;
 * and text is stroked before it is filled, so it stays legible over whatever it
 * happens to land on.
 *
 * Everything is drawn in output-canvas space, after the orientation transform
 * has been reset — a watermark that inherits the rotation would come out
 * sideways on exactly the portrait photos the rotation exists for.
 */

type AnyContext2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

const DEFAULTS = {
  position: 'bottom-right' as WatermarkPosition,
  margin: 0.03,
  opacity: 0.8,
  textSize: 0.04,
  imageSize: 0.15,
  color: '#ffffff',
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  fontWeight: '600',
  outline: 'rgba(0, 0, 0, 0.55)',
};

/** Outline width as a fraction of the font size. */
const OUTLINE_RATIO = 1 / 8;

interface CommonPlan {
  position: WatermarkPosition;
  margin: number;
  opacity: number;
  size: number;
}

interface TextPlan extends CommonPlan {
  kind: 'text';
  text: string;
  color: string;
  fontFamily: string;
  fontWeight: string;
  outline: string | false;
}

interface ImagePlan extends CommonPlan {
  kind: 'image';
  image: CanvasImageSource;
  aspectRatio: number;
}

export type PreparedWatermark = (TextPlan | ImagePlan) & { release(): void };

/**
 * Validates a watermark without decoding anything.
 *
 * Split out from `prepareWatermark` so batch runs can reject a malformed
 * watermark once, up front, rather than per image.
 */
export function validateWatermark(watermark: Watermark | undefined): void {
  if (watermark === undefined) return;
  if (typeof watermark !== 'object' || watermark === null) {
    throw new PixelScrubError('INVALID_INPUT', 'watermark must be an object.');
  }

  const hasText = typeof watermark.text === 'string' && watermark.text.length > 0;
  const hasImage = watermark.image !== undefined && watermark.image !== null;

  if (hasText && hasImage) {
    throw new PixelScrubError(
      'INVALID_INPUT',
      'watermark takes either text or image, not both.',
    );
  }
  if (!hasText && !hasImage) {
    throw new PixelScrubError(
      'INVALID_INPUT',
      'watermark needs a non-empty text or an image.',
    );
  }

  assertFraction(watermark.margin, 'watermark.margin');
  assertFraction(watermark.opacity, 'watermark.opacity');
  assertFraction(watermark.size, 'watermark.size');

  if (watermark.position !== undefined && !POSITIONS.has(watermark.position)) {
    throw new PixelScrubError(
      'INVALID_INPUT',
      'watermark.position must be one of ' + [...POSITIONS].join(', ') + '.',
    );
  }
}

/** Resolves defaults and decodes an image watermark if one was given as a Blob. */
export async function prepareWatermark(
  watermark: Watermark | undefined,
): Promise<PreparedWatermark | null> {
  validateWatermark(watermark);
  if (!watermark) return null;

  const common = {
    position: watermark.position ?? DEFAULTS.position,
    margin: watermark.margin ?? DEFAULTS.margin,
    opacity: watermark.opacity ?? DEFAULTS.opacity,
  };

  if (typeof watermark.text === 'string' && watermark.text.length > 0) {
    return {
      kind: 'text',
      ...common,
      size: watermark.size ?? DEFAULTS.textSize,
      text: watermark.text,
      color: watermark.color ?? DEFAULTS.color,
      fontFamily: watermark.fontFamily ?? DEFAULTS.fontFamily,
      fontWeight: watermark.fontWeight ?? DEFAULTS.fontWeight,
      outline: watermark.outline === undefined ? DEFAULTS.outline : watermark.outline,
      release: () => {},
    };
  }

  const { image, release } = await resolveImage(watermark.image as Blob | CanvasImageSource);
  return {
    kind: 'image',
    ...common,
    size: watermark.size ?? DEFAULTS.imageSize,
    image,
    aspectRatio: aspectRatioOf(image),
    release,
  };
}

/**
 * Draws the prepared watermark onto a context whose transform is the identity.
 *
 * `width`/`height` are the output canvas dimensions; every size is derived from
 * the shorter of the two so the mark keeps its proportions whatever the aspect
 * ratio of the photo turns out to be.
 */
export function drawWatermark(
  context: AnyContext2D,
  plan: PreparedWatermark,
  width: number,
  height: number,
): void {
  const reference = Math.min(width, height);
  const margin = plan.margin * reference;

  context.save();
  try {
    context.globalAlpha = plan.opacity;
    if (plan.kind === 'text') drawText(context, plan, width, height, reference, margin);
    else drawImage(context, plan, width, height, reference, margin);
  } finally {
    context.restore();
  }
}

function drawText(
  context: AnyContext2D,
  plan: TextPlan,
  width: number,
  height: number,
  reference: number,
  margin: number,
): void {
  const fontSize = Math.max(1, plan.size * reference);
  context.font = plan.fontWeight + ' ' + fontSize + 'px ' + plan.fontFamily;

  // Letting the context handle alignment keeps this free of text-metric
  // guesswork, which is the part that differs between engines.
  const [horizontal, vertical] = axesOf(plan.position);
  context.textAlign = horizontal === 'start' ? 'left' : horizontal === 'end' ? 'right' : 'center';
  context.textBaseline = vertical === 'start' ? 'top' : vertical === 'end' ? 'bottom' : 'middle';

  const x = horizontal === 'start' ? margin : horizontal === 'end' ? width - margin : width / 2;
  const y = vertical === 'start' ? margin : vertical === 'end' ? height - margin : height / 2;

  if (plan.outline !== false) {
    context.strokeStyle = plan.outline;
    context.lineWidth = Math.max(1, fontSize * OUTLINE_RATIO);
    context.lineJoin = 'round';
    // Stroking first and filling over it keeps the outline outside the glyphs,
    // so the text itself is not thinned by its own halo.
    context.strokeText(plan.text, x, y);
  }

  context.fillStyle = plan.color;
  context.fillText(plan.text, x, y);
}

function drawImage(
  context: AnyContext2D,
  plan: ImagePlan,
  width: number,
  height: number,
  reference: number,
  margin: number,
): void {
  const drawWidth = Math.max(1, plan.size * reference);
  const drawHeight = Math.max(1, drawWidth / plan.aspectRatio);

  const [horizontal, vertical] = axesOf(plan.position);
  const x =
    horizontal === 'start'
      ? margin
      : horizontal === 'end'
        ? width - margin - drawWidth
        : (width - drawWidth) / 2;
  const y =
    vertical === 'start'
      ? margin
      : vertical === 'end'
        ? height - margin - drawHeight
        : (height - drawHeight) / 2;

  context.drawImage(plan.image, x, y, drawWidth, drawHeight);
}

const POSITIONS: ReadonlySet<WatermarkPosition> = new Set<WatermarkPosition>([
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]);

type Axis = 'start' | 'middle' | 'end';

function axesOf(position: WatermarkPosition): [horizontal: Axis, vertical: Axis] {
  // 'center' is the one position written as a single token; every other name is
  // vertical-horizontal. Without this it parses as a missing horizontal axis.
  if (position === 'center') return ['middle', 'middle'];

  const [vertical, horizontal] = position.split('-') as [string, string];
  const toAxis = (value: string): Axis =>
    value === 'top' || value === 'left' ? 'start' : value === 'center' ? 'middle' : 'end';
  return [toAxis(horizontal), toAxis(vertical)];
}

async function resolveImage(
  source: Blob | CanvasImageSource,
): Promise<{ image: CanvasImageSource; release: () => void }> {
  if (isBlob(source)) {
    if (typeof createImageBitmap !== 'function') {
      throw new PixelScrubError(
        'UNSUPPORTED_ENVIRONMENT',
        'A Blob watermark needs createImageBitmap; pass a decoded image instead.',
      );
    }
    try {
      const bitmap = await createImageBitmap(source);
      return { image: bitmap, release: () => bitmap.close() };
    } catch (cause) {
      throw new PixelScrubError('DECODE_FAILED', 'The watermark image could not be decoded.', {
        cause,
      });
    }
  }
  return { image: source, release: () => {} };
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function aspectRatioOf(image: CanvasImageSource): number {
  // An <img> that is not laid out reports width/height 0, so prefer the
  // intrinsic pair when it is there.
  const size = image as {
    width?: unknown;
    height?: unknown;
    naturalWidth?: number;
    naturalHeight?: number;
  };
  const intrinsic =
    typeof size.naturalWidth === 'number' &&
    typeof size.naturalHeight === 'number' &&
    size.naturalWidth > 0 &&
    size.naturalHeight > 0;

  const width = intrinsic ? (size.naturalWidth as number) : Number(size.width);
  const height = intrinsic ? (size.naturalHeight as number) : Number(size.height);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new PixelScrubError(
      'INVALID_INPUT',
      'The watermark image has no usable dimensions.',
    );
  }
  return width / height;
}

function assertFraction(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
    throw new PixelScrubError(
      'INVALID_INPUT',
      name + ' must be a number between 0 and 1, received ' + String(value) + '.',
    );
  }
}
