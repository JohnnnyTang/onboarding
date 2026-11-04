import { expect, test } from "@playwright/test";
import {
  createSandboxMatch,
  designerToken,
  keycloakLogin,
  WEB_URL,
  webStorage,
} from "./support/app.js";

// T12 done-when: designer1 signs in and sees an empty games list; a guest claims an invite and
// reaches the lobby. The app servers use a test database where designer1 owns no games.

test("designer1 signs in and sees an empty games list", async ({ page }) => {
  await page.goto(`${WEB_URL}/games`);
  await expect(page.getByText("Sign in to see your games")).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  await keycloakLogin(page, "designer1");

  // Back on the page sign-in started from, with the code removed from the URL.
  await expect(page).toHaveURL(`${WEB_URL}/games`);
  await expect(page.getByRole("banner").getByText("Designer One")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Games", level: 1 })).toBeVisible();
  // The empty state appears only after GET /api/games accepted the access token.
  await expect(page.getByRole("heading", { name: "No games yet" })).toBeVisible();

  await page.getByRole("link", { name: "Matches" }).click();
  await expect(page.getByRole("heading", { name: "Matches", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No matches yet" })).toBeVisible();

  // Tokens stay in memory (D-007): nothing token-like in web storage or cookies.
  const stored = await webStorage(page);
  expect(stored).not.toMatch(/eyJ|access_token|refresh_token|id_token/);
});

test("a guest claims an invite and reaches the lobby", async ({ browser }) => {
  const token = await designerToken(browser, "designer2");
  const { matchId, invites } = await createSandboxMatch(token, 2);
  const invite = invites.find((entry) => entry.seat === "0");
  if (!invite) throw new Error("Missing invite for seat 0");
  expect(new URL(invite.url).origin).toBe(WEB_URL);

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(invite.url);
  await expect(page.getByRole("heading", { name: "Join a match" })).toBeVisible();
  await page.getByLabel("Display name").fill("Guest Tess");
  await page.getByRole("button", { name: "Join" }).click();

  await expect(page).toHaveURL(`${WEB_URL}/matches/${matchId}/lobby`);
  await expect(page.getByRole("heading", { name: "Lobby" })).toBeVisible();
  await expect(page.getByText("Waiting for the host to start the match.")).toBeVisible();
  const seats = page.getByRole("list", { name: "Seats" }).getByRole("listitem");
  await expect(seats).toHaveCount(2);
  await expect(seats.nth(0)).toContainText("Seat 1 Guest Tess (you)");
  await expect(seats.nth(0)).toContainText("Guest");
  await expect(seats.nth(1)).toContainText("Seat 2 Open");

  // The guest seat is kept for this tab only (Q-018): session storage, never local storage or
  // cookies.
  const persistent = await page.evaluate(() =>
    JSON.stringify([Object.entries(localStorage), document.cookie]),
  );
  expect(persistent).not.toMatch(/eyJ|guestToken/);
  expect(await page.evaluate(() => sessionStorage.getItem("bgp.claimedSeats"))).toContain(
    '"seat":"0"',
  );

  // The invite is single-use: a second guest is turned away with the server's message.
  const other = await context.browser()?.newContext();
  if (!other) throw new Error("No browser");
  const second = await other.newPage();
  await second.goto(invite.url);
  await second.getByLabel("Display name").fill("Guest Uma");
  await second.getByRole("button", { name: "Join" }).click();
  await expect(second.getByRole("alert")).toHaveText("This seat is already taken");
  await other.close();
  await context.close();
});
