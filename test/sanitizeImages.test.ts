import { afterEach, describe, expect, it, vi } from 'vitest';

import { sanitizeImages } from '../src/index.js';
import { PixelScrubError } from '../src/types.js';
import type { BatchProgress } from '../src/types.js';
import { installFakeCanvas } from './helpers/fakeCanvas.js';
import type { FakeCanvasEnv, FakeCanvasOptions } from './helpers/fakeCanvas.js';
import { makeJpegBlob, makeJpegFile } from './helpers/fixtures.js';

let env: FakeCanvasEnv | null = null;

function useCanvas(options: FakeCanvasOptions = {}): FakeCanvasEnv {
  env = installFakeCanvas(options);
  return env;
}

afterEach(() => {
  env?.restore();
  env = null;
});

const photos = (count: number) =>
  Array.from({ length: count }, (_, i) => makeJpegFile(`photo-${i}.jpg`, { width: 400, height: 300 }));

const broken = (name: string) =>
  new File([new Uint8Array(64).fill(0x7a)], name, { type: 'image/jpeg' });

describe('sanitizeImages', () => {
  it('sanitizes every image and keeps input order', async () => {
    useCanvas();
    const results = await sanitizeImages(photos(5));

    expect(results).toHaveLength(5);
    results.forEach((result, i) => {
      expect(result.status).toBe('fulfilled');
      expect(result.index).toBe(i);
      if (result.status === 'fulfilled') expect(result.file.name).toBe(`photo-${i}.webp`);
    });
  });

  it('passes the sanitize options through to every image', async () => {
    const fake = useCanvas();
    const results = await sanitizeImages(photos(3), {
      maxWidth: 200,
      outputFormat: 'image/jpeg',
      quality: 0.5,
    });

    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') expect(result.file.type).toBe('image/jpeg');
    }
    const rendered = fake.canvases.filter((canvas) => (canvas.context?.transforms.length ?? 0) > 0);
    expect(rendered.map((canvas) => canvas.initialWidth)).toEqual([200, 200, 200]);
    expect(rendered[0]!.encodeRequests[0]).toEqual({ type: 'image/jpeg', quality: 0.5 });
  });

  it('accepts any iterable, including a FileList-alike', async () => {
    useCanvas();
    const results = await sanitizeImages(new Set(photos(2)));
    expect(results).toHaveLength(2);
  });

  it('returns an empty array for no input without touching the canvas', async () => {
    const fake = useCanvas();
    await expect(sanitizeImages([])).resolves.toEqual([]);
    expect(fake.canvases).toHaveLength(0);
  });

  it('names a bare Blob the same way the single-image path does', async () => {
    useCanvas();
    const [result] = await sanitizeImages([makeJpegBlob({ width: 40, height: 30 })]);
    expect(result?.status).toBe('fulfilled');
    if (result?.status === 'fulfilled') expect(result.file.name).toBe('image.webp');
  });
});

describe('sanitizeImages — failure isolation', () => {
  it('does not let one unreadable file fail the whole batch', async () => {
    useCanvas();
    const files = [...photos(2), broken('corrupt.jpg'), ...photos(2)];
    const results = await sanitizeImages(files);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
  });

  it('reports which input failed and why', async () => {
    useCanvas();
    const bad = broken('corrupt.jpg');
    const [result] = await sanitizeImages([bad]);

    expect(result).toMatchObject({ status: 'rejected', index: 0, input: bad });
    if (result?.status === 'rejected') {
      expect(result.reason).toBeInstanceOf(PixelScrubError);
      expect((result.reason as PixelScrubError).code).toBe('DECODE_FAILED');
      // Every rejection carries a message, so callers never have to type-guard
      // just to log something useful.
      expect(result.reason.message).toBeTruthy();
    }
  });

  it('rejects a whole batch only for options that could never work', async () => {
    useCanvas();
    await expect(sanitizeImages(photos(2), { maxWidth: -1 })).rejects.toThrow(PixelScrubError);
    await expect(sanitizeImages(photos(2), { concurrency: 0 })).rejects.toThrow(/concurrency/);
  });

  it('keeps going when every single file is broken', async () => {
    useCanvas();
    const results = await sanitizeImages([broken('a.jpg'), broken('b.jpg')]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
  });
});

describe('sanitizeImages — concurrency', () => {
  /** Counts how many sanitize passes are mid-flight by watching canvas creation. */
  function trackInFlight(fake: FakeCanvasEnv) {
    const seen = new Set<unknown>();
    return () => {
      for (const canvas of fake.canvases) seen.add(canvas);
      return seen.size;
    };
  }

  it('never decodes more images at once than the limit allows', async () => {
    const fake = useCanvas();
    let inFlight = 0;
    let peak = 0;

    // The fake decoder is the only await point we control, so gate on it.
    const globals = globalThis as Record<string, unknown>;
    const decode = globals.createImageBitmap as (blob: Blob) => Promise<unknown>;
    globals.createImageBitmap = async (blob: Blob) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await decode(blob);
      } finally {
        inFlight -= 1;
      }
    };

    await sanitizeImages(photos(12), { concurrency: 3 });
    globals.createImageBitmap = decode;

    // One extra decode is the memoised orientation probe, which runs once.
    expect(peak).toBeLessThanOrEqual(4);
    expect(trackInFlight(fake)()).toBeGreaterThan(0);
  });

  it('processes a batch smaller than the concurrency limit', async () => {
    useCanvas();
    const results = await sanitizeImages(photos(2), { concurrency: 8 });
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('runs serially at concurrency 1', async () => {
    useCanvas();
    const order: number[] = [];
    await sanitizeImages(photos(4), {
      concurrency: 1,
      onProgress: ({ result }) => order.push(result.index),
    });
    expect(order).toEqual([0, 1, 2, 3]);
  });
});

describe('sanitizeImages — progress', () => {
  it('reports each image as it settles', async () => {
    useCanvas();
    const seen: BatchProgress[] = [];
    await sanitizeImages(photos(3), { concurrency: 1, onProgress: (p) => seen.push({ ...p }) });

    expect(seen.map((p) => p.completed)).toEqual([1, 2, 3]);
    expect(seen.every((p) => p.total === 3)).toBe(true);
    expect(seen.at(-1)?.result.status).toBe('fulfilled');
  });

  it('reports failures through the same callback', async () => {
    useCanvas();
    const statuses: string[] = [];
    await sanitizeImages([photos(1)[0]!, broken('bad.jpg')], {
      concurrency: 1,
      onProgress: ({ result }) => statuses.push(result.status),
    });
    expect(statuses).toEqual(['fulfilled', 'rejected']);
  });

  it('does not let a throwing progress callback break the batch', async () => {
    useCanvas();
    const onProgress = vi.fn(() => {
      throw new Error('callback blew up');
    });

    const results = await sanitizeImages(photos(3), { onProgress });
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(onProgress).toHaveBeenCalledTimes(3);
  });
});

describe('sanitizeImages — cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const fake = useCanvas();
    const controller = new AbortController();
    controller.abort(new Error('user navigated away'));

    await expect(sanitizeImages(photos(5), { signal: controller.signal })).rejects.toThrow(
      'user navigated away',
    );
    expect(fake.canvases).toHaveLength(0);
  });

  it('stops partway through when aborted mid-run', async () => {
    useCanvas();
    const controller = new AbortController();
    let completed = 0;

    const run = sanitizeImages(photos(20), {
      concurrency: 1,
      signal: controller.signal,
      onProgress: () => {
        completed += 1;
        if (completed === 3) controller.abort(new Error('cancelled'));
      },
    });

    await expect(run).rejects.toThrow('cancelled');
    // It stopped early rather than draining the queue.
    expect(completed).toBeLessThan(20);
  });

  it('surfaces completed work through onProgress even though the run rejects', async () => {
    useCanvas();
    const controller = new AbortController();
    const done: string[] = [];

    const run = sanitizeImages(photos(10), {
      concurrency: 1,
      signal: controller.signal,
      onProgress: ({ result }) => {
        if (result.status === 'fulfilled') done.push(result.file.name);
        if (done.length === 2) controller.abort(new Error('cancelled'));
      },
    });

    await expect(run).rejects.toThrow('cancelled');
    expect(done).toEqual(['photo-0.webp', 'photo-1.webp']);
  });
});
