import type { MatchSummary } from "@bgp/schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, test } from "vitest";
import type { ApiClient } from "../api/client";
import type { AuthService, AuthUser } from "../auth/auth";
import { createClaimedSeats } from "../auth/claimed-seats";
import { createInviteStore } from "../match/match-invites";
import { GameList, VersionList } from "../pages/games";
import { LobbyStatus, SeatList } from "../pages/lobby";
import { MatchList, matchPath } from "../pages/matches";
import { ProjectListView } from "../pages/projects";
import { HashCheckNotice, stepCaption } from "../pages/replay";
import { createProject } from "../projects/project-model";
import { fakeApi } from "../test/fake-api";
import { AppRoutes } from "./app";
import { ServicesProvider } from "./services";

const HASH = "b".repeat(64);
const unused = () => Promise.reject(new Error("not expected in a static render"));
const api: ApiClient = fakeApi();

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
      value={{
        api,
        auth: fakeAuth(user),
        seats: createClaimedSeats(),
        invites: createInviteStore(),
        roomUrl: "ws://test/ws",
        projects: unused,
      }}
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
    ["/projects", "Opening projects"],
    ["/projects/p-1", "Opening the project"],
    ["/projects/p-1/play", "Opening the project"],
    ["/join/abc", "Display name"],
    ["/matches/m-1", "You are not seated in this match"],
    ["/matches/m-1/replay", "You are not in this match"],
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
  test("projects", () => {
    const empty = render(
      <ProjectListView list={{ projects: [], unreadable: 0 }} onDelete={() => {}} />,
    );
    expect(empty).toContain("No projects yet");
    expect(empty).not.toContain("could not be read");
    const project = createProject(
      "Fish Market",
      "0192f3a4-5b6c-7d8e-9f01-23456789aaaa",
      "2026-11-04T10:00:00.000Z",
    );
    const html = render(
      <ProjectListView list={{ projects: [project], unreadable: 2 }} onDelete={() => {}} />,
    );
    expect(html).toContain("2 saved projects could not be read");
    expect(html).toContain(`href="/projects/${project.id}"`);
    expect(html).toContain(`href="/projects/${project.id}/play"`);
    expect(html).toContain("2–4 players");
  });

  test("games", () => {
    expect(render(<GameList games={[]} />)).toContain("No games yet");
    const html = render(
      <GameList
        games={[{ id: "g/1", slug: "fish", name: "Fish Market", visibility: "private" }]}
      />,
    );
    expect(html).toContain('href="/games/g%2F1"');
    expect(html).toContain("Fish Market");
    expect(render(<VersionList gameId="g1" versions={[]} />)).toContain("No versions yet");
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

describe("replay page parts", () => {
  test("the hash check says whether the replayed final state matches the server's", () => {
    const here = "c".repeat(64);
    expect(render(<HashCheckNotice check={{ status: "pending" }} />)).toBe("");
    const match = render(<HashCheckNotice check={{ status: "match", hash: here }} />);
    expect(match).toContain("matches the server");
    expect(match).toContain("cccccccccccc…");
    const mismatch = render(
      <HashCheckNotice check={{ status: "mismatch", hash: here, expected: HASH }} />,
    );
    expect(mismatch).toContain('role="alert"');
    expect(mismatch).toContain("bbbbbbbbbbbb… on the server");
    expect(render(<HashCheckNotice check={{ status: "unavailable" }} />)).toContain(
      "could not be checked",
    );
  });

  test("each step names the move that led to it", () => {
    const replay = {
      buildHash: HASH,
      seats: ["0", "1"],
      seed: 1,
      options: {},
      events: [{ seq: 1, seat: "0", intent: { move: "restock" } }],
      finalHash: HASH,
    };
    const seats = summary("finished").seats;
    expect(stepCaption(replay, 0, seats)).toBe("Setup");
    expect(stepCaption(replay, 1, seats)).toBe("Seat 1 · Tess: restock");
    const manual = {
      ...replay,
      events: [{ seq: 1, seat: "1", intent: { move: "manual", args: { op: "endGame" } } }],
    };
    expect(stepCaption(manual, 1, seats)).toBe("Seat 2: endGame");
  });
});
