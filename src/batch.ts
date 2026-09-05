import { assertOptions, sanitizeImage } from './sanitize.js';
import { PixelScrubError } from './types.js';
import type { BatchProgress, BatchResult, SanitizeBatchOptions } from './types.js';

/**
 * How many images are decoded at once when the caller does not say.
 *
 * Deliberately low. The constraint is memory, not CPU: a decoded 12MP photo is
 * roughly 48MB of RGBA before the scratch canvases, and mobile Safari kills the
 * tab rather than reporting an allocation failure.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * Sanitizes many images, bounded so a multi-select does not exhaust memory.
 *
 * This is deliberately not `Promise.all(files.map(sanitizeImage))`. Two things
 * go wrong with that: thirty phone photos decoded simultaneously will take a
 * mobile browser down, and one corrupt file rejects the whole batch, losing the
 * twenty-nine that worked.
 *
 * So results come back settled and in input order — `results[i]` always
 * describes `files[i]` — and a single unreadable image is reported as one
 * rejected entry rather than failing the upload.
 *
 * @example
 * const results = await sanitizeImages(input.files, { maxWidth: 1920 });
 * const body = new FormData();
 * for (const result of results) {
 *   if (result.status === 'fulfilled') body.append('photos', result.file);
 *   else console.warn(`Skipped ${result.input.name}: ${result.reason.message}`);
 * }
 */
export async function sanitizeImages(
  files: Iterable<File | Blob>,
  options?: SanitizeBatchOptions,
): Promise<BatchResult[]> {
  const { concurrency, signal, onProgress, ...sanitizeOptions } = options ?? {};

  const items = [...files];
  const limit = resolveConcurrency(concurrency);
  // Options that cannot work will not work for any image; say so once, now,
  // instead of returning one identical rejection per file.
  assertOptions(sanitizeOptions);
  const results = new Array<BatchResult>(items.length);
  if (items.length === 0) return results;

  throwIfAborted(signal);

  let cursor = 0;
  let completed = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;

      // Checked per item rather than per batch so an abort stops the run
      // promptly instead of after every queued image has been decoded.
      throwIfAborted(signal);

      const input = items[index] as File | Blob;
      const result = await settle(input, index, sanitizeOptions);
      results[index] = result;
      completed += 1;

      reportProgress(onProgress, { completed, total: items.length, result });
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function settle(
  input: File | Blob,
  index: number,
  options: SanitizeBatchOptions,
): Promise<BatchResult> {
  try {
    return { status: 'fulfilled', index, input, file: await sanitizeImage(input, options) };
  } catch (error) {
    return { status: 'rejected', index, input, reason: toError(error) };
  }
}

/**
 * A progress callback is the caller's code, and a throw from it should not take
 * down a batch that is otherwise succeeding.
 */
function reportProgress(
  onProgress: ((progress: BatchProgress) => void) | undefined,
  progress: BatchProgress,
): void {
  if (!onProgress) return;
  try {
    onProgress(progress);
  } catch {
    // Ignored on purpose: reporting is not part of the work.
  }
}

function resolveConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined) return DEFAULT_CONCURRENCY;
  if (typeof concurrency !== 'number' || !Number.isFinite(concurrency) || concurrency < 1) {
    throw new PixelScrubError(
      'INVALID_INPUT',
      'concurrency must be a number of at least 1, received ' + String(concurrency) + '.',
    );
  }
  return Math.floor(concurrency);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new PixelScrubError('INVALID_INPUT', 'The batch was aborted.');
}

/** Browsers can throw non-Errors; callers should not have to guard for that. */
function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new PixelScrubError('INVALID_INPUT', 'Sanitizing failed: ' + String(value));
}
