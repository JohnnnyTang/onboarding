import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { TableSnapshot } from "../packages/schema/src/index.js";
import { fitViewport, tableToScreen } from "../packages/table-2d/src/layout.js";
import { keycloakLogin, WEB_URL } from "./support/app.js";
import { solidPng } from "./support/png.js";

// T17 done-when: E2E-02 (sign in, publish a local project, see the version ready; an identical
// re-publish keeps the build hash) and E2E-03 (the designer hosts a 3-seat match from it; two
// guests join by invite in separate contexts; manual move, flip, shuffle, deal and roll each
// reach every seat). designer2 signs in here: designer1 must own no games for web-app.spec.ts.

const IMAGES = {
  "assets/back.png": solidPng(63, 88, [150, 40, 40]),
  "assets/fish.png": solidPng(63, 88, [40, 120, 200]),
  "assets/salt.png": solidPng(63, 88, [200, 200, 200]),
  "assets/unused.png": solidPng(10, 10, [0, 0, 0]),
};

const ZONES = [
  { id: "deck", label: "Deck", layout: "stack", rect_mm: { x: -200, y: 60, w: 90, h: 110 } },
  { id: "pool", label: "Pool", layout: "free", rect_mm: { x: 0, y: 60, w: 140, h: 110 } },
  { id: "play", label: "Play area", layout: "free", rect_mm: { x: 200, y: 60, w: 140, h: 110 } },
] as const;

/** A small sandbox project, as the project editor would store it (E2E-01 builds one by hand). */
function sketch(id: string, slug: string) {
  return {
    id,
    name: "Harbor Sketch",
    mode: "sandbox",
    manifest: {
      schemaVersion: 1,
      id: slug,
      name: "Harbor Sketch",
      version: "0.1.0",
      mode: "sandbox",
      sdk: 1,
      players: { min: 1, max: 4 },
      components: "components.json",
    },
    components: {
      schemaVersion: 1,
      defs: [
        { id: "back", kind: "cardBack", name: "Card back", image: "assets/back.png" },
        {
          id: "fish",
          kind: "card",
          name: "Fish",
          size_mm: [63, 88],
          front: "assets/fish.png",
          back: "back",
        },
        {
          id: "salt",
          kind: "card",
          name: "Salt",
          size_mm: [63, 88],
          front: "assets/salt.png",
          back: "back",
        },
        { id: "die", kind: "die", name: "Die", sides: 6, size_mm: 16 },
      ],
      zones: [
        ...ZONES.map((zone) => ({ ...zone, visibility: "public" })),
        {
          id: "hand",
          label: "Hand",
          layout: "fan",
          rect_mm: { x: 0, y: -170, w: 400, h: 100 },
          owner: "each",
          visibility: "owner",
        },
      ],
      setup: {
        instances: [
          { def: "fish", zone: "deck", count: 4, face: "down" },
          { def: "salt", zone: "deck", count: 4, face: "down", shuffle: true },
          { def: "die", zone: "pool", face: "up" },
        ],
      },
    },
    cardTemplates: [],
    csvSources: [],
    updatedAt: new Date().toISOString(),
    publishedVersionIds: [],
  };
}

/** Writes the project and its images to the app's IndexedDB, after the app created it. */
async function seedProject(page: Page, project: ReturnType<typeof sketch>) {
  const assets = Object.entries(IMAGES).map(([path, bytes]) => ({
    projectId: project.id,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "image/png",
    size: bytes.length,
    base64: bytes.toString("base64"),
  }));
  await page.goto(`${WEB_URL}/projects`);
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await page.evaluate(
    async ({ project, assets }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("bgp");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(["projects", "projectAssets"], "readwrite");
      tx.objectStore("projects").put(project);
      for (const { base64, ...info } of assets) {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        tx.objectStore("projectAssets").put({
          ...info,
          blob: new Blob([bytes], { type: "image/png" }),
        });
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { project, assets },
  );
}

async function publish(page: Page, version: string): Promise<string> {
  await expect(page.getByRole("textbox", { name: "Version" })).toHaveValue(version);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const ready = page.getByRole("region", { name: "Published version" });
  await expect(ready.getByRole("status")).toContainText(`Version ${version} is ready.`);
  return (await ready.locator("code").getAttribute("title")) ?? "";
}

const table = (page: Page) => page.getByTestId("table").locator("canvas");
const hud = (page: Page) => page.getByRole("list", { name: "Players" });
const moves = (page: Page) => page.getByTestId("move-count");

/** Every "caption, in zone" the table's keyboard focus visits. */
async function tableItems(page: Page, steps = 16): Promise<string[]> {
  await table(page).focus();
  const seen = new Set<string>();
  for (let step = 0; step < steps; step += 1) {
    await page.keyboard.press("ArrowRight");
    const label = (await table(page).getAttribute("aria-label")) ?? "";
    const match = /^Game table: (.+?, in [^,]+)/.exec(label);
    if (match?.[1]) seen.add(match[1]);
  }
  return [...seen].sort();
}

/** Focuses and selects the first item whose label starts with `prefix` (or matches it). */
async function selectItem(page: Page, prefix: string | RegExp) {
  await expect(async () => {
    await table(page).focus();
    for (let step = 0; step < 20; step += 1) {
      await page.keyboard.press("ArrowRight");
      const label = (await table(page).getAttribute("aria-label")) ?? "";
      const caption = label.replace(/^Game table: /, "");
      if (typeof prefix === "string" ? caption.startsWith(prefix) : prefix.test(caption)) {
        await page.keyboard.press("Space");
        await expect(table(page)).toHaveAttribute("aria-label", /, selected$/, { timeout: 2000 });
        return;
      }
    }
    throw new Error(`No table item ${prefix}`);
  }).toPass({ timeout: 20_000 });
}

/** Every page reaches the same move number: each change reached every seat. */
async function everyoneSees(pages: Page[], count: number) {
  for (const page of pages) {
    await expect(moves(page)).toHaveText(`${count} ${count === 1 ? "move" : "moves"} so far`);
  }
}

/** Screen point of a table position (mm) on a seat's match page, as the renderer fits it. */
async function screenPoint(
  page: Page,
  seat: string,
  x: number,
  y: number,
): Promise<[number, number]> {
  const box = await table(page).boundingBox();
  if (!box) throw new Error("No table");
  const zones = [
    ...ZONES,
    ...["0", "1", "2"].map((owner) => ({
      id: `hand:${owner}`,
      layout: "fan",
      rect_mm: { x: 0, y: -170, w: 400, h: 100 },
      owner,
    })),
  ];
  const width = Math.max(
    800,
    ...zones.map((zone) => Math.ceil(2 * Math.abs(zone.rect_mm.x) + zone.rect_mm.w)),
  );
  const height = Math.max(
    600,
    ...zones.map((zone) => Math.ceil(2 * Math.abs(zone.rect_mm.y) + zone.rect_mm.h)),
  );
  const snapshot = {
    table: { size_mm: [width, height] },
    zones,
    items: [],
  } as unknown as TableSnapshot;
  const [sx, sy] = tableToScreen(x, y, fitViewport(snapshot, box.width, box.height, seat));
  return [box.x + sx, box.y + sy];
}

async function joinAsGuest(browser: Browser, url: string, name: string) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByRole("heading", { name: "Lobby" })).toBeVisible();
  return { context, page };
}

test("E2E-02 and E2E-03: publish a project, host a 3-seat match with two guests, play manually", async ({
  browser,
  browserName,
  playwright,
}) => {
  test.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  // The host keeps the project in IndexedDB. WebKit cannot store Blobs there in a temporary
  // context, so the host uses a profile on disk, as E2E-01 does.
  const profile = mkdtempSync(join(tmpdir(), "bgp-e2e-host-"));
  try {
    const host = await playwright[browserName].launchPersistentContext(profile, {
      viewport: { width: 1024, height: 768 },
    });
    contexts.push(host);
    const page = host.pages()[0] ?? (await host.newPage());
    const projectId = randomUUID();
    const slug = `harbor-sketch-${randomBytes(4).toString("hex")}`;
    await seedProject(page, sketch(projectId, slug));

    // E2E-02: signing in from the Publish section returns to it.
    await page.goto(`${WEB_URL}/projects/${projectId}/publish`);
    await expect(page.getByRole("heading", { name: "Sign in to publish" })).toBeVisible();
    await page.getByRole("main").getByRole("button", { name: "Sign in" }).click();
    await keycloakLogin(page, "designer2");
    await expect(page).toHaveURL(`${WEB_URL}/projects/${projectId}/publish`);
    await page.getByLabel("Who can play").selectOption("unlisted");
    const firstHash = await publish(page, "0.1.0");
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/);

    // AC-02: publishing the unchanged project again gives a new version with the same hash.
    const secondHash = await publish(page, "0.1.1");
    expect(secondHash).toBe(firstHash);

    // The game page lists both ready versions; the version page shows the hash.
    await page.getByRole("link", { name: "Create a match" }).click();
    await expect(page.getByRole("heading", { name: "Harbor Sketch", level: 1 })).toBeVisible();
    const versions = page.getByRole("list", { name: "Versions" }).getByRole("listitem");
    await expect(versions).toHaveCount(2);
    await expect(versions.filter({ hasText: "ready" })).toHaveCount(2);
    await page.getByRole("link", { name: "0.1.1" }).click();
    await expect(page.getByTestId("build-hash")).toHaveText(firstHash);

    // E2E-03: a 3-seat match; the host takes seat 1 and invites two guests.
    await page.getByLabel("Seats").selectOption("3");
    await page.getByRole("button", { name: "Create match" }).click();
    await expect(page.getByRole("heading", { name: "Lobby" })).toBeVisible();
    const matchId = /\/matches\/([^/]+)\/lobby$/.exec(page.url())?.[1] ?? "";
    await expect(page.getByRole("button", { name: "Start match" })).toBeDisabled();
    await page
      .getByRole("listitem", { name: "Invite for Seat 1" })
      .getByRole("button", { name: "Take this seat" })
      .click();
    await expect(page.getByRole("list", { name: "Seats" })).toContainText(
      "Seat 1 Designer Two (you)",
    );
    const inviteUrls = await Promise.all(
      ["1", "2"].map(
        async (seat) => (await page.getByTestId(`invite-${seat}`).textContent()) ?? "",
      ),
    );
    expect(inviteUrls.every((url) => url.startsWith(`${WEB_URL}/join/`))).toBe(true);

    const guests = [
      await joinAsGuest(browser, inviteUrls[0] ?? "", "Guest Tess"),
      await joinAsGuest(browser, inviteUrls[1] ?? "", "Guest Uma"),
    ];
    contexts.push(...guests.map((guest) => guest.context));
    await expect(page.getByRole("listitem", { name: "Invite for Seat 3" })).toContainText(
      "Taken by Guest Uma",
    );
    await page.getByRole("button", { name: "Start match" }).click();

    // Everyone lands at the table of the sandbox game.
    const pages = [page, ...guests.map((guest) => guest.page)];
    for (const player of pages) {
      await expect(player).toHaveURL(`${WEB_URL}/matches/${matchId}`, { timeout: 30_000 });
      await expect(hud(player).getByRole("listitem")).toHaveCount(3);
    }
    await everyoneSees(pages, 0);
    const [hostPage, tess, uma] = pages as [Page, Page, Page];

    // Deal (host): one card to each hand; each seat knows only its own.
    await selectItem(hostPage, "Card back, in Deck");
    await hostPage.getByRole("button", { name: "Deal 1 to each Hand" }).click();
    await everyoneSees(pages, 1);
    for (const player of pages) {
      await expect(hud(player).getByText("Hand 1")).toHaveCount(3);
      await expect
        .poll(
          async () =>
            (await tableItems(player)).filter((label) => /^(Fish|Salt), in Hand$/.test(label))
              .length,
          {
            timeout: 20_000,
          },
        )
        .toBe(1);
    }

    // Flip (Tess): the top card of the deck turns face up for everyone.
    await selectItem(tess, "Card back, in Deck");
    await tess.getByRole("button", { name: "Flip" }).click();
    await everyoneSees(pages, 2);
    for (const player of pages) {
      await expect
        .poll(
          async () =>
            (await tableItems(player)).some((label) => /^(Fish|Salt), in Deck$/.test(label)),
          {
            timeout: 20_000,
          },
        )
        .toBe(true);
    }

    // Shuffle (Uma): the deck is shuffled face down again for everyone.
    // A stack shows only its top card, which Tess just turned face up.
    await selectItem(uma, /^(Fish|Salt), in Deck/);
    await uma.getByRole("button", { name: "Shuffle Deck" }).click();
    await everyoneSees(pages, 3);

    // Roll (Tess): the die in the pool.
    await selectItem(tess, "Die, in Pool");
    await tess.getByRole("button", { name: "Roll" }).click();
    await everyoneSees(pages, 4);

    // Move (host): drag the die from the pool to the play area.
    await hostPage.mouse.move(...(await screenPoint(hostPage, "0", 0, 60)));
    await hostPage.mouse.down();
    await hostPage.mouse.move(...(await screenPoint(hostPage, "0", 200, 60)), { steps: 10 });
    await hostPage.mouse.up();
    await everyoneSees(pages, 5);
    for (const player of pages) {
      await expect
        .poll(async () => (await tableItems(player)).includes("Die, in Play area"), {
          timeout: 20_000,
        })
        .toBe(true);
    }
    for (const player of pages) {
      await expect(player.getByRole("alert")).toHaveCount(0);
    }
  } finally {
    for (const context of contexts) await context.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
