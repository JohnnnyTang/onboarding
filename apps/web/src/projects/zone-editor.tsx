import type { LocalProject, SeatId, ZoneDef } from "@bgp/schema";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { seatLabel } from "../app/messages";
import { ui } from "../components/ui";
import { NumberField, Problems, SelectField, TextField } from "./fields";
import {
  addZone,
  MAX_PLAYERS,
  removeZone,
  tableSize,
  updateZone,
  type ZoneRect,
} from "./project-model";
import styles from "./projects.module.css";
import type { ProjectEditor } from "./use-project";

// Zones are edited on a top-down view of the table in millimeters. Table y grows away from
// seat 1 (components-and-table.md), so it is flipped to SVG's downward y. Every drag ends in
// one save; positions snap to whole multiples of SNAP_MM.

export const SNAP_MM = 5;
export const MIN_ZONE_MM = 20;
const PAD_MM = 60;

type Point = [number, number];
type Corner = "nw" | "ne" | "sw" | "se";

type Drag =
  | { kind: "draw"; from: Point; to: Point }
  | { kind: "move"; id: string; from: Point; to: Point; rect: ZoneRect }
  | { kind: "resize"; id: string; anchor: Point; to: Point };

const snap = (value: number) => Math.round(value / SNAP_MM) * SNAP_MM;

/** The rectangle spanned by two corners, as a zone rect (center, size). */
export function rectBetween(a: Point, b: Point): ZoneRect {
  const [x1, x2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y1, y2] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2, w: x2 - x1, h: y2 - y1 };
}

function corner(rect: ZoneRect, which: Corner): Point {
  return [
    rect.x + (which.includes("e") ? rect.w / 2 : -rect.w / 2),
    rect.y + (which.includes("n") ? rect.h / 2 : -rect.h / 2),
  ];
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A screen point in viewBox units, for an SVG drawn with the default "xMidYMid meet": the
 * viewBox is scaled uniformly and centered in the element's box.
 */
export function viewBoxPoint(
  box: Box,
  viewBox: { x: number; y: number; width: number; height: number },
  [clientX, clientY]: Point,
): Point {
  const scale = Math.min(box.width / viewBox.width, box.height / viewBox.height);
  if (!(scale > 0)) return [viewBox.x, viewBox.y];
  const left = box.left + (box.width - viewBox.width * scale) / 2;
  const top = box.top + (box.height - viewBox.height * scale) / 2;
  return [viewBox.x + (clientX - left) / scale, viewBox.y + (clientY - top) / scale];
}

/** The project with one zone moved or resized; unchanged if the zone is gone. */
function withRect(project: LocalProject, id: string, rect: ZoneRect): LocalProject {
  const zone = project.components.zones?.find((candidate) => candidate.id === id);
  return zone ? updateZone(project, { ...zone, rect_mm: rect }) : project;
}

const OPPOSITE: Record<Corner, Corner> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };

/** Applies a drag to the zones it changes; returns the preview rectangle by zone id. */
export function dragResult(drag: Drag): { id: string | null; rect: ZoneRect } {
  switch (drag.kind) {
    case "draw":
      return { id: null, rect: rectBetween(drag.from, drag.to) };
    case "move":
      return {
        id: drag.id,
        rect: {
          ...drag.rect,
          x: snap(drag.rect.x + drag.to[0] - drag.from[0]),
          y: snap(drag.rect.y + drag.to[1] - drag.from[1]),
        },
      };
    case "resize":
      return { id: drag.id, rect: rectBetween(drag.anchor, drag.to) };
  }
}

function ownerLabel(zone: ZoneDef): string {
  if (zone.owner === "each") return "each seat";
  return zone.owner === undefined ? "shared" : seatLabel(zone.owner);
}

export function ZoneEditor({ project, editor }: { project: LocalProject; editor: ProjectEditor }) {
  const zones = project.components.zones ?? [];
  const [selected, setSelected] = useState<string | null>(zones[0]?.id ?? null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const svg = useRef<SVGSVGElement>(null);
  const [width, height] = tableSize(zones);
  const preview = drag ? dragResult(drag) : null;
  const zone = zones.find((candidate) => candidate.id === selected) ?? null;
  const instances = project.components.setup?.instances ?? [];

  const save = async (change: (current: LocalProject) => LocalProject) => {
    try {
      const found = await editor.save(change);
      setProblems(found);
      return found.length === 0;
    } catch {
      setProblems(["The change could not be saved on this device."]);
      return false;
    }
  };

  function addAndSelect(rect: ZoneRect) {
    let id = "";
    void save((current) => {
      const added = addZone(current, rect);
      id = added.id;
      return added.project;
    }).then((ok) => ok && setSelected(id));
  }

  /** Pointer position in table millimeters, snapped. */
  function tablePoint(event: { clientX: number; clientY: number }): Point {
    const element = svg.current;
    if (!element) return [0, 0];
    const [x, y] = viewBoxPoint(element.getBoundingClientRect(), element.viewBox.baseVal, [
      event.clientX,
      event.clientY,
    ]);
    return [snap(x), snap(-y)];
  }

  /**
   * Follows one drag with listeners on the window rather than pointer capture and React's
   * delegated handlers, which WebKit did not deliver moves to. Releasing anywhere ends it.
   */
  function start(event: PointerEvent, next: Drag) {
    event.stopPropagation();
    event.preventDefault();
    let current = next;
    setDrag(current);
    const move = (moved: globalThis.PointerEvent) => {
      if (moved.pointerId !== event.pointerId) return;
      current = { ...current, to: tablePoint(moved) };
      setDrag(current);
    };
    const end = (ended: globalThis.PointerEvent) => {
      if (ended.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDrag(null);
      if (ended.type === "pointerup") finish(current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function finish(current: Drag) {
    const { id, rect } = dragResult(current);
    if (current.kind === "move" && rect.x === current.rect.x && rect.y === current.rect.y) return;
    if (rect.w < MIN_ZONE_MM || rect.h < MIN_ZONE_MM) {
      if (current.kind === "draw") setSelected(null);
      return;
    }
    if (id === null) addAndSelect(rect);
    else void save((current) => withRect(current, id, rect));
  }

  function nudge(event: KeyboardEvent) {
    if (!zone) return;
    const step = event.shiftKey ? 1 : SNAP_MM;
    const delta: Record<string, Point> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    const rect = { ...zone.rect_mm, x: zone.rect_mm.x + move[0], y: zone.rect_mm.y + move[1] };
    void save((current) => withRect(current, zone.id, rect));
  }

  const handle = Math.max(width, height) / 60;

  return (
    <section className={styles.panel} aria-label="Table and zones">
      <p className={ui.muted}>
        Drag on an empty part of the table to draw a zone. Drag a zone to move it and its corners to
        resize it. Seat 1 sits at the bottom edge. With a zone selected, the arrow keys move it.
      </p>
      <div className={styles.zoneLayout}>
        <svg
          ref={svg}
          className={styles.zoneCanvas}
          data-testid="zone-canvas"
          viewBox={`${-width / 2 - PAD_MM} ${-height / 2 - PAD_MM} ${width + 2 * PAD_MM} ${height + 2 * PAD_MM}`}
          role="application"
          aria-label={`Table, ${width} by ${height} mm`}
          // Focusable so the arrow keys can move the selected zone; an "application" is interactive.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: see above
          tabIndex={0}
          onKeyDown={nudge}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const point = tablePoint(event);
            start(event, { kind: "draw", from: point, to: point });
          }}
        >
          <rect
            className={styles.tableSurface}
            x={-width / 2}
            y={-height / 2}
            width={width}
            height={height}
          />
          <text className={styles.seatMark} x={0} y={height / 2 + PAD_MM / 2}>
            Seat 1
          </text>
          {zones.map((candidate) => {
            const rect = preview && preview.id === candidate.id ? preview.rect : candidate.rect_mm;
            const isSelected = candidate.id === selected;
            const count = instances
              .filter(
                (instance) =>
                  instance.zone === candidate.id || instance.zone.startsWith(`${candidate.id}:`),
              )
              .reduce((sum, instance) => sum + (instance.count ?? 1), 0);
            return (
              <g
                key={candidate.id}
                data-zone={candidate.id}
                className={isSelected ? styles.zoneSelected : styles.zone}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  setSelected(candidate.id);
                  const point = tablePoint(event);
                  start(event, {
                    kind: "move",
                    id: candidate.id,
                    from: point,
                    to: point,
                    rect: candidate.rect_mm,
                  });
                }}
              >
                <rect
                  x={rect.x - rect.w / 2}
                  y={-rect.y - rect.h / 2}
                  width={rect.w}
                  height={rect.h}
                />
                <text x={rect.x} y={-rect.y}>
                  {candidate.label ?? candidate.id}
                </text>
                <text className={styles.zoneMeta} x={rect.x} y={-rect.y + Math.min(rect.h / 3, 24)}>
                  {candidate.layout} · {ownerLabel(candidate)}
                  {count > 0 ? ` · ${count}` : ""}
                </text>
                {isSelected
                  ? (["nw", "ne", "sw", "se"] as const).map((which) => {
                      const [cx, cy] = corner(rect, which);
                      return (
                        <rect
                          key={which}
                          data-handle={which}
                          className={styles.handle}
                          x={cx - handle / 2}
                          y={-cy - handle / 2}
                          width={handle}
                          height={handle}
                          onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            start(event, {
                              kind: "resize",
                              id: candidate.id,
                              anchor: corner(candidate.rect_mm, OPPOSITE[which]),
                              to: tablePoint(event),
                            });
                          }}
                        />
                      );
                    })
                  : null}
              </g>
            );
          })}
          {preview && preview.id === null ? (
            <rect
              className={styles.drawing}
              x={preview.rect.x - preview.rect.w / 2}
              y={-preview.rect.y - preview.rect.h / 2}
              width={preview.rect.w}
              height={preview.rect.h}
            />
          ) : null}
        </svg>
        <div>
          {zones.length > 0 ? (
            <ul className={styles.zoneList} aria-label="Zones">
              {zones.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    aria-pressed={candidate.id === selected}
                    className={`${ui.button} ${candidate.id === selected ? "" : ui.secondary}`}
                    onClick={() => setSelected(candidate.id)}
                  >
                    {candidate.label ?? candidate.id}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={ui.muted}>No zones yet.</p>
          )}
          <p>
            <button
              type="button"
              className={`${ui.button} ${ui.secondary}`}
              onClick={() => addAndSelect({ x: 0, y: 0, w: 100, h: 100 })}
            >
              Add zone in the middle
            </button>
          </p>
          <Problems problems={problems} />
          {zone ? (
            <ZoneForm
              key={JSON.stringify(zone)}
              zone={zone}
              maxSeats={Math.min(project.manifest.players.max, MAX_PLAYERS)}
              onSave={(next) => save((current) => updateZone(current, next))}
              onRemove={() => {
                setSelected(null);
                void save((current) => removeZone(current, zone.id));
              }}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

type OwnerChoice = "" | "each" | SeatId;

function ZoneForm({
  zone,
  maxSeats,
  onSave,
  onRemove,
}: {
  zone: ZoneDef;
  maxSeats: number;
  onSave(zone: ZoneDef): Promise<boolean>;
  onRemove(): void;
}) {
  const [draft, setDraft] = useState<ZoneDef>(zone);
  const owner: OwnerChoice = draft.owner ?? "";
  const setRect = (change: Partial<ZoneRect>) =>
    setDraft({ ...draft, rect_mm: { ...draft.rect_mm, ...change } });
  return (
    <form
      className={styles.defForm}
      aria-label={`Zone ${zone.label ?? zone.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(draft);
      }}
    >
      <p className={ui.muted}>Zone id: {zone.id}</p>
      <TextField
        label="Label"
        value={draft.label ?? ""}
        onChange={(label) => {
          const { label: _label, ...rest } = draft;
          setDraft(label === "" ? rest : { ...rest, label });
        }}
      />
      <SelectField
        label="Layout"
        value={draft.layout}
        options={[
          { value: "stack", label: "Stack (a pile)" },
          { value: "row", label: "Row" },
          { value: "fan", label: "Fan (a hand)" },
          { value: "grid", label: "Grid" },
          { value: "free", label: "Free placement" },
        ]}
        onChange={(layout) => {
          const { grid: _grid, ...rest } = draft;
          setDraft(
            layout === "grid"
              ? { ...rest, layout, grid: draft.grid ?? { cols: 3, rows: 3 } }
              : { ...rest, layout },
          );
        }}
      />
      {draft.layout === "grid" && draft.grid ? (
        <div className={styles.fieldRow}>
          <NumberField
            label="Columns"
            integer
            min={1}
            max={50}
            value={draft.grid.cols}
            onChange={(cols) => setDraft({ ...draft, grid: { rows: draft.grid?.rows ?? 1, cols } })}
          />
          <NumberField
            label="Rows"
            integer
            min={1}
            max={50}
            value={draft.grid.rows}
            onChange={(rows) => setDraft({ ...draft, grid: { cols: draft.grid?.cols ?? 1, rows } })}
          />
        </div>
      ) : null}
      <SelectField<OwnerChoice>
        label="Owner"
        value={owner}
        options={[
          { value: "", label: "Nobody (shared)" },
          { value: "each", label: "Each seat gets one" },
          ...Array.from({ length: maxSeats }, (_, seat) => ({
            value: String(seat),
            label: seatLabel(String(seat)),
          })),
        ]}
        onChange={(choice) => {
          const { owner: _owner, ...rest } = draft;
          setDraft(choice === "" ? { ...rest, visibility: "public" } : { ...rest, owner: choice });
        }}
      />
      <SelectField
        label="Who sees the items"
        value={draft.visibility}
        options={
          draft.owner === undefined
            ? [{ value: "public", label: "Everyone, when face up" }]
            : [
                { value: "public", label: "Everyone, when face up" },
                { value: "owner", label: "Only the owner" },
              ]
        }
        onChange={(visibility) => setDraft({ ...draft, visibility })}
      />
      <div className={styles.fieldRow}>
        <NumberField
          label="Center x"
          unit="mm"
          value={draft.rect_mm.x}
          onChange={(x) => setRect({ x })}
        />
        <NumberField
          label="Center y"
          unit="mm"
          value={draft.rect_mm.y}
          onChange={(y) => setRect({ y })}
        />
      </div>
      <div className={styles.fieldRow}>
        <NumberField
          label="Width"
          unit="mm"
          min={1}
          value={draft.rect_mm.w}
          onChange={(w) => setRect({ w })}
        />
        <NumberField
          label="Height"
          unit="mm"
          min={1}
          value={draft.rect_mm.h}
          onChange={(h) => setRect({ h })}
        />
      </div>
      <p className={styles.formActions}>
        <button type="submit" className={ui.button}>
          Save zone
        </button>
        <button type="button" className={`${ui.button} ${ui.secondary}`} onClick={onRemove}>
          Remove zone
        </button>
      </p>
    </form>
  );
}
