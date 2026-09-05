import { afterEach, describe, expect, it } from 'vitest';

import { sanitizeImage } from '../src/index.js';
import { PixelScrubError } from '../src/types.js';
import type { WatermarkPosition } from '../src/types.js';
import { installFakeCanvas, FakeImageBitmap } from './helpers/fakeCanvas.js';
import type { FakeCanvasEnv, FakeContext2D } from './helpers/fakeCanvas.js';
import { makeJpegBlob, makeJpegFile } from './helpers/fixtures.js';

let env: FakeCanvasEnv | null = null;

function useCanvas(): FakeCanvasEnv {
  env = installFakeCanvas();
  return env;
}

afterEach(() => {
  env?.restore();
  env = null;
});

/** Runs one sanitize pass and hands back the output canvas's recorded calls. */
async function render(
  watermark: unknown,
  { width = 1000, height = 500, maxWidth }: { width?: number; height?: number; maxWidth?: number } = {},
): Promise<FakeContext2D> {
  const fake = env ?? useCanvas();
  await sanitizeImage(makeJpegFile('p.jpg', { width, height }), {
    ...(maxWidth === undefined ? {} : { maxWidth }),
    watermark: watermark as never,
  });
  return fake.outputCanvas().context!;
}

describe('watermark — text', () => {
  it('draws the text onto the output', async () => {
    useCanvas();
    const context = await render({ text: '© 2026 Example' });

    const fill = context.textCalls.find((call) => call.kind === 'fill');
    expect(fill?.text).toBe('© 2026 Example');
  });

  it('sizes the font from the shorter side, so one config fits any resolution', async () => {
    useCanvas();
    // 1000x500: shorter side 500, default size 0.04 -> 20px.
    const large = await render({ text: 'mark' });
    expect(large.textCalls[0]?.font).toContain('20px');

    env?.restore();
    useCanvas();
    // Same config, resized down to 200x100: shorter side 100 -> 4px.
    const small = await render({ text: 'mark' }, { maxWidth: 200 });
    expect(small.textCalls[0]?.font).toContain('4px');
  });

  it('scales with the resize rather than the source', async () => {
    useCanvas();
    // A 4000x2000 source bounded to 1000 wide has a 500px shorter side, so the
    // mark matches the 1000x500 case above rather than the source dimensions.
    const context = await render({ text: 'mark' }, { width: 4000, height: 2000, maxWidth: 1000 });
    expect(context.textCalls[0]?.font).toContain('20px');
  });

  it('strokes an outline behind the fill so the text survives a light background', async () => {
    useCanvas();
    const context = await render({ text: 'mark' });

    expect(context.textCalls.map((call) => call.kind)).toEqual(['stroke', 'fill']);
    const [stroke, fill] = context.textCalls;
    expect(stroke?.color).toBe('rgba(0, 0, 0, 0.55)');
    expect(fill?.color).toBe('#ffffff');
    expect(stroke?.lineWidth).toBeCloseTo(20 / 8, 5);
  });

  it('drops the outline when asked', async () => {
    useCanvas();
    const context = await render({ text: 'mark', outline: false });
    expect(context.textCalls.map((call) => call.kind)).toEqual(['fill']);
  });

  it('honours colour, weight, family and opacity', async () => {
    useCanvas();
    const context = await render({
      text: 'mark',
      color: '#ff0000',
      fontWeight: '300',
      fontFamily: 'Georgia, serif',
      opacity: 0.25,
      outline: false,
    });

    const [fill] = context.textCalls;
    expect(fill?.color).toBe('#ff0000');
    expect(fill?.font).toBe('300 20px Georgia, serif');
    expect(fill?.alpha).toBe(0.25);
  });
});

describe('watermark — placement', () => {
  // 1000x500 output, margin 0.03 of the 500px shorter side = 15px.
  const cases: [WatermarkPosition, number, number, string, string][] = [
    ['top-left', 15, 15, 'left', 'top'],
    ['top-center', 500, 15, 'center', 'top'],
    ['top-right', 985, 15, 'right', 'top'],
    ['center-left', 15, 250, 'left', 'middle'],
    ['center', 500, 250, 'center', 'middle'],
    ['center-right', 985, 250, 'right', 'middle'],
    ['bottom-left', 15, 485, 'left', 'bottom'],
    ['bottom-center', 500, 485, 'center', 'bottom'],
    ['bottom-right', 985, 485, 'right', 'bottom'],
  ];

  it.each(cases)('places text at %s', async (position, x, y, align, baseline) => {
    useCanvas();
    const context = await render({ text: 'mark', position, outline: false });

    const [fill] = context.textCalls;
    expect([fill?.x, fill?.y]).toEqual([x, y]);
    expect(fill?.align).toBe(align);
    expect(fill?.baseline).toBe(baseline);
  });

  it('defaults to the bottom right', async () => {
    useCanvas();
    const context = await render({ text: 'mark', outline: false });
    expect([context.textCalls[0]?.x, context.textCalls[0]?.y]).toEqual([985, 485]);
  });

  it('scales the margin with the image, not in fixed pixels', async () => {
    useCanvas();
    const context = await render({ text: 'mark', position: 'top-left', outline: false });
    expect(context.textCalls[0]?.x).toBe(15);

    env?.restore();
    useCanvas();
    const small = await render({ text: 'mark', position: 'top-left', outline: false }, { maxWidth: 200 });
    // 200x100 output, 3% of 100.
    expect(small.textCalls[0]?.x).toBe(3);
  });
});

describe('watermark — image', () => {
  const logo = () => new FakeImageBitmap(200, 100) as unknown as CanvasImageSource;

  /** Every drawImage after the photo itself is the watermark. */
  const watermarkDraw = (context: FakeContext2D) => context.drawImageCalls.at(-1)!;

  it('draws a decoded image at a width derived from the shorter side', async () => {
    useCanvas();
    const context = await render({ image: logo() });

    const draw = watermarkDraw(context);
    // Default size 0.15 of the 500px shorter side = 75px wide, 2:1 logo.
    expect(draw.dw).toBe(75);
    expect(draw.dh).toBe(37.5);
  });

  it('preserves the logo aspect ratio', async () => {
    useCanvas();
    const tall = new FakeImageBitmap(50, 200) as unknown as CanvasImageSource;
    const context = await render({ image: tall, size: 0.2 });

    const draw = watermarkDraw(context);
    expect(draw.dw / draw.dh).toBeCloseTo(50 / 200, 5);
  });

  it('insets the image from the corner by its own size', async () => {
    useCanvas();
    const context = await render({ image: logo(), position: 'bottom-right' });

    const draw = watermarkDraw(context);
    // 1000 - 15 margin - 75 wide, 500 - 15 - 37.5 tall.
    expect([draw.dx, draw.dy]).toEqual([910, 447.5]);
  });

  it('centres the image on both axes', async () => {
    useCanvas();
    const context = await render({ image: logo(), position: 'center' });

    const draw = watermarkDraw(context);
    expect([draw.dx, draw.dy]).toEqual([(1000 - 75) / 2, (500 - 37.5) / 2]);
  });

  it('applies opacity to the image too', async () => {
    useCanvas();
    const context = await render({ image: logo(), opacity: 0.3 });
    expect(watermarkDraw(context).alpha).toBe(0.3);
  });

  it('decodes a Blob watermark', async () => {
    useCanvas();
    const context = await render({ image: makeJpegBlob({ width: 400, height: 200 }) });

    const draw = watermarkDraw(context);
    expect(draw.dw).toBe(75);
    expect(draw.dh).toBe(37.5);
  });

  it('reports an undecodable watermark rather than silently skipping it', async () => {
    useCanvas();
    const junk = new Blob([new Uint8Array(32).fill(0x7a)], { type: 'image/png' });

    await expect(
      sanitizeImage(makeJpegFile('p.jpg', { width: 100, height: 100 }), {
        watermark: { image: junk },
      }),
    ).rejects.toMatchObject({ code: 'DECODE_FAILED' });
  });
});

describe('watermark — interaction with the rest of the pipeline', () => {
  it('draws after the orientation transform is reset, not under it', async () => {
    const fake = useCanvas();
    await sanitizeImage(makeJpegFile('p.jpg', { width: 1000, height: 500, orientation: 6 }), {
      watermark: { text: 'mark', position: 'top-left', outline: false },
    });

    const context = fake.outputCanvas().context!;
    // Output is 500x1000 after the quarter turn; the mark sits at the top-left
    // of what the viewer sees, using the identity transform.
    expect(context.transforms.at(-1)).toEqual([1, 0, 0, 1, 0, 0]);
    expect([context.textCalls[0]?.x, context.textCalls[0]?.y]).toEqual([15, 15]);
  });

  it('leaves no canvas state behind', async () => {
    useCanvas();
    const context = await render({ text: 'mark', opacity: 0.2 });

    expect(context.saveDepth).toBe(0);
    expect(context.maxSaveDepth).toBe(1);
    expect(context.globalAlpha).toBe(1);
  });

  it('is absent when no watermark is asked for', async () => {
    useCanvas();
    const context = await render(undefined);
    expect(context.textCalls).toHaveLength(0);
    // Only the photo itself was drawn.
    expect(context.drawImageCalls).toHaveLength(1);
  });
});

describe('watermark — validation', () => {
  const bad = (watermark: unknown) =>
    sanitizeImage(makeJpegFile('p.jpg', { width: 100, height: 100 }), {
      watermark: watermark as never,
    });

  it('rejects text and image together', async () => {
    useCanvas();
    await expect(bad({ text: 'a', image: new FakeImageBitmap(10, 10) })).rejects.toThrow(
      /not both/,
    );
  });

  it('rejects a watermark with neither', async () => {
    useCanvas();
    await expect(bad({})).rejects.toThrow(/non-empty text or an image/);
    await expect(bad({ text: '' })).rejects.toThrow(/non-empty text or an image/);
  });

  it('rejects fractions outside 0-1', async () => {
    useCanvas();
    await expect(bad({ text: 'a', opacity: 2 })).rejects.toThrow(/watermark.opacity/);
    await expect(bad({ text: 'a', margin: -1 })).rejects.toThrow(/watermark.margin/);
    await expect(bad({ text: 'a', size: 5 })).rejects.toThrow(/watermark.size/);
  });

  it('rejects an unknown position and names the valid ones', async () => {
    useCanvas();
    await expect(bad({ text: 'a', position: 'middle' })).rejects.toThrow(/bottom-right/);
  });

  it('rejects an image with no usable dimensions', async () => {
    useCanvas();
    await expect(bad({ image: new FakeImageBitmap(0, 0) })).rejects.toThrow(PixelScrubError);
  });
});
