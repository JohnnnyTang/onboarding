import { expect, test } from "@playwright/test";
import { GAME_WORKER_POLICY } from "../apps/web/src/security/content-security-policy.js";
import { designerToken, WEB_URL } from "./support/app.js";
import { recordViolations, violations } from "./support/csp.js";
import {
  canvas,
  createHarborMatch,
  joinAsGuest,
  type Player,
  prompt,
  startMatch,
} from "./support/harbor-market.js";

// T20: the web app's content security policy (Q-018, Q-020, Q-030). Every app test runs on
// the production build under this policy, so a blocked resource breaks those flows; this
// spec checks how the policy is delivered and that a remote Harbor Market match (table,
// game worker, card art, room server) raises no violation at all.

test("the web app sends its policy in a header and a meta tag", async ({ request }) => {
  const response = await request.get(`${WEB_URL}/`);
  const header = response.headers()["content-security-policy"] ?? "";
  expect(header).toContain("script-src 'self' blob:");
  expect(header).toContain("worker-src 'self' blob:");
  expect(header).toContain("frame-ancestors 'none'");
  for (const origin of ["http://localhost:3000", "ws://localhost:3000", "http://localhost:8080"]) {
    expect(header).toContain(` ${origin} `);
  }
  expect(header).not.toMatch(/unsafe-inline|unsafe-eval/);
  const html = await response.text();
  expect(html).toMatch(/<meta charset="utf-8" \/>\s*<meta http-equiv="Content-Security-Policy"/);
});

test("a remote Harbor Market match runs under the policy without violations", async ({
  browser,
}) => {
  const token = await designerToken(browser, "designer2");
  const match = await createHarborMatch(token, 2);
  const workerPolicies: string[] = [];
  const players: Player[] = [];
  for (const [seat, name] of [
    ["0", "Ann"],
    ["1", "Bo"],
  ] as const) {
    players.push(
      await joinAsGuest(browser, match, seat, name, async (page) => {
        await recordViolations(page);
        page.on("response", (response) => {
          if (/\/assets\/game-worker-[^/]+\.js$/.test(response.url())) {
            workerPolicies.push(response.headers()["content-security-policy"] ?? "");
          }
        });
      }),
    );
  }
  try {
    await startMatch(token, match.matchId);
    for (const { page } of players) {
      await expect(page).toHaveURL(`${WEB_URL}/matches/${match.matchId}`);
      await expect(prompt(page)).toBeVisible();
      await expect(canvas(page)).toBeVisible();
    }
    // One move through the game worker and the room server.
    const texts = await Promise.all(players.map(({ page }) => prompt(page).textContent()));
    const actor = players[texts.findIndex((text) => text?.startsWith("Your turn"))];
    if (!actor) throw new Error("Nobody may act");
    const before = await prompt(actor.page).textContent();
    await actor.page.getByRole("button", { name: "Restock" }).click();
    await expect(prompt(actor.page)).not.toHaveText(before ?? "");

    expect(workerPolicies.length).toBeGreaterThan(0);
    expect(new Set(workerPolicies)).toEqual(new Set([GAME_WORKER_POLICY]));
    for (const { context } of players) expect(await violations(context)).toEqual([]);
  } finally {
    for (const { context } of players) await context.close();
  }
});
