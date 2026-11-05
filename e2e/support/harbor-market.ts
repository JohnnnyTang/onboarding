import { readFile } from "node:fs/promises";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import manifest from "../../games/harbor-market/bgp.json" with { type: "json" };
import declarations from "../../games/harbor-market/components.json" with { type: "json" };
import { ComponentsFileSchema, componentAssetRefs } from "../../packages/schema/src/index.js";
import { api, createEnforcedMatch, type FixtureMatch, WEB_URL } from "./app.js";

/** The Harbor Market bundle, built the way `bgp build` does: one ES module, no imports. */
async function harborBundle(): Promise<Buffer> {
  const built = await build({
    entryPoints: ["games/harbor-market/src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
  });
  const output = built.outputFiles[0];
  if (!output) throw new Error("Harbor Market bundle missing");
  return Buffer.from(output.contents);
}

/** Publishes Harbor Market with its committed card art (pnpm art:harbor) and creates a lobby match. */
export async function createHarborMatch(
  token: string,
  seatCount: number,
  options: { shortGame: boolean } = { shortGame: true },
): Promise<FixtureMatch> {
  const components = ComponentsFileSchema.parse(declarations);
  const files: Record<string, Buffer> = {
    "components.json": Buffer.from(JSON.stringify(components)),
    [manifest.entry]: await harborBundle(),
  };
  for (const ref of componentAssetRefs(components)) {
    files[ref] = await readFile(new URL(`../../games/harbor-market/${ref}`, import.meta.url));
  }
  return createEnforcedMatch(token, { name: "Harbor Market", manifest, files }, seatCount, options);
}

export async function startMatch(token: string, matchId: string): Promise<void> {
  await api(token, "POST", `/api/matches/${matchId}/start`, {});
}

export interface Player {
  seat: string;
  context: BrowserContext;
  page: Page;
}

/** A guest in a fresh browser context claims the seat's invite and waits in the lobby. */
export async function joinAsGuest(
  browser: Browser,
  match: FixtureMatch,
  seat: string,
  name: string,
  beforeJoin?: (page: Page) => Promise<void>,
): Promise<Player> {
  const invite = match.invites.find((entry) => entry.seat === seat);
  if (!invite) throw new Error(`Missing invite for seat ${seat}`);
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  await beforeJoin?.(page);
  await page.goto(invite.url);
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page).toHaveURL(`${WEB_URL}/matches/${match.matchId}/lobby`);
  return { seat, context, page };
}

export const prompt = (page: Page) => page.getByTestId("prompt");
export const canvas = (page: Page) => page.getByTestId("table").locator("canvas");

/** The seat's own hand zone label, as Harbor Market's `present` names it. */
const handLabel = (seat: string) => `Seat ${Number(seat) + 1} hand`;

interface Focused {
  caption: string;
  zone: string;
  selected: boolean;
}

async function focused(page: Page): Promise<Focused | null> {
  const label = (await canvas(page).getAttribute("aria-label")) ?? "";
  const match = /^Game table: (.+?), in (.+?)(?:, \d+ in stack)?(, selected)?$/.exec(label);
  if (!match?.[1] || !match[2]) return null;
  return { caption: match[1], zone: match[2], selected: match[3] !== undefined };
}

/**
 * Selects cards in the seat's own hand with the renderer's keyboard support: arrow keys move
 * the focus through every item on the table and the canvas label names the focused one.
 * `want` decides, card by card, whether to select it: null skips it, otherwise the list holds
 * the steps back to earlier cards to select with it. The walk ends when `done` says so.
 */
async function selectInHand(
  page: Page,
  seat: string,
  want: (card: Focused, seen: { caption: string; step: number }[], step: number) => number[] | null,
  done: (selected: number) => boolean,
): Promise<void> {
  await canvas(page).focus();
  const seen: { caption: string; step: number }[] = [];
  let selected = 0;
  for (let step = 0; step < 120 && !done(selected); step += 1) {
    await page.keyboard.press("ArrowLeft");
    const card = await focused(page);
    if (!card || card.zone !== handLabel(seat) || card.selected) continue;
    const backSteps = want(card, seen, step);
    seen.push({ caption: card.caption, step });
    if (backSteps === null) continue;
    await page.keyboard.press("Space");
    selected += 1;
    for (const back of backSteps) {
      // Walk forward to the earlier card, select it, and walk back to where we were.
      for (let i = 0; i < back; i += 1) await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Space");
      selected += 1;
      for (let i = 0; i < back; i += 1) await page.keyboard.press("ArrowLeft");
    }
  }
  if (!done(selected)) throw new Error("Could not select the cards");
}

/** Discards `count` cards: any cards in hand will do. */
export async function discard(page: Page, seat: string, count: number): Promise<void> {
  await selectInHand(
    page,
    seat,
    () => [],
    (selected) => selected >= count,
  );
  await page.getByRole("button", { name: "Discard selected" }).click();
}

/** Ships a pair of one good (a 6-card hand of 5 goods always holds one). */
export async function shipPair(page: Page, seat: string): Promise<void> {
  const good = (caption: string) => caption.split(" ")[0];
  await selectInHand(
    page,
    seat,
    (card, seen, step) => {
      const earlier = seen.find((entry) => good(entry.caption) === good(card.caption));
      return earlier ? [step - earlier.step] : null;
    },
    (selected) => selected >= 2,
  );
  await page.getByRole("button", { name: "Ship selected" }).click();
}
