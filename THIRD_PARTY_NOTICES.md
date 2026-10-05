# Third-party notices for the browser Live Photo engine

`live-photo-engine.js` adapts the browser-side Live Photo pairing and `.pvt`
packaging approach from
[fxyadela/write-then-publish](https://github.com/fxyadela/write-then-publish),
source revision `30edd3125f1c4f4c46faad1fd22aa728a2f41818`.
The adapted implementation remains subject to the following MIT notice:

> MIT License
>
> Copyright (c) 2026 捏捏番茄
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Vendored runtime libraries

The editor loads the browser libraries below from this repository so that image,
video and Live Photo export does not depend on a public CDN. Retain the adjacent
license files whenever these browser bundles are redistributed. Exact source
URLs and SHA-256 values for the newly vendored Supabase, html2canvas and JSZip
files are recorded in the repository-level `vendor/README.md`; the existing
mp4box.js and mp4-muxer bundles retain their adjacent license texts.

- [html2canvas 1.4.1](https://github.com/niklasvh/html2canvas) — MIT.
- [JSZip](https://github.com/Stuk/jszip) — MIT OR GPL-3.0-or-later; this project
  uses version 3.10.1 under MIT. Its browser distribution contains Pako 1.0.5,
  also under MIT.
- [mp4box.js](https://github.com/gpac/mp4box.js) — BSD-3-Clause.
- [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) — MIT.

WebCodecs, OffscreenCanvas and `createImageBitmap` are browser platform APIs,
not bundled third-party code.
