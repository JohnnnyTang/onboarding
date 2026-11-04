import { expect, type Page, test } from "@playwright/test";
import { designerToken, WEB_URL } from "./support/app.js";
import {
  createHarborMatch,
  discard,
  joinAsGuest,
  type Player,
  prompt,
  shipPair,
  startMatch,
} from "./support/harbor-market.js";

// T14 done-when: E2E-04 and E2E-05 (docs/testing.md) with a Harbor Market version uploaded by
// the fixture script. Players act only through the page: action buttons and the table's
// keyboard selection.

const NAMES = ["Ann", "Bo", "Cy", "Di"];

async function seatAtTable(players: Player[], matchId: string): Promise<void> {
  for (const { page } of players) {
    await expect(page).toHaveURL(`${WEB_URL}/matches/${matchId}`);
    await expect(prompt(page)).toBeVisible();
  }
}

/** The player whose prompt says it may act, or null when every page shows the result. */
async function nextActor(players: Player[]): Promise<Player | null> {
  let actor: Player | null | undefined;
  await expect
    .poll(
      async () => {
        const texts = await Promise.all(players.map(({ page }) => prompt(page).textContent()));
        if (texts.every((text) => text === "Game over")) actor = null;
        else {
          const index = texts.findIndex(
            (text) => text?.startsWith("Your turn") || text?.startsWith("Discard"),
          );
          actor = index < 0 ? undefined : players[index];
        }
        return actor !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return actor ?? null;
}

/** One scripted move: restock while possible, discard down to six, ship a pair at the end. */
async function playTurn({ page, seat }: Player): Promise<void> {
  const before = await prompt(page).textContent();
  const discardMatch = /^Discard (\d+) cards$/.exec(before ?? "");
  if (discardMatch) await discard(page, seat, Number(discardMatch[1]));
  else {
    const restock = page.getByRole("button", { name: "Restock" });
    if (await restock.isEnabled()) await restock.click();
    else await shipPair(page, seat);
  }
  // Every accepted move changes this seat's prompt (next phase, next seat or game over).
  await expect(prompt(page)).not.toHaveText(before ?? "");
}

test("E2E-04: four seats play Harbor Market to the result screen", async ({ browser }) => {
  test.setTimeout(300_000);
  const token = await designerToken(browser, "designer2");
  const match = await createHarborMatch(token, 4);

  // Seat 1's first Restock is rewritten into Pass on the wire. The deck is not empty, so the
  // game rejects it with its own message; nothing in the app is involved in the trick.
  let rewritten = false;
  const players: Player[] = [];
  for (const [index, name] of NAMES.entries()) {
    players.push(
      await joinAsGuest(browser, match, String(index), name, async (page) => {
        if (index !== 0) return;
        await page.routeWebSocket(/\/ws$/, (socket) => {
          const server = socket.connectToServer();
          socket.onMessage((message) => {
            const frame = typeof message === "string" ? JSON.parse(message) : null;
            if (!rewritten && frame?.t === "move" && frame.intent?.move === "restock") {
              rewritten = true;
              server.send(JSON.stringify({ ...frame, intent: { move: "pass" } }));
              return;
            }
            server.send(message);
          });
        });
      }),
    );
  }
  await startMatch(token, match.matchId);
  await seatAtTable(players, match.matchId);

  const first = players[0];
  if (!first) throw new Error("No players");
  await expect(first.page.getByRole("heading", { name: "Harbor Market" })).toBeVisible();
  await expect(prompt(first.page)).toHaveText("Your turn: swap, ship or restock");
  await expect(prompt(players[1]?.page as Page)).toHaveText("Waiting for Seat 1");
  // Other seats' hands are face down: only counts reach this page.
  await expect(first.page.getByRole("list", { name: "Players" })).toContainText("Seat 2 · Bo");

  await first.page.getByRole("button", { name: "Restock" }).click();
  await expect(first.page.getByRole("alert")).toHaveText(/Another move is available\./);
  expect(rewritten).toBe(true);
  await expect(prompt(first.page)).toHaveText("Your turn: swap, ship or restock");

  let moves = 0;
  for (let actor = await nextActor(players); actor; actor = await nextActor(players)) {
    await playTurn(actor);
    moves += 1;
    expect(moves).toBeLessThan(200);
  }
  expect(moves).toBeGreaterThan(4);

  for (const { page } of players) {
    const result = page.getByRole("region", { name: "Result" });
    await expect(result).toBeVisible();
    await expect(result).toContainText(/Winners?: Seat \d · \w+|You won!/);
    await expect(result.getByRole("row")).toHaveCount(5);
    await expect(page.getByRole("button", { name: "Restock" })).toHaveCount(0);
  }
  for (const { context } of players) await context.close();
});

test("E2E-05: a reload mid-match returns to the same seat and view within 3 seconds", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const token = await designerToken(browser, "designer2");
  const match = await createHarborMatch(token, 2);
  const players = [
    await joinAsGuest(browser, match, "0", "Ann"),
    await joinAsGuest(browser, match, "1", "Bo"),
  ];
  await startMatch(token, match.matchId);
  await seatAtTable(players, match.matchId);
  const [ann, bo] = players as [Player, Player];

  // Seat 1 restocks, so seat 2 is to play when it reloads.
  await ann.page.getByRole("button", { name: "Restock" }).click();
  await expect(prompt(bo.page)).toHaveText("Your turn: swap, ship or restock");
  const hud = bo.page.getByRole("list", { name: "Players" });
  const hudBefore = await hud.textContent();
  expect(hudBefore).toContain("Seat 2 · Bo (you)");

  // AC-06 is measured against the production build that playwright.config.ts serves.
  const started = Date.now();
  await bo.page.reload();
  await expect(prompt(bo.page)).toHaveText("Your turn: swap, ship or restock", { timeout: 3_000 });
  await expect(hud).toHaveText(hudBefore ?? "", { timeout: 3_000 });
  await expect(bo.page.getByTestId("table").locator("canvas")).toBeVisible({ timeout: 3_000 });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(3_000);
  await expect(bo.page.getByText("You are playing Seat 2.")).toBeVisible();

  // The seat still plays after the reload.
  await bo.page.getByRole("button", { name: "Restock" }).click();
  await expect(prompt(ann.page)).toHaveText(/^(Your turn|Discard)/);
  await expect(prompt(bo.page)).toHaveText(/^(Waiting for Seat 1|Discard)/);
  for (const { context } of players) await context.close();
});
