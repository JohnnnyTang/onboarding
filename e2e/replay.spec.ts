import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  type ClientView,
  type MoveIntent,
  ReplayResponseSchema,
} from "../packages/schema/src/index.js";
import {
  API_URL,
  api,
  createSandboxMatch,
  designerToken,
  type FixtureMatch,
  WEB_URL,
} from "./support/app.js";
import { createHarborMatch, startMatch } from "./support/harbor-market.js";
import { ScriptedSeat } from "./support/scripted-seat.js";

// T18 done-when: E2E-06 (docs/testing.md). A Harbor Market match is recorded by scripted
// seats through the real room server, so the rules host (QuickJS) computes and stores its
// final hash. Each browser then replays it in the game worker on the replay page and must
// reach the same hash. The match is padded with swaps to about 300 events, and stepping
// through all of them is timed.

const SEATS = 3;
/** Swaps before playing to the end; a full 3-seat game adds about 20 events. */
const SWAPS = 280;
/** The room accepts at most 10 moves per second per connection (protocol.md). */
const MOVE_INTERVAL_MS = 110;

type Card = { id: string; good: string };
type HarborView = { hand: Card[]; deckCount: number; market: Card[] };

/** A seat that decides from its own view only, like a browser would. */
function botMove(view: ClientView, swap: boolean): MoveIntent {
  const game = view.game as HarborView;
  const [hand] = game.hand;
  const [market] = game.market;
  if (view.ctx.phase === "discard") {
    const cards = game.hand.slice(0, game.hand.length - 6).map((card) => card.id);
    return { move: "discard", args: { cards } };
  }
  if (swap && hand && market) return { move: "swap", args: { hand: hand.id, market: market.id } };
  const goods = new Map<string, string[]>();
  for (const card of game.hand) goods.set(card.good, [...(goods.get(card.good) ?? []), card.id]);
  const set = [...goods.values()].find((ids) => ids.length >= 2);
  if (set) return { move: "ship", args: { cards: set } };
  if (game.deckCount > 0) return { move: "restock" };
  if (hand && market) return { move: "swap", args: { hand: hand.id, market: market.id } };
  return { move: "pass" };
}

interface Recorded {
  matchId: string;
  guest: { seat: string; token: string };
  events: number;
}

/** Claims every invite of a lobby match as a guest, in seat order. */
async function claimSeats(match: FixtureMatch): Promise<{ seat: string; token: string }[]> {
  const guests: { seat: string; token: string }[] = [];
  for (const invite of match.invites) {
    const inviteToken = new URL(invite.url).pathname.split("/").at(-1) ?? "";
    const response = await fetch(`${API_URL}/api/invites/${inviteToken}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: `Bot ${Number(invite.seat) + 1}` }),
    });
    const claimed = (await response.json()) as { seat: string; guestToken?: string };
    if (!claimed.guestToken) throw new Error("Missing guest token");
    guests.push({ seat: claimed.seat, token: claimed.guestToken });
  }
  return guests;
}

/** Opens a browser tab holding a guest's seat, as the invite page keeps it (Q-018). */
async function guestPage(
  browser: Browser,
  matchId: string,
  guest: { seat: string; token: string },
) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(
    ({ origin, seat }) => {
      if (location.origin !== origin) return;
      sessionStorage.setItem("bgp.claimedSeats", JSON.stringify([seat]));
    },
    {
      origin: WEB_URL,
      seat: {
        matchId,
        seat: guest.seat,
        displayName: `Bot ${Number(guest.seat) + 1}`,
        guestToken: guest.token,
      },
    },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

/** Publishes Harbor Market, seats three guests and plays the match to the end over WebSockets. */
async function recordMatch(token: string): Promise<Recorded> {
  const match = await createHarborMatch(token, SEATS, { shortGame: false });
  const guests = await claimSeats(match);
  await startMatch(token, match.matchId);
  const url = `${API_URL.replace(/^http/, "ws")}/ws`;
  const seats = await Promise.all(
    guests.map((guest) => ScriptedSeat.connect(url, match.matchId, guest.token)),
  );
  try {
    const [watcher] = seats;
    if (!watcher) throw new Error("No seats");
    const lastMove = new Map<ScriptedSeat, number>();
    let seq = 0;
    for (;;) {
      const table = await watcher.currentView();
      if (table.result !== null) break;
      if (seq > SWAPS + 200) throw new Error("Harbor Market did not finish");
      const mover = seats[guests.findIndex((guest) => guest.seat === table.ctx.currentSeat)];
      if (!mover) throw new Error("No seat to move");
      const view = await mover.currentView();
      const wait = (lastMove.get(mover) ?? 0) + MOVE_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastMove.set(mover, Date.now());
      mover.move(botMove(view, seq < SWAPS));
      seq += 1;
      await Promise.all(seats.map((seat) => seat.until(() => seat.seq >= seq)));
    }
    const [first] = guests;
    if (!first) throw new Error("No guests");
    return { matchId: match.matchId, guest: first, events: seq };
  } finally {
    for (const seat of seats) seat.close();
  }
}

/** Clicks Forward through every step and times each until the page shows it. */
function stepThrough(page: Page, steps: number): Promise<number[]> {
  return page.evaluate(async (count) => {
    const label = document.querySelector<HTMLElement>('[data-testid="replay-step"]');
    const forward = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Forward",
    );
    if (!label || !forward) throw new Error("Step controls missing");
    const shown = (seq: number) =>
      new Promise<void>((resolve) => {
        if (label.dataset.shown === String(seq)) return resolve();
        const observer = new MutationObserver(() => {
          if (label.dataset.shown !== String(seq)) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(label, { attributes: true });
      });
    const times: number[] = [];
    for (let seq = 1; seq <= count; seq += 1) {
      const start = performance.now();
      forward.click();
      await shown(seq);
      // The table draws the new snapshot on the next frame.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      times.push(performance.now() - start);
    }
    return times;
  }, steps);
}

test("E2E-06: the game worker replays a recorded match to the rules host's final hash", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const token = await designerToken(browser, "designer2");
  const recorded = await recordMatch(token);
  expect(recorded.events).toBeGreaterThanOrEqual(SWAPS + 10);
  const replay = ReplayResponseSchema.parse(
    await api(token, "GET", `/api/matches/${recorded.matchId}/replay`),
  );
  expect(replay.events).toHaveLength(recorded.events);

  const { context, page, errors } = await guestPage(browser, recorded.matchId, recorded.guest);
  await page.goto(`${WEB_URL}/matches/${recorded.matchId}/replay`);

  const check = page.getByTestId("hash-check");
  await expect(check).toContainText("matches the server's");
  await expect(check).toHaveAttribute("data-hash", replay.finalHash);
  const step = page.getByTestId("replay-step");
  await expect(step).toHaveAttribute("data-shown", "0");
  await expect(step).toContainText(`Move 0 of ${recorded.events} · Setup`);
  await expect(page.getByTestId("table").locator("canvas")).toBeVisible();

  const times = await stepThrough(page, recorded.events);
  const sorted = [...times].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? Number.POSITIVE_INFINITY;
  const worst = sorted.at(-1) ?? Number.POSITIVE_INFINITY;
  test.info().annotations.push({
    type: "step timing",
    description: `${times.length} steps: p50 ${sorted[Math.floor(sorted.length / 2)]?.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${worst.toFixed(1)} ms`,
  });
  console.log(test.info().annotations.at(-1)?.description);
  // Locally p95 is 15–80 ms depending on the engine; the bound leaves room for a busy CI host.
  expect(p95).toBeLessThan(150);
  expect(worst).toBeLessThan(500);

  // The last step shows the result; jumping and switching perspective keep up.
  await expect(page.getByRole("region", { name: "Result" })).toBeVisible();
  await page.getByRole("button", { name: "All seats" }).click();
  await expect(step).toHaveAttribute("data-shown", String(recorded.events));
  await page.getByRole("button", { name: "Setup" }).click();
  await expect(step).toHaveAttribute("data-shown", "0");
  await page.getByRole("button", { name: "Seat 2", exact: true }).click();
  await page.getByRole("slider", { name: "Step" }).focus();
  await page.keyboard.press("End");
  await expect(step).toHaveAttribute("data-shown", String(recorded.events));
  await expect(page.getByRole("region", { name: "Result" })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("Q-026: a guest ends a sandbox match from the table, and its replay checks out", async ({
  browser,
}) => {
  const token = await designerToken(browser, "designer2");
  const match = await createSandboxMatch(token, 2);
  const [me, other] = await claimSeats(match);
  if (!me || !other) throw new Error("Missing guests");
  await startMatch(token, match.matchId);
  const url = `${API_URL.replace(/^http/, "ws")}/ws`;
  const bot = await ScriptedSeat.connect(url, match.matchId, other.token);
  const { context, page, errors } = await guestPage(browser, match.matchId, me);
  try {
    // The other seat shuffles the public deck and passes the turn.
    bot.move({ move: "manual", args: { op: "shuffle", zone: "deck" } });
    await bot.until(() => bot.seq >= 1);
    bot.move({ move: "manual", args: { op: "endTurn" } });
    await bot.until(() => bot.seq >= 2);

    await page.goto(`${WEB_URL}/matches/${match.matchId}`);
    await expect(page.getByTestId("move-count")).toHaveText("2 moves so far");
    await page.getByRole("button", { name: "End game" }).click();
    const confirm = page.getByRole("alertdialog", { name: "End game" });
    await expect(confirm).toContainText("End the game for everyone? This cannot be undone.");
    // Cancel keeps playing; confirming ends the match for everyone.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId("move-count")).toHaveText("2 moves so far");
    await page.getByRole("button", { name: "End game" }).click();
    await confirm.getByRole("button", { name: "End game" }).click();
    const result = page.getByRole("region", { name: "Result" });
    await expect(result).toContainText("Nobody won.");
    await expect(result).toContainText("Ended by Seat 1");
    await bot.until(() => bot.result !== null);
    expect(bot.result).toEqual({ winners: [], reason: "Ended by Seat 1" });

    const replay = ReplayResponseSchema.parse(
      await api(token, "GET", `/api/matches/${match.matchId}/replay`),
    );
    expect(replay.events.map((event) => [event.seat, event.intent.args])).toEqual([
      ["1", { op: "shuffle", zone: "deck" }],
      ["1", { op: "endTurn" }],
      ["0", { op: "endGame" }],
    ]);
    await page.getByRole("link", { name: "Watch the replay" }).click();
    await expect(page).toHaveURL(`${WEB_URL}/matches/${match.matchId}/replay`);
    const check = page.getByTestId("hash-check");
    await expect(check).toHaveAttribute("data-hash", replay.finalHash);
    await page.getByRole("button", { name: "End", exact: true }).click();
    const step = page.getByTestId("replay-step");
    await expect(step).toHaveAttribute("data-shown", "3");
    await expect(step).toContainText("Move 3 of 3 · Seat 1 · Bot 1: endGame");
    await expect(page.getByRole("region", { name: "Result" })).toContainText("Ended by Seat 1");
    expect(errors).toEqual([]);
  } finally {
    bot.close();
    await context.close();
  }
});
