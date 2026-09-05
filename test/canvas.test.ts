import { describe, expect, it } from 'vitest';

import { computeResizePlan, orientationTransform } from '../src/canvas.js';
import { PixelScrubError } from '../src/types.js';
import type { Orientation, TransformMatrix } from '../src/types.js';

const NO_BOUNDS = {
  maxWidth: Number.POSITIVE_INFINITY,
  maxHeight: Number.POSITIVE_INFINITY,
  maxCanvasDimension: Number.POSITIVE_INFINITY,
};

const bounds = (overrides: Partial<typeof NO_BOUNDS>) => ({ ...NO_BOUNDS, ...overrides });

describe('computeResizePlan', () => {
  it('leaves an image alone when no bounds are given', () => {
    const plan = computeResizePlan(4000, 3000, 1, NO_BOUNDS);
    expect(plan).toMatchObject({
      scale: 1,
      drawWidth: 4000,
      drawHeight: 3000,
      outputWidth: 4000,
      outputHeight: 3000,
      swapped: false,
    });
  });

  it('preserves the aspect ratio when only a width bound is given', () => {
    const plan = computeResizePlan(4000, 3000, 1, bounds({ maxWidth: 1920 }));
    expect(plan.outputWidth).toBe(1920);
    expect(plan.outputHeight).toBe(1440);
    expect(plan.outputWidth / plan.outputHeight).toBeCloseTo(4000 / 3000, 5);
  });

  it('preserves the aspect ratio when only a height bound is given', () => {
    const plan = computeResizePlan(4000, 3000, 1, bounds({ maxHeight: 600 }));
    expect(plan.outputWidth).toBe(800);
    expect(plan.outputHeight).toBe(600);
  });

  it('honours whichever bound binds first', () => {
    // A wide image against a square box is limited by its width.
    const wide = computeResizePlan(4000, 1000, 1, bounds({ maxWidth: 1000, maxHeight: 1000 }));
    expect(wide.outputWidth).toBe(1000);
    expect(wide.outputHeight).toBe(250);

    // A tall image against the same box is limited by its height.
    const tall = computeResizePlan(1000, 4000, 1, bounds({ maxWidth: 1000, maxHeight: 1000 }));
    expect(tall.outputWidth).toBe(250);
    expect(tall.outputHeight).toBe(1000);
  });

  it('never upscales a source that already fits', () => {
    const plan = computeResizePlan(320, 240, 1, bounds({ maxWidth: 1920, maxHeight: 1080 }));
    expect(plan.scale).toBe(1);
    expect(plan.outputWidth).toBe(320);
    expect(plan.outputHeight).toBe(240);
  });

  it('re-encodes at native size when the source matches the bounds exactly', () => {
    const plan = computeResizePlan(1920, 1080, 1, bounds({ maxWidth: 1920, maxHeight: 1080 }));
    expect(plan.scale).toBe(1);
    expect(plan.outputWidth).toBe(1920);
  });

  it('swaps the output axes for orientations that turn the image on its side', () => {
    for (const orientation of [5, 6, 7, 8] as Orientation[]) {
      const plan = computeResizePlan(4000, 3000, orientation, NO_BOUNDS);
      expect(plan.swapped).toBe(true);
      expect(plan.drawWidth).toBe(4000);
      expect(plan.drawHeight).toBe(3000);
      expect(plan.outputWidth).toBe(3000);
      expect(plan.outputHeight).toBe(4000);
    }
  });

  it('measures the bounds against the displayed image, not the stored one', () => {
    // Stored 4000x3000, displayed 3000x4000 once orientation 6 is applied.
    // maxWidth bounds what you end up looking at.
    const plan = computeResizePlan(4000, 3000, 6, bounds({ maxWidth: 1500 }));
    expect(plan.outputWidth).toBe(1500);
    expect(plan.outputHeight).toBe(2000);
    expect(plan.drawWidth).toBe(2000);
    expect(plan.drawHeight).toBe(1500);
  });

  it('keeps the draw and output dimensions consistent after rounding', () => {
    const plan = computeResizePlan(1999, 1001, 6, bounds({ maxWidth: 640 }));
    expect(plan.outputWidth).toBe(plan.drawHeight);
    expect(plan.outputHeight).toBe(plan.drawWidth);
  });

  it('clamps to the canvas dimension ceiling that older mobile Safari enforces', () => {
    const plan = computeResizePlan(12000, 9000, 1, bounds({ maxCanvasDimension: 4096 }));
    expect(plan.outputWidth).toBe(4096);
    expect(plan.outputHeight).toBe(3072);
  });

  it('applies the canvas ceiling to the oriented axes', () => {
    const plan = computeResizePlan(9000, 12000, 6, bounds({ maxCanvasDimension: 4096 }));
    expect(Math.max(plan.outputWidth, plan.outputHeight)).toBe(4096);
  });

  it('takes the tighter of the caller bound and the canvas ceiling', () => {
    const plan = computeResizePlan(
      12000,
      9000,
      1,
      bounds({ maxWidth: 2000, maxCanvasDimension: 4096 }),
    );
    expect(plan.outputWidth).toBe(2000);
  });

  it('never rounds a dimension down to zero', () => {
    const plan = computeResizePlan(4000, 10, 1, bounds({ maxWidth: 10 }));
    expect(plan.outputHeight).toBeGreaterThanOrEqual(1);
  });

  it('rejects a decode that produced no usable dimensions', () => {
    expect(() => computeResizePlan(0, 100, 1, NO_BOUNDS)).toThrow(PixelScrubError);
    expect(() => computeResizePlan(100, Number.NaN, 1, NO_BOUNDS)).toThrow(/dimensions/);
  });
});

describe('orientationTransform', () => {
  const DRAW_WIDTH = 400;
  const DRAW_HEIGHT = 300;

  const apply = (matrix: TransformMatrix, x: number, y: number): [number, number] => {
    const [a, b, c, d, e, f] = matrix;
    // `+ 0` normalises negative zero, which compares unequal to zero.
    return [a * x + c * y + e + 0, b * x + d * y + f + 0];
  };

  // Where each source corner has to land on the output canvas for the image to
  // read correctly with no orientation tag of its own.
  const expected: Record<
    Orientation,
    { output: [number, number]; topLeft: [number, number]; topRight: [number, number] }
  > = {
    1: { output: [400, 300], topLeft: [0, 0], topRight: [400, 0] },
    2: { output: [400, 300], topLeft: [400, 0], topRight: [0, 0] },
    3: { output: [400, 300], topLeft: [400, 300], topRight: [0, 300] },
    4: { output: [400, 300], topLeft: [0, 300], topRight: [400, 300] },
    5: { output: [300, 400], topLeft: [0, 0], topRight: [0, 400] },
    6: { output: [300, 400], topLeft: [300, 0], topRight: [300, 400] },
    7: { output: [300, 400], topLeft: [300, 400], topRight: [300, 0] },
    8: { output: [300, 400], topLeft: [0, 400], topRight: [0, 0] },
  };

  it.each([1, 2, 3, 4, 5, 6, 7, 8] as Orientation[])(
    'maps the source corners onto the canvas for orientation %i',
    (orientation) => {
      const { output, topLeft, topRight } = expected[orientation];
      const matrix = orientationTransform(orientation, output[0], output[1]);

      expect(apply(matrix, 0, 0)).toEqual(topLeft);
      expect(apply(matrix, DRAW_WIDTH, 0)).toEqual(topRight);
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8] as Orientation[])(
    'covers the canvas exactly for orientation %i',
    (orientation) => {
      const { output } = expected[orientation];
      const matrix = orientationTransform(orientation, output[0], output[1]);
      const corners = [
        apply(matrix, 0, 0),
        apply(matrix, DRAW_WIDTH, 0),
        apply(matrix, 0, DRAW_HEIGHT),
        apply(matrix, DRAW_WIDTH, DRAW_HEIGHT),
      ];

      expect(Math.min(...corners.map(([x]) => x))).toBe(0);
      expect(Math.min(...corners.map(([, y]) => y))).toBe(0);
      expect(Math.max(...corners.map(([x]) => x))).toBe(output[0]);
      expect(Math.max(...corners.map(([, y]) => y))).toBe(output[1]);
    },
  );

  it('is the identity for an upright image', () => {
    expect(orientationTransform(1, 400, 300)).toEqual([1, 0, 0, 1, 0, 0]);
  });
});
