import { describe, expect, test } from "vitest";
import { e2eDatabaseUrl, perfDatabaseUrl } from "./e2e-database.js";

describe("end-to-end database", () => {
  test("defaults to bgp_e2e on the development database server", () => {
    expect(e2eDatabaseUrl({})).toBe("postgres://bgp:bgp@localhost:5432/bgp_e2e");
    expect(e2eDatabaseUrl({ DATABASE_URL: "postgres://u:p@db.local:15432/bgp" })).toBe(
      "postgres://u:p@db.local:15432/bgp_e2e",
    );
  });

  test("accepts an explicit database ending in _e2e", () => {
    expect(e2eDatabaseUrl({ E2E_DATABASE_URL: "postgres://u:p@db.local/bgp_t12_e2e" })).toBe(
      "postgres://u:p@db.local/bgp_t12_e2e",
    );
  });

  test.each([
    "postgres://u:p@db.local/bgp",
    "postgres://u:p@db.local/bgp_test",
    "mysql://u:p@db.local/bgp_e2e",
    "postgres://u:p@db.local/bgp_e2e;drop",
  ])("refuses %s", (url) => {
    expect(() => e2eDatabaseUrl({ E2E_DATABASE_URL: url })).toThrow(/_e2e/);
  });
});

describe("performance database", () => {
  test("defaults to bgp_perf on the development database server", () => {
    expect(perfDatabaseUrl({ DATABASE_URL: "postgres://u:p@db.local:15432/bgp" })).toBe(
      "postgres://u:p@db.local:15432/bgp_perf",
    );
  });

  test.each(["postgres://u:p@db.local/bgp", "postgres://u:p@db.local/bgp_e2e"])(
    "refuses %s",
    (url) => {
      expect(() => perfDatabaseUrl({ PERF_DATABASE_URL: url })).toThrow(/_perf/);
    },
  );
});
