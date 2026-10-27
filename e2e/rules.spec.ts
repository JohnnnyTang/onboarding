import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";
import ts from "typescript";
import {
  type AcceptedEvent,
  applyIntent,
  createMatch,
  type GameResult,
  hashState,
  type MatchInit,
} from "../packages/rules/src/index.js";
import { randomGame } from "../packages/rules/test/random-game.js";

// Serve actual ESM outputs and existing dependency files through Playwright's
// request routing, with no development server or additional bundler dependency.
const ORIGIN = "http://localhost:41739";
const ROOTS: Record<string, string> = {
  src: resolve("packages/rules/dist"),
  schema: resolve("packages/schema/dist"),
  zod: resolve("packages/schema/node_modules/zod"),
  immer: resolve("packages/rules/node_modules/immer"),
  test: resolve("packages/rules/test"),
};

test("Node and browsers produce identical canonical hashes, random moves and replays", async ({
  page,
}) => {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") {
      await route.fulfill({
        contentType: "text/html",
        body: `<script type="importmap">{"imports":{"@bgp/schema":"/schema/index.js","immer":"/immer/dist/immer.production.mjs","zod":"/zod/index.js"}}</script>`,
      });
      return;
    }
    const [, area, ...parts] = pathname.split("/");
    const root = ROOTS[area ?? ""];
    if (!root || !/\.(js|mjs)$/.test(pathname)) {
      await route.abort();
      return;
    }
    const suffix = parts.join("/");
    const file = resolve(root, area === "test" ? suffix.replace(/\.js$/, ".ts") : suffix);
    if (!file.startsWith(`${root}${sep}`)) throw new Error("Module path escaped test root");
    const source = await readFile(file, "utf8");
    const body =
      area === "test"
        ? ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
          }).outputText
        : source;
    await route.fulfill({ contentType: "text/javascript", body });
  });
  const init = {
    seats: ["0", "1"],
    seed: 0xffff_ffff,
    options: { unicode: "雪 😀", "10": 10, "2": 2 },
  };
  let state = createMatch(randomGame, init);
  const hashes = [await hashState(state)];
  const events: AcceptedEvent[] = [];
  for (let step = 0; step < 20; step += 1) {
    const result = applyIntent(randomGame, state, state.ctx.currentSeat, { move: "draw" });
    if (!result.ok) throw new Error(result.code);
    state = result.state;
    events.push(result.event);
    hashes.push(await hashState(state));
  }
  await page.goto(ORIGIN);
  const output = await page.evaluate(async (payload) => {
    const { init, events }: { init: MatchInit; events: AcceptedEvent[] } = JSON.parse(payload);
    const runtimePath = "/src/index.js";
    const randomPath = "/test/random-game.js";
    const boardPath = "/test/tic-tac-toe.js";
    const runtime: typeof import("../packages/rules/src/index.js") = await import(runtimePath);
    const { randomGame }: typeof import("../packages/rules/test/random-game.js") = await import(
      randomPath
    );
    const { ticTacToe }: typeof import("../packages/rules/test/tic-tac-toe.js") = await import(
      boardPath
    );
    let state = runtime.createMatch(randomGame, init);
    const hashes = [await runtime.hashState(state)];
    const replayHashes = [...hashes];
    for (const event of events) {
      const rejected = runtime.applyIntent(randomGame, state, state.ctx.currentSeat, {
        move: "reject",
      });
      if (rejected.ok || rejected.code !== "INVALID_MOVE") throw new Error("Rollback failed");
      const result = runtime.applyIntent(randomGame, state, event.seat, event.intent);
      if (!result.ok) throw new Error(result.code);
      state = result.state;
      hashes.push(await runtime.hashState(state));
      replayHashes.push(
        await runtime.hashState(runtime.replay(randomGame, init, events.slice(0, event.seq))),
      );
    }
    const boardInit = { seats: ["0", "1"], seed: 0, options: {} };
    let board = runtime.createMatch(ticTacToe, boardInit);
    for (const args of [0, 3, 1, 4, 2]) {
      const result = runtime.applyIntent(ticTacToe, board, board.ctx.currentSeat, {
        move: "place",
        args,
      });
      if (!result.ok) throw new Error(result.code);
      board = result.state;
    }
    return JSON.stringify({ hashes, replayHashes, state, boardResult: board.result });
  }, JSON.stringify({ init, events }));
  const browser: {
    hashes: string[];
    replayHashes: string[];
    state: unknown;
    boardResult: GameResult | null;
  } = JSON.parse(output);
  expect(browser.hashes).toEqual(hashes);
  expect(browser.replayHashes).toEqual(hashes);
  expect(browser.state).toEqual(state);
  expect(browser.boardResult?.winners).toEqual(["0"]);
});
