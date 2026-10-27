# Table 2D

`PixiTableRenderer` implements `TableRenderer<HTMLElement>` from `@bgp/schema`.
It consumes only a validated seat snapshot and component declarations. It never
imports rules or games. The caller must still obtain snapshots from the trusted
seat-view pipeline: structural validation cannot establish hidden identity.

```ts
import { PixiTableRenderer } from "@bgp/table-2d";

const table = new PixiTableRenderer();
await table.mount(element, { components, assetUrl, seat: "0" });
const offGesture = table.onGesture(sendToGameWorker);
const offSelection = table.onSelectionChange(updateActions);
table.setSnapshot(snapshot);
// On route teardown:
offGesture();
offSelection();
table.destroy();
```

The host needs a nonzero width and height. A `ResizeObserver` fits the table when
the host changes size; `resize()` also resets the camera explicitly. Snapshot
updates preserve the camera except when table dimensions change. Seat changes
use destroy/mount because seat is part of `mount` in the contract.

The viewing seat's furthest owned zone establishes the direction to the bottom
of the screen. Centered owned zones fall back to evenly spaced seats in sorted
seat-ID order. No owned zone means the default seat-0 view. Snapshot coordinates
are never rotated or mutated. Anonymous cards use a neutral 63 × 88 mm footprint
because the snapshot carries no public dimensions for an unidentified card.

Selection toggles on selectable item clicks; changes prune IDs that are no
longer selectable. All item clicks and empty zone clicks emit contract gestures.
Dragging requires `draggable`; drops require `droppable`. Free drops carry
integer table coordinates, grids carry a cell index, stacks append, and rows/fans
carry an insertion index. A drop emits a gesture and returns the item to the
snapshot position until the next authoritative snapshot arrives. Pinch zooms
around the touch midpoint; dragging empty felt pans; the wheel zooms on desktop.

Item IDs retain display nodes across snapshots. Position and rotation animate;
appearance changes replace the node's children. Missing or failed images keep
labeled placeholders. Only visible fronts or explicit backs are requested.
Textures belong to the renderer and are destroyed with it; stale image loads
are ignored after teardown. WebGL is used consistently across the browser matrix.

From the repo root, `pnpm dev:table` opens a standalone fixture harness at
`http://127.0.0.1:4313/dev/table/`. It runs without Docker or the T12 shell.
`pnpm build:table-dev` writes its bundle to `.scratch/table-dev/` for inspection.
T12 can mount the same library on its `/dev/table` route later.

Run `pnpm --filter @bgp/table-2d test` for layout/drop unit tests and
`pnpm test:e2e e2e/table-2d.spec.ts --workers=1` for the browser matrix.
Reviewed visual baselines use Windows. Linux CI runs interaction tests with
`--ignore-snapshots`; the dedicated Windows CI job compares all three browsers.
Update with `--update-snapshots` only after reviewing the actual images.

The renderer choice remains Default until the T13 spike receives human
confirmation. See `docs/spikes/t13-renderer-2d.md` for measurements and limits.
