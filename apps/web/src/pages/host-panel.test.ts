import type { MatchSummary } from "@bgp/schema";
import { describe, expect, test } from "vitest";
import { canStart } from "./host-panel";
import { defaultOptions } from "./version";

const seat = (n: number, name: string) => ({
  seat: String(n),
  name,
  connected: false,
  guest: name !== "" && name !== "Host",
});

function match(names: string[], status: MatchSummary["status"] = "lobby"): MatchSummary {
  return {
    id: "m1",
    status,
    versionId: "v1",
    buildHash: "a".repeat(64),
    seats: names.map((name, n) => seat(n, name)),
  };
}

describe("starting a match", () => {
  test("needs the first players.min seats taken, as the server does", () => {
    expect(canStart(match(["Host", "Tess", ""]), 2)).toBe(true);
    expect(canStart(match(["Host", "", "Uma"]), 2)).toBe(false);
    expect(canStart(match(["", "", ""]), 1)).toBe(false);
    expect(canStart(match(["Host"]), 2)).toBe(false);
    expect(canStart(match(["Host", "Tess"], "active"), 2)).toBe(false);
  });
});

describe("match options", () => {
  test("start from the declared defaults", () => {
    expect(
      defaultOptions({
        schemaVersion: 1,
        id: "a-game",
        name: "A",
        version: "1.0.0",
        mode: "sandbox",
        sdk: 1,
        players: { min: 1, max: 2 },
        components: "components.json",
        options: [
          { id: "short", label: "Short", type: "boolean", default: true },
          { id: "rounds", label: "Rounds", type: "integer", default: 3, min: 1, max: 5 },
        ],
      }),
    ).toEqual({ short: true, rounds: 3 });
  });
});
