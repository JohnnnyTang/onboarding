import type { MatchSummary } from "@bgp/schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, test } from "vitest";
import type { ApiClient } from "../api/client";
import type { AuthService, AuthUser } from "../auth/auth";
import { createClaimedSeats } from "../auth/claimed-seats";
import { GameList, VersionList } from "../pages/games";
import { LobbyStatus, SeatList } from "../pages/lobby";
import { MatchList, matchPath } from "../pages/matches";
import { AppRoutes } from "./app";
import { ServicesProvider } from "./services";

const HASH = "b".repeat(64);
const unused = () => Promise.reject(new Error("not expected in a static render"));
const api: ApiClient = {
  listGames: unused,
  getGame: unused,
  listMatches: unused,
  getMatch: unused,
  claimInvite: unused,
  getVersion: unused,
  getVersionFile: unused,
};

function fakeAuth(user: AuthUser | null): AuthService {
  return {
    current: () => user,
    subscribe: () => () => {},
    accessToken: () => null,
    signIn: async () => {},
    completeSignIn: async () => "/",
    signOut: async () => {},
  };
}

function render(node: ReactNode, path = "/", user: AuthUser | null = null): string {
  return renderToStaticMarkup(
    <ServicesProvider
      value={{ api, auth: fakeAuth(user), seats: createClaimedSeats(), roomUrl: "ws://test/ws" }}
    >
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
      </QueryClientProvider>
    </ServicesProvider>,
  );
}

const DESIGNER = { subject: "s-1", name: "Designer One" };

function summary(status: MatchSummary["status"]): MatchSummary {
  return {
    id: "0190f0c0-0000-7000-8000-00000000abcd",
    status,
    versionId: "v-1",
    buildHash: HASH,
    seats: [
      { seat: "0", name: "Tess", connected: false, guest: true },
      { seat: "1", name: "", connected: false, guest: false },
    ],
  };
}

describe("routes", () => {
  test.each([
    ["/", "Playtest your board games"],
    ["/projects", "No projects yet"],
    ["/join/abc", "Display name"],
    ["/matches/m-1", "You are not seated in this match"],
    ["/matches/m-1/replay", "Replays are not available yet"],
    ["/auth/callback", "Signing in"],
    ["/nowhere", "Page not found"],
  ])("%s renders its page", (path, text) => {
    const html = render(<AppRoutes />, path);
    expect(html).toContain(text);
    expect(html).toContain('aria-label="Main"');
  });

  test.each([
    ["/games", "Sign in to see your games"],
    ["/games/g-1", "Sign in to see your games"],
    ["/matches", "Sign in to see your matches"],
    ["/matches/m-1/lobby", "You are not seated in this match"],
  ])("%s asks a signed-out visitor to sign in", (path, text) => {
    expect(render(<AppRoutes />, path)).toContain(text);
  });

  test("a signed-in designer sees their name and the games page loads", () => {
    const html = render(<AppRoutes />, "/games", DESIGNER);
    expect(html).toContain("Designer One");
    expect(html).toContain("Sign out");
    expect(html).toContain("Loading");
    expect(html).not.toContain("Sign in to see");
  });

  test("the join page offers the designer's name when signed in", () => {
    expect(render(<AppRoutes />, "/join/abc", DESIGNER)).toContain('value="Designer One"');
  });
});

describe("empty states and lists", () => {
  test("games", () => {
    expect(render(<GameList games={[]} />)).toContain("No games yet");
    const html = render(
      <GameList
        games={[{ id: "g/1", slug: "fish", name: "Fish Market", visibility: "private" }]}
      />,
    );
    expect(html).toContain('href="/games/g%2F1"');
    expect(html).toContain("Fish Market");
    expect(render(<VersionList versions={[]} />)).toContain("No versions yet");
  });

  test("matches link to the page for their status", () => {
    expect(render(<MatchList matches={[]} />)).toContain("No matches yet");
    const html = render(<MatchList matches={[summary("lobby")]} />);
    expect(html).toContain("1 of 2 seats filled");
    expect(html).toContain(`href="/matches/${summary("lobby").id}/lobby"`);
    expect(matchPath({ id: "m", status: "active" })).toBe("/matches/m");
    expect(matchPath({ id: "m", status: "finished" })).toBe("/matches/m/replay");
    expect(matchPath({ id: "m", status: "abandoned" })).toBe("/matches/m/lobby");
  });

  test("lobby seats mark the open seat and the viewer's seat", () => {
    const html = render(<SeatList seats={summary("lobby").seats} mySeat="0" />);
    expect(html).toContain("Seat 1</strong> Tess (you)");
    expect(html).toContain("Seat 2</strong> <span");
    expect(html).toContain("Open");
    expect(html).toContain("Guest");
    expect(render(<LobbyStatus match={summary("lobby")} />)).toContain("Waiting for the host");
    expect(render(<LobbyStatus match={summary("active")} />)).toContain("Go to the table");
  });
});
