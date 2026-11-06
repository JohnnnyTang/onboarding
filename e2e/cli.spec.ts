import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { API_URL, api, designerToken, keycloakLogin } from "./support/app.js";

// E2E-07 (AC-13): the developer path in a temporary directory, with the built CLI against the
// local server: bgp init, validate, build, dev (hot-seat table with hot reload) and publish
// (device sign-in in a browser, then the upload flow). designer2 publishes: designer1 must own
// no games for web-app.spec.ts.

const BIN = fileURLToPath(new URL("../packages/cli/dist/bin.js", import.meta.url));
const run = promisify(execFile);

function bgp(args: string[], env: Record<string, string> = {}) {
  return run(process.execPath, [BIN, ...args], {
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
}

/** Starts a long-running bgp command and collects its output. */
function start(args: string[]) {
  const child: ChildProcess = spawn(process.execPath, [BIN, ...args], { env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    child,
    exited,
    output: () => stdout,
    errors: () => stderr,
    /** Resolves with the first capture of `pattern` once the output contains it. */
    async waitFor(pattern: RegExp, timeout = 60_000): Promise<string> {
      let found = "";
      await expect
        .poll(
          () => {
            found = pattern.exec(stdout)?.[1] ?? "";
            return found;
          },
          { timeout, message: `bgp output: ${stdout}\n${stderr}` },
        )
        .not.toBe("");
      return found;
    },
  };
}

const table = (page: Page) => page.getByTestId("table").locator("canvas");

/** A temporary directory and a fresh game id. */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "bgp-e2e-cli-"));
  const slug = `e2e-cli-${randomBytes(4).toString("hex")}`;
  return { root, slug, dir: join(root, slug) };
}

/** Selects the first card in a hand zone with the keyboard, then plays it. */
async function playFromHand(page: Page, handLabel: string) {
  await expect(async () => {
    await table(page).focus();
    for (let step = 0; step < 20; step += 1) {
      await page.keyboard.press("ArrowRight");
      const label = (await table(page).getAttribute("aria-label")) ?? "";
      if (new RegExp(`^Game table: Card \\d, in ${handLabel}`).test(label)) {
        await page.keyboard.press("Space");
        await expect(table(page)).toHaveAttribute("aria-label", /, selected$/, { timeout: 2000 });
        return;
      }
    }
    throw new Error(`No card in ${handLabel}`);
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: "Play selected" }).click();
}

test("E2E-07: bgp init, validate, build and publish a new game package", async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "The CLI and sign-in do not depend on the browser engine");
  test.setTimeout(300_000);
  const { root, slug, dir } = await workspace();
  const running: ReturnType<typeof start>[] = [];
  try {
    // bgp init: a starter package that validates as it is.
    const init = await bgp(["init", dir, "--name", "CLI Duel"]);
    expect(init.stdout).toContain(`Created CLI Duel (${slug})`);

    const validated = await bgp(["validate", dir, "--games", "6"]);
    expect(validated.stdout).toContain("Validation passed.");
    expect(validated.stdout).toMatch(/Played 6 random games \(\d+ moves, 6 finished\)/);

    const built = await bgp(["build", dir]);
    expect(built.stdout).toMatch(/^Built dist\/game\.js/);
    expect((await stat(join(dir, "dist", "game.js"))).size).toBeGreaterThan(0);

    // bgp publish: device sign-in in a browser, then the upload flow.
    const publish = start(["publish", dir, "--visibility", "unlisted"]);
    running.push(publish);
    const signIn = await publish.waitFor(/Or open (\S+)/);
    const login = await browser.newContext();
    const loginPage = await login.newPage();
    await loginPage.goto(signIn);
    await keycloakLogin(loginPage, "designer2");
    // Keycloak asks the designer to grant the CLI access, naming the client.
    await expect(
      loginPage.getByRole("heading", { name: /Grant Access to Board Game Platform CLI/ }),
    ).toBeVisible();
    await loginPage.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(publish.exited).resolves.toBeDefined();
    await login.close();
    expect(await publish.exited, publish.errors()).toBe(0);
    const out = publish.output();
    expect(out).toContain(`Published ${slug} 0.1.0.`);
    const versionId = /Version: (\S+)/.exec(out)?.[1] ?? "";
    const buildHash = /Build hash: ([0-9a-f]{64})/.exec(out)?.[1] ?? "";
    expect(out).toContain(`/versions/${versionId}`);
    expect(out).not.toMatch(/eyJ[\w-]+\.[\w-]+/);

    // The version is ready on the server with that build hash.
    const token = await designerToken(browser, "designer2");
    const version = (await api(token, "GET", `/api/versions/${versionId}`)) as {
      status: string;
      buildHash: string;
      manifest: { id: string };
    };
    expect(version).toMatchObject({ status: "ready", buildHash, manifest: { id: slug } });

    // Re-publishing identical files (signed in with BGP_TOKEN) changes nothing.
    const again = await bgp(["publish", dir, "--api", API_URL], { BGP_TOKEN: token });
    expect(again.stdout).toContain("Version 0.1.0 is already published with these files.");
    expect(again.stdout).toContain(`Build hash: ${buildHash}`);
  } finally {
    for (const process of running) process.child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("E2E-07: bgp dev serves a hot-seat table that reloads and replays on every change", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { root, slug, dir } = await workspace();
  const running: ReturnType<typeof start>[] = [];
  try {
    await bgp(["init", dir, "--name", "CLI Duel"]);
    // bgp dev: the web app's hot-seat page loads the game; a change reloads it and the
    // current game replays.
    const dev = start(["dev", dir, "--port", "0"]);
    running.push(dev);
    const pageUrl = await dev.waitFor(/Open the hot-seat table: (\S+)/);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(pageUrl);
    await expect(page.getByRole("heading", { name: "CLI Duel: bgp dev" })).toBeVisible();
    await expect(page.getByText(`Build 0 of ${slug} 0.1.0`)).toBeVisible();
    await expect(page.getByText("Your turn: play a card on the pile")).toBeVisible();
    await playFromHand(page, "Seat 1");
    await expect(page.getByText("1 move so far")).toBeVisible();

    const tableSource = join(dir, "src", "table.ts");
    const source = await readFile(tableSource, "utf8");
    await writeFile(
      tableSource,
      source.replace('"Your turn: play a card on the pile"', '"Your turn: beat the pile"'),
    );
    await expect(page.getByText(/^Build [1-9]\d* of /)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("1 move so far")).toBeVisible();
    await page.getByRole("button", { name: "Seat 2", exact: true }).click();
    await expect(page.getByText("Your turn: beat the pile")).toBeVisible();

    // A broken build keeps the table and lists the error.
    await writeFile(tableSource, `${source}\nconst broken = ;\n`);
    await expect(page.getByRole("alert")).toContainText(/failed; the table still runs build/);
    await expect(page.getByText("1 move so far")).toBeVisible();
    await writeFile(tableSource, source);
    await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 30_000 });
    await context.close();
  } finally {
    for (const process of running) process.child.kill();
    await rm(root, { recursive: true, force: true });
  }
});
