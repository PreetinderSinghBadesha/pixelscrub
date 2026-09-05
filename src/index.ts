export { sanitizeImage } from './sanitize.js';
export { sanitizeImages } from './batch.js';

export { PixelScrubError } from './types.js';
export type {
  BatchProgress,
  BatchResult,
  Orientation,
  OutputFormat,
  PixelScrubErrorCode,
  ResizePlan,
  SanitizeBatchOptions,
  SanitizeOptions,
} from './types.js';

export { extensionFor, replaceExtension, supportsEncoding } from './formats.js';
export { readOrientation } from './exif.js';
