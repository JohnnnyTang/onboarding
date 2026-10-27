import { expect, test } from "vitest";
import { MoveParseContextSchema } from "./rules.js";

test("parse context requires integer JSON and a participating seat", () => {
  const context = {
    state: { count: 0 },
    ctx: {
      seats: ["0", "1"],
      currentSeat: "0",
      activeSeats: ["0"],
      phase: "main",
      turn: 1,
      moveNumber: 0,
      options: {},
    },
    seat: "1",
  };
  expect(MoveParseContextSchema.safeParse(context).success).toBe(true);
  expect(MoveParseContextSchema.safeParse({ ...context, state: { count: 0.5 } }).success).toBe(
    false,
  );
  expect(MoveParseContextSchema.safeParse({ ...context, seat: "2" }).success).toBe(false);
});
