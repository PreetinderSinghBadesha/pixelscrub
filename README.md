# pixelscrub

Zero-dependency, client-side image sanitizer. Strips EXIF metadata, resizes, and re-encodes images entirely in the browser via `<canvas>` — before a file ever reaches a server.

```bash
npm install pixelscrub
```

## Why

Photos straight off a phone carry three costs:

- **Privacy and compliance.** EXIF can include GPS coordinates, device model, and capture timestamps. Storing that unmodified is a GDPR/CCPA liability you did not ask for.
- **Bandwidth.** Phone photos run 5–10MB. Uploading those over a weak connection fails often, and costs real money in transfer and storage.
- **Server load.** Resizing server-side with sharp or imagemagick burns CPU you could avoid entirely.

## How

Draw the image to a canvas and read it back out. A canvas holds pixel data and nothing else, so metadata is gone by construction rather than by being edited out. Resizing and format conversion happen in the same pass, in the browser, for free.

The one piece of metadata that carries visual meaning — the EXIF orientation tag — is read off the raw bytes first and baked into the pixels, so the output needs no orientation tag of its own.

## Usage

```js
import { sanitizeImage } from 'pixelscrub';

const safeFile = await sanitizeImage(originalFile, {
  maxWidth: 1920,
  quality: 0.8,
  outputFormat: 'image/webp',
});

const body = new FormData();
body.append('photo', safeFile);
await fetch('/upload', { method: 'POST', body });
```

It resolves to a `File`, not a `Blob`, so it drops into existing `FormData` upload code unchanged.

## API

### `sanitizeImage(file, options?): Promise<File>`

| Option               | Type                                            | Default        | Notes                                                                       |
| -------------------- | ----------------------------------------------- | -------------- | --------------------------------------------------------------------------- |
| `maxWidth`           | `number`                                        | no limit       | Bounds the **displayed** width, after orientation is applied.                |
| `maxHeight`          | `number`                                        | no limit       | Bounds the **displayed** height.                                             |
| `quality`            | `number` (0–1)                                  | `0.85`         | Ignored for `image/png`. Values outside the range are clamped.               |
| `outputFormat`       | `'image/webp' \| 'image/jpeg' \| 'image/png'`   | `'image/webp'` | Falls back automatically where the browser cannot encode it.                 |
| `watermark`          | `Watermark`                                     | none           | Text or a logo, drawn after resizing and rotation. See [watermarks](#watermarks). |
| `maxCanvasDimension` | `number`                                        | `4096`         | Hard ceiling on either canvas axis. See [canvas limits](#canvas-size-limits). |

The returned `File`:

- keeps the original name stem with the extension swapped to match the output format (`IMG_0042.JPG` → `IMG_0042.webp`);
- has `lastModified` set to now, because the capture time is metadata too;
- reports the format the encoder **actually** produced, which may differ from the one requested.

A `Blob` with no name is returned as `image.<ext>`.

### `sanitizeImages(files, options?): Promise<BatchResult[]>`

For multi-select uploads. Takes every `sanitizeImage` option plus three of its own.

```js
import { sanitizeImages } from 'pixelscrub';

const results = await sanitizeImages(input.files, {
  maxWidth: 1920,
  concurrency: 4,
  onProgress: ({ completed, total }) => setProgress(completed / total),
});

const body = new FormData();
for (const result of results) {
  if (result.status === 'fulfilled') body.append('photos', result.file);
  else console.warn(`Skipped ${result.input.name}: ${result.reason.message}`);
}
```

| Option        | Type                             | Default | Notes                                                     |
| ------------- | -------------------------------- | ------- | --------------------------------------------------------- |
| `concurrency` | `number`                         | `4`     | How many images are decoded at once.                       |
| `signal`      | `AbortSignal`                    | —       | Cancels the run.                                           |
| `onProgress`  | `(progress: BatchProgress) => void` | —    | Called as each image settles, in completion order.         |

This is deliberately **not** `Promise.all(files.map(sanitizeImage))`:

- **Results are settled, not all-or-nothing.** One corrupt file among thirty is a single `rejected` entry, not a lost batch. Results stay in input order, so `results[i]` always describes `files[i]`.
- **Concurrency is bounded.** The constraint is memory, not CPU — a decoded 12MP photo is roughly 48MB of RGBA before scratch canvases, and mobile Safari kills the tab rather than reporting an allocation failure. Lower `concurrency` for very large images on phones.

Options that could never work for any image — a negative `maxWidth`, `concurrency: 0` — reject the call itself rather than returning one identical failure per file.

Aborting rejects the returned promise with the signal's reason and discards finished results, matching `fetch`. If you want to keep the work that completed, collect it in `onProgress` as it arrives.

### Watermarks

```js
await sanitizeImage(file, {
  maxWidth: 1920,
  watermark: { text: '© 2026 Example', position: 'bottom-right' },
});
```

| Option       | Type                            | Default          | Notes                                          |
| ------------ | ------------------------------- | ---------------- | ---------------------------------------------- |
| `text`       | `string`                        | —                | Mutually exclusive with `image`.               |
| `image`      | `Blob \| CanvasImageSource`     | —                | A logo. Mutually exclusive with `text`.        |
| `position`   | `WatermarkPosition`             | `'bottom-right'` | Nine-point grid, e.g. `'top-left'`, `'center'`. |
| `size`       | `number` (0–1)                  | `0.04` / `0.15`  | Font size for text, drawn width for an image.  |
| `margin`     | `number` (0–1)                  | `0.03`           | Inset from the edge.                           |
| `opacity`    | `number` (0–1)                  | `0.8`            |                                                |
| `color`      | `string`                        | white            | Text only.                                     |
| `fontFamily` | `string`                        | system sans      | Text only.                                     |
| `fontWeight` | `string`                        | `'600'`          | Text only.                                     |
| `outline`    | `string \| false`               | translucent black | Text only. See below.                         |

Two things about this are deliberate.

**Sizes are fractions of the image's shorter side, not pixels.** A watermark specified as `24px` is either illegible on a thumbnail or enormous on a full-resolution photo, and you rarely control which you are handed. One config now reads correctly at both ends: on a 1000×500 output the default text size resolves to 20px, and the same option on a 200×100 thumbnail resolves to 4px.

**Text is stroked before it is filled.** White text on a white background is invisible — measurably so: without the outline it produces literally zero distinguishable pixels. The default translucent-black stroke is what makes a watermark readable over a snow scene, a document scan, or a sky. Pass `outline: false` if you know what the background is.

The watermark is drawn after the orientation transform is reset, so it sits on the image as viewed rather than being rotated along with a portrait photo.

Decoding a `Blob` watermark costs a decode per call. When watermarking many images, decode once and pass the result:

```js
const logo = await createImageBitmap(logoBlob);
const results = await sanitizeImages(files, { watermark: { image: logo } });
logo.close();
```

### Sizing

Scale is computed against the orientation-corrected dimensions and capped at 1:

```
scale = min(maxWidth / displayedWidth, maxHeight / displayedHeight, 1)
```

Aspect ratio is always preserved, and a source already smaller than the bounds is re-encoded but never stretched up.

Large downscales are stepped down in halves before the final draw. A single `drawImage` that shrinks a 12MP photo to a thumbnail aliases badly in every engine; the extra draws are cheap and the result is dramatically better.

### Errors

Every rejection is a `PixelScrubError` with a `code`:

| Code                     | Cause                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| `INVALID_INPUT`          | Not a Blob, not an image MIME type, empty file, or a bad option.    |
| `DECODE_FAILED`          | Bytes that no decoder could read: truncated, corrupt, unsupported.  |
| `ENCODE_FAILED`          | The canvas refused to produce a blob.                               |
| `UNSUPPORTED_ENVIRONMENT`| No canvas implementation is reachable at all.                       |

```js
import { sanitizeImage, PixelScrubError } from 'pixelscrub';

try {
  await sanitizeImage(file);
} catch (error) {
  if (error instanceof PixelScrubError && error.code === 'DECODE_FAILED') {
    // Show "we couldn't read that image", not a stack trace.
  }
}
```

An unsupported **output format** is never an error — see below.

## Behaviour worth knowing about

### EXIF orientation

Browsers disagree about whether decoding an image applies its EXIF rotation, and the disagreement is not visible through any feature flag. `createImageBitmap`'s `imageOrientation: 'none'` was dropped from the spec in favour of a `from-image` default, so Chrome rotates during decode whatever you ask of it, while older engines do not rotate at all. Assume either way and every portrait photo comes out sideways or upside down on half your users' browsers.

pixelscrub settles it by measurement. Once per session it encodes a 2×1 JPEG with the browser's own encoder, splices an orientation-6 tag into it, and decodes it back: a decoder that honours EXIF hands back a 1×2 image. Behind that, a per-image check compares the decoded dimensions against the JPEG's frame header and catches any quarter-turn the probe missed.

Either way, the transform is applied exactly once and the output carries no orientation tag.

Orientation is read from JPEG only — that is where phone cameras put it.

### Format fallback

Not every browser's canvas can *encode* WebP; support for decoding it arrived years earlier, so feature detection has to go through the encoder. pixelscrub probes once (memoised) and falls back WebP → JPEG → PNG rather than throwing. The resolved `File` reports the format actually produced, so check `result.type` if it matters to you.

### Canvas size limits

Older iOS Safari refuses to rasterise canvases much beyond 4096×4096 and returns a blank image rather than an error, so pixelscrub clamps to 4096 on either axis by default. Raise it with `maxCanvasDimension` if you control your browser matrix and need full-resolution output.

### JPEG and transparency

JPEG has no alpha channel, so a transparent source encodes as black. When the output format is JPEG the canvas is flattened onto white first. WebP and PNG keep their alpha.

### What is not stripped

Only what the canvas discards, which is everything outside the pixel grid: EXIF, GPS, IPTC, XMP, thumbnails, maker notes. The output is a freshly encoded image, so the only remaining metadata is whatever the browser's own encoder writes — a color profile, and nothing identifying.

A watermark is the one thing pixelscrub *adds*, and it is added to the pixels, not the metadata — it survives re-encoding, screenshots, and further metadata stripping, which is the point.

## Browser support

Anything with `<canvas>` and `toBlob`. `OffscreenCanvas` and `createImageBitmap` are used where present and fall back to `HTMLCanvasElement` and `Image()` where not.

## Development

```bash
npm install
npm test          # unit and integration suite
npm run typecheck
npm run build
```

The suite runs in Node against a recording canvas that captures the instructions the library issues — canvas dimensions, the affine transform, the format asked of the encoder — plus real hand-built JPEG headers for the EXIF parsing.

For the part no stub can prove, there is a browser demo:

```bash
npm run build && npm run demo
```

Then open <http://localhost:8080> and drop a real photo in. Both previews render with `image-orientation: none`, so an image that looks sideways on the left and upright on the right is the orientation handling doing its job.

## License

MIT
