import { expect, test } from "vitest";
import * as scaffold from "./index.js";

test("the package scaffold loads", () => {
  expect(Object.keys(scaffold)).toEqual([]);
});
