import type { OutputFormat } from './types.js';

const EXTENSIONS: Record<OutputFormat, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export const OUTPUT_FORMATS = Object.keys(EXTENSIONS) as OutputFormat[];

/**
 * What we fall back to when the requested encoder is missing. PNG is the only
 * format the canvas spec requires, so every chain ends there.
 */
const FALLBACKS: Record<OutputFormat, OutputFormat[]> = {
  'image/webp': ['image/jpeg', 'image/png'],
  'image/jpeg': ['image/png'],
  'image/png': [],
};

const supportCache = new Map<OutputFormat, Promise<boolean>>();

/** Test seam: drops the memoised encoder probes. */
export function resetFormatSupportCache(): void {
  supportCache.clear();
}

export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EXTENSIONS, value);
}

export function extensionFor(format: OutputFormat): string {
  return EXTENSIONS[format];
}

/**
 * Swaps a filename's extension for the one matching `format`, so
 * `holiday.HEIC` becomes `holiday.webp` and existing upload code that keys off
 * the extension keeps working.
 */
export function replaceExtension(name: string, format: OutputFormat): string {
  const extension = EXTENSIONS[format];
  const trimmed = name.trim();
  if (!trimmed) return `image.${extension}`;

  const lastDot = trimmed.lastIndexOf('.');
  // A leading dot is a dotfile, not an extension.
  const stem = lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed;
  return `${stem}.${extension}`;
}

/**
 * Probes whether this browser's canvas can *encode* the format. Support for
 * decoding WebP arrived well before support for encoding it, so feature
 * detection has to go through the encoder. Memoised: the probe costs a 1x1
 * canvas, but callers sanitize images in loops.
 */
export function supportsEncoding(format: OutputFormat): Promise<boolean> {
  const cached = supportCache.get(format);
  if (cached) return cached;

  const probe = probeEncoder(format).catch(() => false);
  supportCache.set(format, probe);
  return probe;
}

/**
 * Resolves the caller's requested format to one this browser can actually
 * produce. Never throws — an unsupported encoder degrades the output format
 * rather than failing the upload the caller was trying to make.
 */
export async function resolveOutputFormat(requested: OutputFormat): Promise<OutputFormat> {
  if (await supportsEncoding(requested)) return requested;
  for (const fallback of FALLBACKS[requested]) {
    if (await supportsEncoding(fallback)) return fallback;
  }
  // Nothing probed clean. Hand back the request and let the encoder decide;
  // whatever blob comes out reports its own real type.
  return requested;
}

async function probeEncoder(format: OutputFormat): Promise<boolean> {
  // PNG is mandatory for every canvas implementation.
  if (format === 'image/png') return true;

  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    if (typeof canvas.toDataURL !== 'function') return false;
    // Unsupported formats silently come back as PNG rather than erroring.
    return canvas.toDataURL(format).startsWith(`data:${format}`);
  }

  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(1, 1);
    const blob = await canvas.convertToBlob({ type: format });
    return blob.type === format;
  }

  return false;
}
