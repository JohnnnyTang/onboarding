import { expect, test } from "vitest";
import * as scaffold from "./index.js";

test("game errors expose a fixed safe code and message", () => {
  expect(new scaffold.GameError()).toMatchObject({
    code: "GAME_ERROR",
    message: "Game execution failed",
  });
});

test("the public API exposes supervision instead of in-process game evaluation", () => {
  expect(scaffold.RulesHostClient).toBeTypeOf("function");
  expect(scaffold).not.toHaveProperty("QuickJsSandbox");
});
