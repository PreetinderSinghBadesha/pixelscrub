import { readEncodedSize, readOrientation } from '../../src/exif.js';
import { resetOrientationProbeCache } from '../../src/canvas.js';
import { resetFormatSupportCache } from '../../src/formats.js';
import { makeJpeg } from './fixtures.js';

/**
 * A recording canvas.
 *
 * Node has no canvas, and a headless rasteriser would only let us assert on
 * pixels we would then have to trust. What actually needs verifying is the
 * instructions pixelscrub issues — the canvas dimensions it picks, the affine
 * transform it installs, the format it asks the encoder for — so this stands in
 * for the browser and records them.
 *
 * The fake decoder reads its dimensions out of the fixture's SOF0 segment and
 * throws on anything it cannot parse, exactly like a real decoder. The fake
 * encoder emits a metadata-free JPEG header sized to the canvas, so tests can
 * re-parse the output bytes and confirm no EXIF survived the round trip.
 */

export interface DrawImageCall {
  source: unknown;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  alpha: number;
}

export interface TextCall {
  kind: 'fill' | 'stroke';
  text: string;
  x: number;
  y: number;
  font: string;
  color: string;
  align: string;
  baseline: string;
  alpha: number;
  lineWidth: number;
}

export class FakeContext2D {
  fillStyle = '';
  strokeStyle = '';
  font = '';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  lineWidth = 1;
  lineJoin = 'miter';
  imageSmoothingEnabled = false;
  imageSmoothingQuality = 'low';
  readonly transforms: number[][] = [];
  readonly drawImageCalls: DrawImageCall[] = [];
  readonly fillRectCalls: number[][] = [];
  readonly textCalls: TextCall[] = [];
  readonly attributes: { alpha?: boolean } | undefined;
  /** Depth of save/restore nesting; must be back to 0 when a render finishes. */
  saveDepth = 0;
  maxSaveDepth = 0;

  constructor(attributes?: { alpha?: boolean }) {
    this.attributes = attributes;
  }

  readonly #stack: Record<string, unknown>[] = [];

  /** Real save/restore semantics, so leaked state shows up as a test failure. */
  save(): void {
    this.#stack.push(this.#snapshot());
    this.saveDepth += 1;
    this.maxSaveDepth = Math.max(this.maxSaveDepth, this.saveDepth);
  }

  restore(): void {
    const saved = this.#stack.pop();
    if (!saved) return;
    Object.assign(this, saved);
    this.saveDepth -= 1;
  }

  #snapshot(): Record<string, unknown> {
    const { fillStyle, strokeStyle, font, textAlign, textBaseline } = this;
    const { globalAlpha, lineWidth, lineJoin, imageSmoothingEnabled, imageSmoothingQuality } = this;
    return {
      fillStyle,
      strokeStyle,
      font,
      textAlign,
      textBaseline,
      globalAlpha,
      lineWidth,
      lineJoin,
      imageSmoothingEnabled,
      imageSmoothingQuality,
    };
  }

  fillText(text: string, x: number, y: number): void {
    this.textCalls.push(this.#textCall('fill', text, x, y));
  }

  strokeText(text: string, x: number, y: number): void {
    this.textCalls.push(this.#textCall('stroke', text, x, y));
  }

  #textCall(kind: 'fill' | 'stroke', text: string, x: number, y: number): TextCall {
    return {
      kind,
      text,
      x,
      y,
      font: this.font,
      color: kind === 'fill' ? String(this.fillStyle) : String(this.strokeStyle),
      align: this.textAlign,
      baseline: this.textBaseline,
      alpha: this.globalAlpha,
      lineWidth: this.lineWidth,
    };
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transforms.push([a, b, c, d, e, f]);
  }

  drawImage(source: unknown, dx: number, dy: number, dw: number, dh: number): void {
    this.drawImageCalls.push({ source, dx, dy, dw, dh, alpha: this.globalAlpha });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.fillRectCalls.push([x, y, w, h]);
  }
}

export class FakeOffscreenCanvas {
  width: number;
  height: number;
  /** Dimensions at construction, before the library zeroes them to free memory. */
  readonly initialWidth: number;
  readonly initialHeight: number;
  context: FakeContext2D | null = null;
  readonly encodeRequests: { type: string; quality: number | undefined }[] = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.initialWidth = width;
    this.initialHeight = height;
    activeEnv?.canvases.push(this);
  }

  getContext(type: string, attributes?: { alpha?: boolean }): FakeContext2D | null {
    if (type !== '2d') return null;
    this.context ??= new FakeContext2D(attributes);
    return this.context;
  }

  async convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> {
    const env = activeEnv;
    const requested = options?.type ?? 'image/png';
    this.encodeRequests.push({ type: requested, quality: options?.quality });
    if (env?.failEncode) throw new Error('encoder exploded');

    // Browsers do not reject an unsupported format, they quietly hand back PNG.
    const actual = env?.supportedFormats.has(requested) ? requested : 'image/png';
    const bytes = makeJpeg({ width: this.width || 1, height: this.height || 1 });
    return new Blob([bytes], { type: actual });
  }
}

export class FakeImageBitmap {
  closed = false;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  close(): void {
    this.closed = true;
  }
}

interface FakeEnv {
  canvases: FakeOffscreenCanvas[];
  objectUrls: Map<string, Blob>;
  supportedFormats: Set<string>;
  failEncode: boolean;
}

let activeEnv: FakeEnv | null = null;

export interface FakeCanvasOptions {
  /** Formats the fake encoder will honour. Anything else degrades to PNG. */
  supportedFormats?: string[];
  /** Make `convertToBlob` throw, to exercise the ENCODE_FAILED path. */
  failEncode?: boolean;
  /** Drop `createImageBitmap` so the legacy `Image()` decode path is used. */
  bitmapSupport?: boolean;
  /** In the legacy path, simulate a browser that auto-rotates from EXIF anyway. */
  autoRotate?: boolean;
}

export interface FakeCanvasEnv {
  /** Every canvas constructed, in creation order (format probes included). */
  canvases: FakeOffscreenCanvas[];
  /** The output canvas: the only one that gets an orientation transform. */
  outputCanvas(): FakeOffscreenCanvas;
  /** Scratch canvases created by the progressive-downscale loop. */
  scratchCanvases(): FakeOffscreenCanvas[];
  restore(): void;
}

export function installFakeCanvas(options: FakeCanvasOptions = {}): FakeCanvasEnv {
  const {
    supportedFormats = ['image/png', 'image/jpeg', 'image/webp'],
    failEncode = false,
    bitmapSupport = true,
    autoRotate = false,
  } = options;

  const env: FakeEnv = {
    canvases: [],
    objectUrls: new Map(),
    supportedFormats: new Set(supportedFormats),
    failEncode,
  };
  activeEnv = env;
  resetCaches();

  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const restoreObjectUrls: (() => void)[] = [];
  const define = (name: string, value: unknown) => {
    saved.set(name, globals[name]);
    globals[name] = value;
  };

  define('OffscreenCanvas', FakeOffscreenCanvas);

  if (bitmapSupport) {
    define('createImageBitmap', async (blob: Blob) => {
      const { width, height } = await decodeSize(blob, autoRotate);
      return new FakeImageBitmap(width, height);
    });
  } else {
    define('createImageBitmap', undefined);
    define('Image', makeFakeImage(env, autoRotate));
    // Patch the two object-URL methods rather than replacing URL itself, which
    // the test runner needs for module resolution.
    installObjectUrls(env, restoreObjectUrls);
  }

  return {
    canvases: env.canvases,
    outputCanvas: () => {
      const canvas = env.canvases.find((entry) => (entry.context?.transforms.length ?? 0) > 0);
      if (!canvas) throw new Error('No canvas was rendered to.');
      return canvas;
    },
    scratchCanvases: () => {
      const index = env.canvases.findIndex((entry) => (entry.context?.transforms.length ?? 0) > 0);
      if (index === -1) return [];
      return env.canvases.slice(index + 1).filter((entry) => entry.context !== null);
    },
    restore: () => {
      for (const undo of restoreObjectUrls) undo();
      for (const [name, value] of saved) {
        if (value === undefined) delete globals[name];
        else globals[name] = value;
      }
      activeEnv = null;
      resetCaches();
    },
  };
}

async function decodeSize(
  blob: Blob,
  autoRotate: boolean,
): Promise<{ width: number; height: number }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const size = readEncodedSize(bytes);
  if (!size) throw new Error('unsupported image format');
  // A decoder that honours EXIF reports the rotated dimensions.
  return autoRotate && readOrientation(bytes) >= 5
    ? { width: size.height, height: size.width }
    : size;
}

function resetCaches(): void {
  resetFormatSupportCache();
  resetOrientationProbeCache();
}

function installObjectUrls(env: FakeEnv, undo: (() => void)[]): void {
  const target = URL as unknown as Record<string, unknown>;
  const previous = { create: target.createObjectURL, revoke: target.revokeObjectURL };
  let counter = 0;

  target.createObjectURL = (blob: Blob): string => {
    const url = `blob:fake/${(counter += 1)}`;
    env.objectUrls.set(url, blob);
    return url;
  };
  target.revokeObjectURL = (url: string): void => {
    env.objectUrls.delete(url);
  };

  undo.push(() => {
    target.createObjectURL = previous.create;
    target.revokeObjectURL = previous.revoke;
  });
}

function makeFakeImage(env: FakeEnv, autoRotate: boolean) {
  return class FakeImage {
    style: Record<string, string> = {};
    naturalWidth = 0;
    naturalHeight = 0;
    width = 0;
    height = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    #src = '';

    get src(): string {
      return this.#src;
    }

    set src(value: string) {
      this.#src = value;
      if (!value) return;
      const blob = env.objectUrls.get(value);
      void (async () => {
        try {
          if (!blob) throw new Error('unknown object URL');
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const size = readEncodedSize(bytes);
          if (!size) throw new Error('unsupported image format');
          // A browser that ignores `image-orientation: none` reports the
          // already-rotated dimensions.
          const rotated = autoRotate && readOrientation(bytes) >= 5;
          this.naturalWidth = rotated ? size.height : size.width;
          this.naturalHeight = rotated ? size.width : size.height;
          this.onload?.();
        } catch {
          this.onerror?.();
        }
      })();
    }
  };
}
