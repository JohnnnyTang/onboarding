import { expect, test } from "@playwright/test";

test("the browser test harness runs", async ({ page }) => {
  await page.setContent("<title>BGP scaffold</title><main>T01 test harness</main>");
  await expect(page).toHaveTitle("BGP scaffold");
  await expect(page.getByRole("main")).toHaveText("T01 test harness");
});
