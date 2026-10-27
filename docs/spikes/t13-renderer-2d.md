# T13: 2D renderer comparison

Status: measured desktop comparison; human confirmation and physical phone
qualification pending. D-009 remains Default. Date: 2026-10-27.

## Method

The same validated `stressFixture` snapshot supplies 300 draggable cards to all
three adapters in `dev/table/spike.ts`: PixiJS 8.6.6 (WebGL), Three.js 0.186.1
(orthographic WebGL), and platform Canvas 2D. All use the same layout math,
background and separately baked card textures, including instance-ID text. Each
has pointer hit testing and dragging. Measurement mode moves one card along the
same path per frame, mimicking an active drag. This isolates scene submission;
it does not compare each library's full input/event system or benchmark snapshot
validation. The production Pixi renderer additionally draws vector outlines,
text, selection and feedback.

Run `pnpm dev:table`, then `pnpm exec tsx scripts/t13-renderer-spike.ts` in another
terminal. The runner writes raw results and comparative screenshots to
`.scratch/t13-spike/`. The committed raw run is
`docs/spikes/t13-renderer-2d-results.json`. A manual comparison is available at
`/dev/table/spike.html?engine=pixi` (also `three`, `canvas`), with `&fixture=all`
for the smaller five-layout fixture. `&measure=1` enables the reproducible drag.

Measured locally on Windows, Intel Arc 140V, driver 32.0.101.8860, Node 24.12.0,
Playwright 1.64.1: Chromium 156, Firefox 157, WebKit 27.2. Each viewport is 800 px
high at device scale factor 2. Discard 60 warmup frames, collect 180 intervals,
and take the sorted nearest-lower rank for p50/p95. Submission time measures the
synchronous JavaScript render call, **not** completed GPU work. Headless frame
cadence depends on backend, scheduling and host load. WebKit's Safari/macOS user
agent does not mean this was run on a Mac or an iPhone.

Backend metadata identifies SwiftShader software Vulkan in headless Chromium.
Firefox reports an Intel D3D11 ANGLE string with an "or similar" suffix; WebKit
reports "Apple GPU" despite the Windows host. Treat the latter as sanitized
browser descriptions, not hardware identification. Chromium's slow WebGL cadence
is therefore a software-rendering result, not a measured phone/GPU regression.

## Results

All numbers are milliseconds. A nominal 60 fps frame budget is about 16.7 ms.

| Browser / width | Pixi frame p50 / p95 | Three frame p50 / p95 | Canvas frame p50 / p95 | Submission p95: Pixi / Three / Canvas |
| --------------- | -------------------- | --------------------- | ---------------------- | ------------------------------------- |
| Chromium / 360  | 33.3 / 33.4          | 33.3 / 33.4           | 16.7 / 16.7            | 0.5 / 1.3 / 0.8                       |
| Chromium / 1440 | 116.6 / 116.7        | 100.0 / 116.6         | 16.7 / 16.7            | 0.4 / 1.7 / 2                         |
| Firefox / 360   | 8.3 / 8.3            | 8.3 / 8.3             | 8.3 / 8.3              | 1 / 2 / 6                             |
| Firefox / 1440  | 16.7 / 25            | 16.7 / 25             | 8.3 / 16.7             | 1 / 2 / 14                            |
| WebKit / 360    | 12 / 15              | 12 / 16               | 11 / 14                | 1 / 2 / 1                             |
| WebKit / 1440   | 39 / 44              | 39 / 44               | 43 / 50                | 1 / 2 / 1                             |

These results do **not** establish the D-009 criterion of 300 draggable items at
60 fps on a mid-range phone. Pixi misses that cadence in several desktop headless
configurations; Canvas performs best in Chromium here. Treat that as evidence
to investigate on hardware, not grounds to claim a phone pass or to switch the
default unilaterally. The measurements also show that a short JavaScript render
call alone is insufficient evidence of smooth output.

Text: all adapters use identical high-resolution raster card faces in the
comparison. The production Pixi path uses resolution-3 Text and image textures.
Review both at table fit and after zooming: fitting an 800 mm table to a 360 px
screen necessarily makes card labels small. Pinch/wheel zoom provides readable
detail. Regression screenshots separately cover missing-art labels, die values,
badges, highlights, hidden backs and all layouts in the production renderer.

Phase 2 reuse: Three directly reuses its scene/camera/material primitives, but
still needs new 3D geometry, interaction and text. Pixi and Canvas reuse the
snapshot, component declarations, layout and gesture logic through
`TableRenderer`; their drawing implementations will remain separate from 3D.

## Recommendation and confirmation gate

Keep PixiJS as the **provisional existing default**, behind `TableRenderer`.
Its retained item nodes and narrow application boundary support the Phase 1
implementation, and its measured submission overhead is small. Keep the Canvas
comparison as a credible alternative, especially for the Chromium cadence issue.
Do not promote D-009 to Accepted from this run.

Before confirming: run this fixture and the production `/dev/table/?stress=1`
page on an identified mid-range Android phone and iPhone; record device, browser,
DPR, p95 frame interval and drag/zoom behavior. Investigate the Chromium desktop
slowdown and compare actual hardware results. A human then confirms Pixi or
authorizes a different adapter. The implementation uses the current default so
it remains reviewable while that decision is pending.

API references: [Pixi Application](https://pixijs.com/8.x/guides/components/application),
[Pixi Assets](https://pixijs.com/8.x/guides/components/assets),
[Three OrthographicCamera](https://threejs.org/docs/pages/OrthographicCamera.html),
[Three WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer).
