import { afterEach, describe, expect, it } from 'vitest';

import { sanitizeImage } from '../src/index.js';
import { readEncodedSize, readOrientation } from '../src/exif.js';
import { PixelScrubError } from '../src/types.js';
import type { Orientation } from '../src/types.js';
import { installFakeCanvas } from './helpers/fakeCanvas.js';
import type { FakeCanvasEnv, FakeCanvasOptions } from './helpers/fakeCanvas.js';
import { bytesOf, containsExifMarker, makeJpegBlob, makeJpegFile } from './helpers/fixtures.js';

let env: FakeCanvasEnv | null = null;

function useCanvas(options: FakeCanvasOptions = {}): FakeCanvasEnv {
  env = installFakeCanvas(options);
  return env;
}

afterEach(() => {
  env?.restore();
  env = null;
});

describe('sanitizeImage — the returned File', () => {
  it('returns a File that drops straight into FormData', async () => {
    useCanvas();
    const result = await sanitizeImage(makeJpegFile('holiday.jpg', { width: 800, height: 600 }));

    expect(result).toBeInstanceOf(File);
    expect(result.name).toBe('holiday.webp');
    expect(result.type).toBe('image/webp');
    expect(result.size).toBeGreaterThan(0);

    const body = new FormData();
    body.append('photo', result);
    expect(body.get('photo')).toBe(result);
  });

  it('swaps the extension to match the output format', async () => {
    useCanvas();
    const cases: [string, 'image/webp' | 'image/jpeg' | 'image/png', string][] = [
      ['IMG_0042.JPG', 'image/webp', 'IMG_0042.webp'],
      ['IMG_0042.JPG', 'image/jpeg', 'IMG_0042.jpg'],
      ['IMG_0042.JPG', 'image/png', 'IMG_0042.png'],
      ['photo.of.the.dog.heic', 'image/webp', 'photo.of.the.dog.webp'],
      ['no-extension', 'image/webp', 'no-extension.webp'],
    ];

    for (const [input, outputFormat, expected] of cases) {
      const result = await sanitizeImage(makeJpegFile(input, { width: 40, height: 30 }), {
        outputFormat,
      });
      expect(result.name).toBe(expected);
    }
  });

  it('names a bare Blob rather than producing a nameless File', async () => {
    useCanvas();
    const result = await sanitizeImage(makeJpegBlob({ width: 40, height: 30 }));
    expect(result.name).toBe('image.webp');
  });

  it('stamps lastModified with now, since capture time is metadata too', async () => {
    useCanvas();
    const before = Date.now();
    // The fixture carries lastModified: 0.
    const result = await sanitizeImage(makeJpegFile('old.jpg', { width: 40, height: 30 }));
    expect(result.lastModified).toBeGreaterThanOrEqual(before);
  });
});

describe('sanitizeImage — metadata removal', () => {
  it('produces output with no EXIF segment', async () => {
    useCanvas();
    const source = makeJpegFile('gps.jpg', { width: 800, height: 600, orientation: 6 });
    expect(containsExifMarker(await bytesOf(source))).toBe(true);

    const result = await sanitizeImage(source, { outputFormat: 'image/jpeg' });
    const output = await bytesOf(result);

    expect(containsExifMarker(output)).toBe(false);
    expect(readOrientation(output)).toBe(1);
  });

  it('bakes the rotation into the pixels rather than re-emitting a tag', async () => {
    useCanvas();
    const result = await sanitizeImage(
      makeJpegFile('portrait.jpg', { width: 4000, height: 3000, orientation: 6 }),
      { outputFormat: 'image/jpeg' },
    );

    // Re-parsed output is upright and already transposed: nothing downstream
    // has to know about orientation at all.
    const output = await bytesOf(result);
    expect(readOrientation(output)).toBe(1);
    expect(readEncodedSize(output)).toEqual({ width: 3000, height: 4000 });
  });
});

describe('sanitizeImage — orientation', () => {
  const canvasOf = (fake: FakeCanvasEnv) => {
    const canvas = fake.outputCanvas();
    return { width: canvas.initialWidth, height: canvas.initialHeight, context: canvas.context! };
  };

  it.each<[Orientation, number, number]>([
    [1, 4000, 3000],
    [2, 4000, 3000],
    [3, 4000, 3000],
    [4, 4000, 3000],
    [5, 3000, 4000],
    [6, 3000, 4000],
    [7, 3000, 4000],
    [8, 3000, 4000],
  ])(
    'sizes the canvas for the displayed image at orientation %i',
    async (orientation, width, height) => {
      const fake = useCanvas();
      await sanitizeImage(makeJpegFile('p.jpg', { width: 4000, height: 3000, orientation }));

      const canvas = canvasOf(fake);
      expect(canvas.width).toBe(width);
      expect(canvas.height).toBe(height);
    },
  );

  it.each<[Orientation, number[]]>([
    [1, [1, 0, 0, 1, 0, 0]],
    [3, [-1, 0, 0, -1, 4000, 3000]],
    [6, [0, 1, -1, 0, 3000, 0]],
    [8, [0, -1, 1, 0, 0, 4000]],
  ])('installs the correcting transform for orientation %i', async (orientation, matrix) => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('p.jpg', { width: 4000, height: 3000, orientation }));

    const { context } = canvasOf(fake);
    expect(context.transforms[0]).toEqual(matrix);
    // The transform is reset afterwards so nothing downstream inherits it.
    expect(context.transforms.at(-1)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('draws the source at its unrotated size under the transform', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('p.jpg', { width: 4000, height: 3000, orientation: 6 }));

    const { context } = canvasOf(fake);
    const draw = context.drawImageCalls.at(-1)!;
    expect([draw.dx, draw.dy, draw.dw, draw.dh]).toEqual([0, 0, 4000, 3000]);
  });

  it('treats a JPEG with no orientation tag as upright', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('p.jpg', { width: 4000, height: 3000 }));

    const canvas = canvasOf(fake);
    expect(canvas.width).toBe(4000);
    expect(canvas.context.transforms[0]).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('does not rotate twice when the decoder applies EXIF itself', async () => {
    // What Chrome does: createImageBitmap rotates during decode no matter what
    // is asked of it, so applying our own transform on top would turn the photo
    // through 180 degrees.
    const fake = useCanvas({ autoRotate: true });
    await sanitizeImage(makeJpegFile('p.jpg', { width: 4000, height: 3000, orientation: 6 }));

    const canvas = canvasOf(fake);
    expect(canvas.width).toBe(3000);
    expect(canvas.height).toBe(4000);
    expect(canvas.context.transforms[0]).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('still bounds the output correctly when the decoder rotated', async () => {
    const fake = useCanvas({ autoRotate: true });
    await sanitizeImage(makeJpegFile('p.jpg', { width: 4000, height: 3000, orientation: 6 }), {
      maxWidth: 1500,
    });

    const canvas = canvasOf(fake);
    expect(canvas.width).toBe(1500);
    expect(canvas.height).toBe(2000);
  });

  it('probes the decoder once, not once per image', async () => {
    const fake = useCanvas();
    for (let i = 0; i < 3; i += 1) {
      await sanitizeImage(makeJpegFile('p.jpg', { width: 40, height: 30 }));
    }
    // The probe encodes a 2x1 JPEG; there should be exactly one of them.
    const probes = fake.canvases.filter(
      (canvas) => canvas.initialWidth === 2 && canvas.initialHeight === 1,
    );
    expect(probes).toHaveLength(1);
  });

  it('does not rotate twice when the legacy decoder already rotated', async () => {
    // Old browsers with no createImageBitmap decode <img> with EXIF applied.
    const fake = useCanvas({ bitmapSupport: false, autoRotate: true });
    await sanitizeImage(makeJpegFile('p.jpg', { width: 4000, height: 3000, orientation: 6 }));

    const canvas = canvasOf(fake);
    // Still portrait, because the decoder did the turn — but only once.
    expect(canvas.width).toBe(3000);
    expect(canvas.height).toBe(4000);
    expect(canvas.context.transforms[0]).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('applies the rotation itself when the legacy decoder honours image-orientation', async () => {
    const fake = useCanvas({ bitmapSupport: false, autoRotate: false });
    await sanitizeImage(makeJpegFile('p.jpg', { width: 4000, height: 3000, orientation: 6 }));

    const canvas = canvasOf(fake);
    expect(canvas.width).toBe(3000);
    expect(canvas.height).toBe(4000);
    expect(canvas.context.transforms[0]).toEqual([0, 1, -1, 0, 3000, 0]);
  });
});

describe('sanitizeImage — resizing', () => {
  it('bounds the output and keeps the aspect ratio', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('p.jpg', { width: 4000, height: 3000 }), { maxWidth: 1920 });

    const canvas = fake.outputCanvas();
    expect(canvas.initialWidth).toBe(1920);
    expect(canvas.initialHeight).toBe(1440);
  });

  it('re-encodes without stretching a small source up', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('small.jpg', { width: 320, height: 240 }), {
      maxWidth: 1920,
      maxHeight: 1080,
    });

    const canvas = fake.outputCanvas();
    expect(canvas.initialWidth).toBe(320);
    expect(canvas.initialHeight).toBe(240);
  });

  it('steps the downscale down in halves rather than in one jump', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('big.jpg', { width: 4000, height: 3000 }), { maxWidth: 400 });

    // 4000 -> 2000 -> 1000 -> 500, then the final 500 -> 400 draw.
    const scratch = fake.scratchCanvases();
    expect(scratch.map((canvas) => canvas.initialWidth)).toEqual([2000, 1000, 500]);

    const output = fake.outputCanvas();
    expect(output.context!.drawImageCalls.at(-1)!.source).toBe(scratch.at(-1));
  });

  it('draws straight from the decoded source for a modest downscale', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('p.jpg', { width: 4000, height: 3000 }), { maxWidth: 3000 });
    expect(fake.scratchCanvases()).toHaveLength(0);
  });

  it('clamps to the mobile canvas ceiling even with no caller bounds', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('huge.jpg', { width: 12000, height: 9000 }));

    const canvas = fake.outputCanvas();
    expect(canvas.initialWidth).toBe(4096);
    expect(canvas.initialHeight).toBe(3072);
  });

  it('lets a caller raise the canvas ceiling', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('huge.jpg', { width: 12000, height: 9000 }), {
      maxCanvasDimension: 16384,
    });
    expect(fake.outputCanvas().initialWidth).toBe(12000);
  });
});

describe('sanitizeImage — format handling', () => {
  it('encodes WebP at the requested quality by default', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('p.jpg', { width: 40, height: 30 }), { quality: 0.6 });

    expect(fake.outputCanvas().encodeRequests).toEqual([{ type: 'image/webp', quality: 0.6 }]);
  });

  it('defaults quality to 0.85', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('p.jpg', { width: 40, height: 30 }));
    expect(fake.outputCanvas().encodeRequests[0]!.quality).toBe(0.85);
  });

  it('clamps out-of-range quality instead of rejecting', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('p.jpg', { width: 40, height: 30 }), { quality: 4 });
    expect(fake.outputCanvas().encodeRequests[0]!.quality).toBe(1);
  });

  it('falls back to JPEG where the browser cannot encode WebP', async () => {
    const fake = useCanvas({ supportedFormats: ['image/png', 'image/jpeg'] });
    const result = await sanitizeImage(makeJpegFile('holiday.jpg', { width: 40, height: 30 }));

    expect(result.type).toBe('image/jpeg');
    expect(result.name).toBe('holiday.jpg');
    expect(fake.outputCanvas().encodeRequests).toEqual([{ type: 'image/jpeg', quality: 0.85 }]);
  });

  it('falls back all the way to PNG when only PNG is available', async () => {
    const fake = useCanvas({ supportedFormats: ['image/png'] });
    const result = await sanitizeImage(makeJpegFile('holiday.jpg', { width: 40, height: 30 }));

    expect(result.type).toBe('image/png');
    expect(result.name).toBe('holiday.png');
    expect(fake.outputCanvas().encodeRequests[0]!.type).toBe('image/png');
  });

  it('reports the format the encoder actually produced, not the one requested', async () => {
    // A browser with no WebP encoder: the probe catches it and the request
    // never reaches the encoder as WebP.
    const fake = useCanvas({ supportedFormats: ['image/png'] });
    const result = await sanitizeImage(makeJpegFile('p.jpg', { width: 40, height: 30 }), {
      outputFormat: 'image/webp',
    });

    expect(result.type).toBe('image/png');
    expect(fake.outputCanvas().encodeRequests[0]!.type).not.toBe('image/webp');
  });

  it('flattens onto white for JPEG, which has no alpha channel', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('p.jpg', { width: 400, height: 300 }), {
      outputFormat: 'image/jpeg',
    });

    const context = fake.outputCanvas().context!;
    expect(context.attributes).toEqual({ alpha: false });
    expect(context.fillRectCalls).toEqual([[0, 0, 400, 300]]);
    expect(context.fillStyle).toBe('#ffffff');
  });

  it('keeps the alpha channel for formats that support it', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('p.jpg', { width: 400, height: 300 }), {
      outputFormat: 'image/png',
    });

    const context = fake.outputCanvas().context!;
    expect(context.attributes).toEqual({ alpha: true });
    expect(context.fillRectCalls).toEqual([]);
  });

  it('probes each encoder once across repeated calls', async () => {
    const fake = useCanvas({ supportedFormats: ['image/png', 'image/jpeg'] });
    for (let i = 0; i < 3; i += 1) {
      await sanitizeImage(makeJpegFile('p.jpg', { width: 40, height: 30 }));
    }
    // One 1x1 probe for WebP and one for the JPEG fallback, memoised across
    // all three calls rather than re-run per image.
    const probes = fake.canvases.filter((canvas) => canvas.initialWidth === 1);
    expect(probes).toHaveLength(2);
  });
});

describe('sanitizeImage — errors', () => {
  it('rejects a non-image file without attempting a decode', async () => {
    useCanvas();
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'invoice.pdf', {
      type: 'application/pdf',
    });

    await expect(sanitizeImage(pdf)).rejects.toThrow(PixelScrubError);
    await expect(sanitizeImage(pdf)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(sanitizeImage(pdf)).rejects.toThrow(/application\/pdf/);
  });

  it('rejects bytes it cannot decode rather than hanging', async () => {
    useCanvas();
    // Correct MIME type, contents are not an image at all.
    const junk = new File([new Uint8Array(64).fill(0x7a)], 'broken.jpg', { type: 'image/jpeg' });

    await expect(sanitizeImage(junk)).rejects.toMatchObject({ code: 'DECODE_FAILED' });
  });

  it('rejects a truncated image on the legacy decode path too', async () => {
    useCanvas({ bitmapSupport: false });
    const junk = new File([new Uint8Array(64).fill(0x7a)], 'broken.jpg', { type: 'image/jpeg' });

    await expect(sanitizeImage(junk)).rejects.toMatchObject({ code: 'DECODE_FAILED' });
  });

  it('rejects an empty file', async () => {
    useCanvas();
    const empty = new File([], 'empty.jpg', { type: 'image/jpeg' });
    await expect(sanitizeImage(empty)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects input that is not a Blob at all', async () => {
    useCanvas();
    await expect(sanitizeImage(null as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(sanitizeImage('photo.jpg' as never)).rejects.toThrow(/File or Blob/);
  });

  it('rejects nonsensical options with a message naming the option', async () => {
    useCanvas();
    const file = makeJpegFile('p.jpg', { width: 40, height: 30 });

    await expect(sanitizeImage(file, { maxWidth: 0 })).rejects.toThrow(/maxWidth/);
    await expect(sanitizeImage(file, { maxHeight: -10 })).rejects.toThrow(/maxHeight/);
    await expect(sanitizeImage(file, { quality: Number.NaN })).rejects.toThrow(/quality/);
    await expect(
      sanitizeImage(file, { outputFormat: 'image/gif' as never }),
    ).rejects.toThrow(/outputFormat/);
  });

  it('surfaces an encoder failure as ENCODE_FAILED', async () => {
    useCanvas({ failEncode: true });
    await expect(
      sanitizeImage(makeJpegFile('p.jpg', { width: 40, height: 30 })),
    ).rejects.toMatchObject({ code: 'ENCODE_FAILED' });
  });

  it('releases the decoded bitmap even when encoding fails', async () => {
    useCanvas({ failEncode: true });
    await expect(sanitizeImage(makeJpegFile('p.jpg', { width: 40, height: 30 }))).rejects.toThrow();
    // The bitmap is closed in a finally block; a leak here would pin native
    // memory for every failed upload.
  });
});
