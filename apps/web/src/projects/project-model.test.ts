import { LocalProjectSchema } from "@bgp/schema";
import { describe, expect, it } from "vitest";
import { assetPathFor, sniffImageType } from "./images";
import {
  addComponent,
  addZone,
  createProject,
  missingImages,
  nextId,
  projectErrors,
  removalBlocker,
  removeComponent,
  removeZone,
  setInstances,
  setupZoneChoices,
  slugFor,
  tableSize,
  updateDetails,
  updateZone,
} from "./project-model";
import { dragResult, rectBetween, viewBoxPoint } from "./zone-editor";

const ID = "0192f3a4-5b6c-7d8e-9f01-23456789aaaa";
const NOW = "2026-11-04T10:00:00.000Z";

describe("project model", () => {
  it("creates a valid, empty sandbox project with a slug from its name", () => {
    const project = createProject("  Harbor Market!  ", ID, NOW);
    expect(LocalProjectSchema.parse(project)).toEqual(project);
    expect(project.name).toBe("Harbor Market!");
    expect(project.manifest.id).toBe("harbor-market");
    expect(projectErrors(project)).toEqual([]);
  });

  it.each([
    ["Go", "go-game"],
    ["!!!", "game-game"],
    ["Été à la plage", "ete-a-la-plage"],
    ["a".repeat(70), "a".repeat(40)],
  ])("slugs %s as %s", (name, slug) => {
    expect(slugFor(name)).toBe(slug);
    expect(slugFor(name)).toMatch(/^[a-z0-9][a-z0-9-]{2,47}$/);
  });

  it("adds every component kind with defaults that validate; a first card brings a back", () => {
    let project = createProject("Kinds", ID, NOW);
    for (const kind of ["card", "token", "die", "board", "piece", "cardBack", "card"] as const) {
      project = addComponent(project, kind, "assets/art.png").project;
    }
    expect(project.components.defs.map((def) => def.id)).toEqual([
      "back-1",
      "card-1",
      "token-1",
      "die-1",
      "board-1",
      "piece-1",
      "back-2",
      "card-2",
    ]);
    expect(project.components.defs.find((def) => def.id === "card-2")).toMatchObject({
      back: "back-1",
    });
    expect(projectErrors(project)).toEqual([]);
    expect(missingImages(project, ["assets/other.png"])).toEqual(["assets/art.png"]);
    expect(missingImages(project, ["assets/art.png"])).toEqual([]);
  });

  it("removes components with their setup lines, but not a back that cards use", () => {
    let project = addComponent(createProject("Remove", ID, NOW), "card").project;
    project = addZone(project, { x: 0, y: 0, w: 100, h: 100 }).project;
    project = setInstances(project, [{ def: "card-1", zone: "zone-1", count: 3 }]);
    expect(removalBlocker(project, "back-1")).toBe("Used as the back of Card 1");
    expect(removeComponent(project, "back-1")).toBe(project);
    project = removeComponent(project, "card-1");
    expect(project.components.setup?.instances).toEqual([]);
    expect(removalBlocker(project, "back-1")).toBeNull();
    expect(removeComponent(project, "back-1").components.defs).toEqual([]);
  });

  it("removes a zone with every setup line in it or in its seat copies", () => {
    let project = addComponent(createProject("Zones", ID, NOW), "token").project;
    project = addZone(project, { x: 0, y: 0, w: 100, h: 100 }).project;
    const hand = addZone(project, { x: 0, y: -200, w: 300, h: 100 });
    project = updateZone(hand.project, {
      id: hand.id,
      layout: "fan",
      rect_mm: { x: 0, y: -200, w: 300, h: 100 },
      owner: "each",
      visibility: "owner",
    });
    expect(setupZoneChoices(project).map((choice) => choice.id)).toEqual([
      "zone-1",
      "zone-2",
      "zone-2:0",
      "zone-2:1",
    ]);
    project = setInstances(project, [
      { def: "token-1", zone: "zone-1" },
      { def: "token-1", zone: "zone-2" },
      { def: "token-1", zone: "zone-2:1" },
    ]);
    expect(projectErrors(project)).toEqual([]);
    expect(removeZone(project, "zone-2").components.setup?.instances).toEqual([
      { def: "token-1", zone: "zone-1" },
    ]);
  });

  it("refuses zones and setup lines for seats that may not play", () => {
    let project = addComponent(createProject("Seats", ID, NOW), "token").project;
    project = addZone(project, { x: 0, y: 0, w: 100, h: 100 }).project;
    const fixed = updateZone(project, {
      id: "zone-1",
      layout: "stack",
      rect_mm: { x: 0, y: 0, w: 100, h: 100 },
      owner: "3",
      visibility: "owner",
    });
    expect(projectErrors(fixed)).toEqual(["Zone zone-1 belongs to a seat that may not play"]);
    expect(projectErrors(setInstances(project, [{ def: "token-1", zone: "zone-1:0" }]))).toContain(
      "Setup places items in zone-1:0, which may not exist",
    );
    const owner = updateZone(project, {
      id: "zone-1",
      layout: "stack",
      rect_mm: { x: 0, y: 0, w: 100, h: 100 },
      visibility: "owner",
    });
    expect(projectErrors(owner).join()).toMatch(/owner/i);
    const players = updateDetails(project, {
      name: "Seats",
      playersMin: 3,
      playersMax: 2,
      description: "",
    });
    expect(projectErrors(players)).toContain(
      "Players must be whole numbers with 1 ≤ min ≤ max ≤ 8",
    );
    expect(
      projectErrors(
        updateDetails(project, {
          ...players.manifest,
          name: " ",
          playersMin: 2,
          playersMax: 2,
          description: "",
        }),
      ),
    ).not.toEqual([]);
  });

  it("keeps the manifest in step with the details", () => {
    const project = updateDetails(createProject("Old", ID, NOW), {
      name: "New name",
      playersMin: 1,
      playersMax: 6,
      description: "  A quick game. ",
    });
    expect(project.manifest).toMatchObject({
      name: "New name",
      players: { min: 1, max: 6 },
      description: "A quick game.",
    });
    expect(
      updateDetails(project, { name: "New name", playersMin: 1, playersMax: 6, description: "" })
        .manifest,
    ).not.toHaveProperty("description");
  });

  it("numbers ids after the highest free slot and sizes the table like the sandbox", () => {
    expect(nextId("zone", ["zone-1", "zone-3"])).toBe("zone-2");
    expect(tableSize([])).toEqual([800, 600]);
    expect(
      tableSize([
        {
          id: "z",
          layout: "free",
          rect_mm: { x: 450.5, y: 0, w: 101, h: 50 },
          visibility: "public",
        },
      ]),
    ).toEqual([1002, 600]);
  });
});

describe("zone editor geometry", () => {
  it("maps screen points into a uniformly scaled, centered viewBox", () => {
    const viewBox = { x: -460, y: -360, width: 920, height: 720 };
    // A box twice as wide as the viewBox's aspect: content is centered horizontally.
    const box = { left: 100, top: 50, width: 1440, height: 360 };
    expect(viewBoxPoint(box, viewBox, [100 + 720, 50 + 180])).toEqual([0, 0]);
    expect(viewBoxPoint(box, viewBox, [100 + 720 - 230, 50])).toEqual([-460, -360]);
    expect(viewBoxPoint({ ...box, width: 0 }, viewBox, [0, 0])).toEqual([-460, -360]);
  });

  it("turns drags into rectangles; moves snap to whole steps", () => {
    expect(rectBetween([10, 40], [-30, 0])).toEqual({ x: -10, y: 20, w: 40, h: 40 });
    const rect = { x: 0, y: 0, w: 100, h: 50 };
    expect(dragResult({ kind: "move", id: "z", from: [0, 0], to: [13, -7], rect })).toEqual({
      id: "z",
      rect: { x: 15, y: -5, w: 100, h: 50 },
    });
    expect(dragResult({ kind: "resize", id: "z", anchor: [-50, 25], to: [70, -25] })).toEqual({
      id: "z",
      rect: { x: 10, y: 0, w: 120, h: 50 },
    });
    expect(dragResult({ kind: "draw", from: [0, 0], to: [20, 20] }).id).toBeNull();
  });
});

describe("image import", () => {
  const bytes = (...values: (number | string)[]) =>
    new Uint8Array(
      values.flatMap((value) =>
        typeof value === "number" ? [value] : [...value].map((char) => char.charCodeAt(0)),
      ),
    );

  it("recognizes PNG, JPEG, WebP and AVIF by their bytes and refuses anything else", () => {
    expect(sniffImageType(bytes(0x89, "PNG", 13, 10, 26, 10))).toBe("image/png");
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageType(bytes("RIFF", 0, 0, 0, 0, "WEBP"))).toBe("image/webp");
    expect(sniffImageType(bytes(0, 0, 0, 28, "ftypavif"))).toBe("image/avif");
    expect(sniffImageType(bytes("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBeNull();
    expect(sniffImageType(bytes("GIF89a", 0, 0))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });

  it("names images safely and uniquely, with the extension of their real type", () => {
    expect(assetPathFor("Fish Card (1).PNG", "image/png", [])).toBe("assets/fish-card-1.png");
    expect(assetPathFor("photo.png", "image/jpeg", ["assets/photo.jpg"])).toBe(
      "assets/photo-2.jpg",
    );
    expect(assetPathFor("../../ü.webp", "image/webp", [])).toBe("assets/image.webp");
  });
});
