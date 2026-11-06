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

Feedback is local and never predicts a move. With a mouse, interactive pieces
show a hover outline and a `grab` or `pointer` cursor. A dragged piece lifts above
its neighbours with a longer shadow; every droppable zone gets a soft outline and
the zone under the pointer a strong one, while zones that refuse drops dim.
Stacks show up to three card edges under the top card. Numeric d6 faces draw as
pips, and round or hex tokens clip their art to the outline. A faint 50 mm grid
marks table coordinates. Zone labels and count badges stay upright for the
viewing seat; card art turns with the table, as it would on a real one.

The canvas is focusable. Arrow keys move a focus ring through pieces in the
order the seat sees them (`focusOrder`: zones top to bottom, then left to right).
Enter or Space does exactly what a click does, including the `click` gesture.
Escape clears the selection, `+` and `-` zoom, and `0` fits the table. The
canvas `aria-label` names the focused piece using only what the snapshot shows;
face-down cards are read as "Card back".

Keyboard drag and drop (T20): M picks up the focused draggable piece. The arrow
keys then walk its drop targets (`keyboardDropTargets`, in focus order): in row,
fan and grid zones every other piece, giving the same `drop` gesture as a pointer
released on it, and every droppable zone itself, at its end (top of a stack, after
the last piece) or at the centre of a free zone. It starts at the first target
outside the piece's own zone. The target zone and piece are outlined and the
canvas label reads "moving Fish 1 to Tea 2, in Market (1 of 5); Enter drops,
Escape cancels". Enter or Space drops, Escape or M cancels; a new snapshot,
blur or pointer press cancels too. The canvas lists its keys in
`aria-keyshortcuts`, and the web app shows them under the table
(`aria-describedby`).

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

The project owner confirmed PixiJS 8.6.6 at T13 on 2026-10-27; D-009 for 2D is
Accepted. Physical-phone qualification is tracked at T20. See
`docs/spikes/t13-renderer-2d.md` for measurements and limits.
