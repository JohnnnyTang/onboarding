import { describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./database.js";

describe("integration database safety", () => {
  it("defaults to the separate local test database", () => {
    expect(new URL(testDatabaseUrl({})).pathname).toBe("/bgp_test");
  });
  it.each([
    { TEST_DATABASE_URL: "postgres://bgp:bgp@localhost:5432/bgp" },
    {
      TEST_DATABASE_URL: "postgres://bgp:bgp@localhost:5432/bgp_test",
      DATABASE_URL: "postgresql://other:secret@localhost/bgp_test",
    },
    { TEST_DATABASE_URL: "https://localhost/bgp_test" },
  ])("refuses a development database or non-PostgreSQL URL", (env) => {
    expect(() => testDatabaseUrl(env)).toThrow("separate PostgreSQL database");
  });
});
