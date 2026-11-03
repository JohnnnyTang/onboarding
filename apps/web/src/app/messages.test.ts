import { describe, expect, test } from "vitest";
import { ApiError, UnexpectedResponseError } from "../api/client";
import { errorMessage, seatLabel, shouldRetry } from "./messages";

describe("messages", () => {
  test("seat labels count from one", () => {
    expect(seatLabel("0")).toBe("Seat 1");
    expect(seatLabel("7")).toBe("Seat 8");
  });

  test("errors map to readable text", () => {
    expect(errorMessage(new ApiError(409, "CONFLICT", "This seat is already taken"))).toBe(
      "This seat is already taken",
    );
    expect(errorMessage(new ApiError(401, "UNAUTHORIZED", "Missing token"))).toMatch(/Sign in/);
    expect(errorMessage(new ApiError(403, "FORBIDDEN", "Forbidden"))).toMatch(/access/);
    expect(errorMessage(new UnexpectedResponseError(502, "GET /api/games"))).toMatch(/unexpected/);
    expect(errorMessage(new TypeError("Failed to fetch"))).toMatch(/reach the server/);
  });

  test("only transient failures are retried", () => {
    expect(shouldRetry(0, new ApiError(404, "NOT_FOUND", "Missing"))).toBe(false);
    expect(shouldRetry(0, new ApiError(401, "UNAUTHORIZED", "Missing"))).toBe(false);
    expect(shouldRetry(0, new UnexpectedResponseError(200, "GET /api/games"))).toBe(false);
    expect(shouldRetry(0, new ApiError(500, "INTERNAL", "Oops"))).toBe(true);
    expect(shouldRetry(1, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(2, new TypeError("Failed to fetch"))).toBe(false);
  });
});
