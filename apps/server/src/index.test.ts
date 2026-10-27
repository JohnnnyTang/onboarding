import { expect, test } from "vitest";
import { authPlugin, createAuthService, createUserStore, requireMatchScope } from "./index.js";

test("the server exports the authentication integration points", () => {
  for (const entry of [authPlugin, createAuthService, createUserStore, requireMatchScope]) {
    expect(typeof entry).toBe("function");
  }
});
