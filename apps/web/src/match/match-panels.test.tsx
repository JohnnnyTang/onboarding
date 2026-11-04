import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  ActionBar,
  ConnectionBanner,
  Hud,
  playerName,
  RejectedNotice,
  ResultPanel,
  roomErrorMessage,
} from "./match-panels";

const SEATS = [
  { seat: "0", name: "Tess", connected: true, guest: true },
  { seat: "1", name: "Uma", connected: false, guest: true },
  { seat: "2", name: "", connected: false, guest: false },
];

describe("match panels", () => {
  test("names players by seat and display name", () => {
    expect(playerName("0", SEATS)).toBe("Seat 1 · Tess");
    expect(playerName("2", SEATS)).toBe("Seat 3");
  });

  test("the HUD marks the active seat, this seat and absent players", () => {
    const html = renderToStaticMarkup(
      <Hud
        entries={[
          { seat: "0", score: 4, handCount: 5, active: false },
          { seat: "1", score: 7, active: true },
        ]}
        seats={SEATS}
        mySeat="0"
      />,
    );
    expect(html).toContain("Seat 1 · Tess</strong> (you)");
    expect(html).toContain("Score 4");
    expect(html).toContain("Hand 5");
    expect(html).toMatch(/Seat 2 · Uma<\/strong><span[^>]*> · to play<\/span><span[^>]*> · away/);
  });

  test("action buttons are disabled when the game says so or a move is pending", () => {
    const actions = [
      { id: "ship", label: "Ship selected", enabled: false },
      { id: "restock", label: "Restock", enabled: true, intent: { move: "restock" } },
    ];
    const idle = renderToStaticMarkup(
      <ActionBar actions={actions} disabled={false} onAction={() => {}} />,
    );
    expect(idle).toMatch(/<button[^>]*disabled=""[^>]*>Ship selected/);
    expect(idle).not.toMatch(/<button[^>]*disabled=""[^>]*>Restock/);
    const pending = renderToStaticMarkup(
      <ActionBar actions={actions} disabled onAction={() => {}} />,
    );
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>Restock/);
  });

  test("a rejected move shows the game's message as an alert", () => {
    const html = renderToStaticMarkup(
      <RejectedNotice
        rejection={{
          id: 1,
          code: "INVALID_MOVE",
          gameCode: "PASS_NOT_ALLOWED",
          message: "Another move is available.",
        }}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Another move is available.");
  });

  test("the result lists winners and scores, best first", () => {
    const html = renderToStaticMarkup(
      <ResultPanel
        result={{ winners: ["1"], scores: { "0": 9, "1": 12 }, reason: "The deck is empty." }}
        seats={SEATS}
        mySeat="0"
      />,
    );
    expect(html).toContain("Game over");
    expect(html).toContain("Winner: Seat 2 · Uma");
    expect(html).toContain("The deck is empty.");
    expect(html.indexOf("Seat 2 · Uma</th>")).toBeLessThan(html.indexOf("Seat 1 · Tess (you)"));
    const won = renderToStaticMarkup(
      <ResultPanel result={{ winners: ["0", "1"] }} seats={SEATS} mySeat="0" />,
    );
    expect(won).toContain("You won!");
    expect(won).toContain("Winners: Seat 1 · Tess, Seat 2 · Uma");
  });

  test("connection and room errors have plain messages", () => {
    expect(renderToStaticMarkup(<ConnectionBanner status="open" />)).toBe("");
    expect(renderToStaticMarkup(<ConnectionBanner status="reconnecting" />)).toContain(
      "Reconnecting",
    );
    expect(roomErrorMessage({ code: "SEAT_TAKEN_OVER", message: "x", fatal: true })).toContain(
      "another tab",
    );
    expect(roomErrorMessage({ code: "RATE_LIMITED", message: "Slow down", fatal: false })).toBe(
      "Slow down",
    );
  });
});
